# lesson13-production · 生产级落地（把 Agent 推上线前的四件套）

**一句话定位**：新增 5 个文件 493 行，把「分类重试 + 三态熔断 / SSE 流式 / 观测 / 评测」挂在 LLM 函数的外层——本体 4 个文件只小改，第 13 章到此收官。

前 12 章把这个 Agent 从「能跑」做到了「功能完整」：工具、上下文、记忆、委派、技能、插件、MCP、多会话、IM 网关、定时任务。拿它去服务真实业务，第一个晚上会撞上三类事——供应商 429 限流时用户消息石沉大海；月底账单出来才知道这个月花了多少钱；改完 prompt 没人说得清「有没有把原来好的改坏」。这一章不新增能力，只补「扛得住、看得见、量得出」。

## 学完这一章，你应该能做到

- 说清重试的三个前提——分类（429/5xx 重试，400/401 不重试）、退避（指数 + jitter 防惊群）、熔断（连续失败就短路）——并手写熔断器的 closed / open / half_open 三态
- 用零依赖的 `fetch` + `getReader()` 解析 SSE（「chunk 边界 ≠ 行边界」「多字节字符跨块」两个坑），并解释同签名为什么让 `agent.js` 零改动
- 分清审计（该不该发生）与观测（发生得怎么样），说清 token 估算与成本口径
- 设计三种评测断言（`expectIncludes` / `expectTools` / `expectNotTools`），并说清每例为什么必须 `agent.reset()`
- 指着 `llm_chain.js` 讲清 `traced(withRetry(base))` 的分层，以及 `/stats` 为什么要把熔断状态一起打出来

## 前置要求

- Node ≥ 18（本章用内置 `node:test`、内置 `fetch`、`ReadableStream`，零第三方依赖）
- **跑测试不需要任何 API key**；只有真实对话（`node main.js`）才需要模型服务
- 推荐先读完第 12 章：本章的 Agent 是在第 12 章代码上叠加的，`cron/`、`gateway/`、`mcp/`、`tools/`、`skills/` 等 43 个文件原样带过来

## 快速开始

### 1. 先跑测试（第一步，不需要配置）

```bash
cd lesson13-production
npm test
```

期望输出：17 个用例全绿，半秒左右。测试全程离线——假 LLM、假 SSE 流、注入时钟，不联网也不花 token。

### 2. 真实跑一次（需要 OpenAI 兼容端点）

在章节目录下建 `env.json`（不要提交进 git）：

```json
{
  "OPENAI_API_KEY": "你的key",
  "OPENAI_BASE_URL": "https://你的推理服务/v1",
  "OPENAI_MODEL": "qwen38-27b"
}
```

```bash
node main.js
```

启动输出（本机实跑抓取；第二行是 `env.json` 里 QQ 凭证失效时的降级路径，终端通道照常可用）：

```text
[gateway] 使用 appid+secret 换取 access_token...
[gateway] QQ 接入失败，仅启用终端通道：获取 access_token 失败: {"code":100016,"message":"invalid appid or secret"}
[prod] LLM 调用链：流式 + 重试(3) + 熔断 + 观测
[prod] /stats 查看观测 | /eval 跑评测 | 终端回复打字机效果
[bridge] 通道已接入（LLM: qwen38-27b）
[terminal] 终端通道已启动（输入 /help 查看命令；/exit 退出）
```

进 REPL 后能试的东西：

```text
随便问一句        → 回复逐字打出（打字机 ~60 字/秒）
/stats            → 观测汇总：调用次数 / token / 估算成本 / 平均耗时 / 错误率 / 熔断状态
/eval             → 对真实模型跑 4 个评测用例，输出通过率
/sessions /new /use <id> /delete <id>   → 多会话（第 10 章能力）
"每天早上 9 点生成日报"                  → 自然语言设定时任务（第 12 章能力）
```

## 文件地图

本节只列新增与改动的文件；其余 43 个 `.js` 与第 12 章逐字节相同——其中 `subagent.js`、`cron/cron_scheduler.js` 是本章把滞后拷贝同步回第 12 章状态的两个文件（见下表）。

```text
lesson13-production/
├── llm_retry.js        132 行  ★ 错误分类（LlmError/isRetryable）+ withRetry 指数退避 + CircuitBreaker 三态
├── streaming.js        102 行  ★ SSE 流式：getReader 读流 + 按行解析，签名兼容 call_llm
├── telemetry.js         94 行  ★ 观测：llmCall / toolCall / estimateCost / summary
├── evaluate.js          96 行  ★ 评测：4 个用例 + expectIncludes/expectTools/expectNotTools
├── llm_chain.js         69 行  ★ 装配：traced(withRetry(base))，返回 { llm, breaker }
├── llm.js               73 行  改：非 2xx 与超时改抛 LlmError（带可重试性）
├── agent.js            214 行  改：Loop 判定后同轮剩余 tool_calls 逐条回填
├── main.js             248 行  改：装配调用链 + 打字机 + /stats /eval；QQ 凭证失效降级到终端
├── test.js             426 行  改：17 个用例（新增 3 个为本章修复的回归）
├── subagent.js         161 行  同步：Loop 分支补上同款回填（与第 12 章逐字节一致）
├── cron/cron_scheduler.js 198 行 同步：同名任务覆盖前先回收旧 timer
├── package.json                改：name / description
└── docs/
    ├── course.md               教程：为什么要生产化 / 逐文件讲代码 / 实跑输出 / 收官
    └── interview.md            10 题三层：考点 / 答题结构 / 话术 / 代码锚点 / 追问
```

**推荐阅读顺序**：`llm_retry.js`（错误即数据）→ `streaming.js`（流式）→ `telemetry.js`（观测）→ `evaluate.js`（评测）→ `llm_chain.js`（装配）→ `main.js`（怎么接进第 13 章的装配线）→ `test.js`。

## 本章增量（相对第 12 章）

| 位置 | 改了什么 |
|---|---|
| 新增 `llm_retry.js` / `streaming.js` / `telemetry.js` / `evaluate.js` / `llm_chain.js` | 493 行，四个生产能力 + 一条装配链 |
| `llm.js` | HTTP 非 2xx 由 `throw new Error` 改为 `throw errorFromStatus(...)`；超时改抛 `LlmError{retryable:true}`——上层才判断得出可重试性 |
| `main.js` | 装配 `createStreamingLlm` + `createLlmChain`；打字机逐字队列；`/stats` `/eval` 两条命令；QQ 接入包 try/catch |
| `agent.js` | `LOOP_DETECTED` 分支由 `break` 改为 `continue` + `loopDetected` 标志（见「常见问题」第一条） |
| `subagent.js` | 子 Agent 的 Loop 分支是同款 `break`，一并改掉，改完与第 12 章逐字节一致 |
| `cron/cron_scheduler.js` | 同名任务覆盖前先 `remove(name)` 回收旧 timer，改完与第 12 章逐字节一致 |
| `test.js` | 改写成 17 个用例：第 12 章的能力用例由它自身的 25 个用例保证 |
| `package.json` | name / description 改为 lesson13-production |

Agent 本体（`agent.js` 的循环结构、工具调度、权限、上下文压缩、记忆、委派、技能、MCP、Hooks）一行没动：四个生产能力全部挂在 LLM 函数的**外层**，装配处只换了 `llm` 一个字段。

## 本课刻意不做的事（调用层已做 vs 系统层还欠）

| 已做（调用层） | 还欠（系统层） | 生产解法 |
|---|---|---|
| 错误分类、指数退避、三态熔断、超时 | 流式重试无断点续传（现在整段重来） | 按已收到内容续写，或降级为非流式 |
| token 估算 + 价格表 + `/stats` | 无配额与限流 | 按用户/租户配额，超限降级小模型 |
| 4 用例评测 + 通过率 | 无基线对比、无 CI 卡口、用例太少 | 评测集入库 + 回归门禁 |
| 内存事件 + `summary()` | 不落盘、无上报、无告警 | OpenTelemetry + 看板 + 成本告警 |
| 单进程、单 Agent 实例 | 多实例、多租户、灰度、回滚 | 多副本 + 分布式锁 + 灰度发布 |
| 单模型直连 | **无模型回落** | 主模型熔断后换备用模型（换一个 `base` 再包一层即可） |
| 权限分级 + 审批流 + 审计 | 多租户隔离、数据脱敏、合规留存 | 租户级 key 与数据分区、PII 脱敏 |

四个刻意的缺口写进了测试或用例注记（不实现，只钉住行为）：流式只会整段重试、没有模型回落、单实例、`/eval` 依赖真实模型调用。面试被问「离生产还差什么」，这张表就是答案骨架。

## 测试覆盖（17 个用例，全部可离线跑）

| 用例 | 行号 | 验证什么 |
|---|---|---|
| isRetryable：错误分类 | `test.js:60` | LlmError 按自带标记、TypeError 视为网络故障、普通 Error 不重试 |
| errorFromStatus：状态码 → 可重试性 | `test.js:67` | 500/429 可重试，400/401 不可 |
| withRetry：退避重试后成功 | `test.js:74` | 失败 2 次后成功，`calls=3`、`onRetry` 收到 `[0,1]` |
| withRetry：不可重试错误立即抛 | `test.js:94` | `calls=1`、0 次重试 |
| CircuitBreaker：三态转换 | `test.js:112` | 连续失败 → open 拒绝 → 冷却后 half_open → 成功回 closed |
| withRetry + breaker：熔断后拒绝调用 | `test.js:134` | 第二轮不发请求，错误文案为「熔断器已短路」 |
| createStreamingLlm：SSE 逐 token | `test.js:157` | `deltas=["你","好"]`、`content="你好"` |
| createStreamingLlm：流式超时 | `test.js:181` | 抛「超时」且 `retryable=true` |
| Telemetry：summary 统计 | `test.js:203` | 2 次调用 1 次失败 → 成本 0.004 元、平均耗时 250ms、错误率 0.5 |
| createLlmChain：重试 + 观测 | `test.js:224` | 内部重试 3 次，观测只记 1 次成功调用 + 2 条 retry 事件 |
| TerminalGateway：流式不重复打印 | `test.js:256` | `send` 不提前消费标志，`markTypingDone` 才收尾 |
| TerminalGateway：waitReplyDone | `test.js:270` | 非流式 `send` 立即通知，不等 90 秒超时 |
| bridge attach：onMessageDone | `test.js:277` | 处理完成（即使无回复）也通知，prompt 时机正确 |
| runEvaluation：评测通过率 | `test.js:301` | 按输入分支的假 LLM 跑完 4 个用例，`passRate=1` |
| Loop 判定后同轮剩余 tool_calls 逐条回填 | `test.js:343` | （回归）每个 tool_call 都有对应 tool 消息，无孤儿 |
| 子 Agent：Loop 判定同上 | `test.js:379` | （回归）子 Agent 循环里同样不留孤儿 tool 消息 |
| 同名任务覆盖：旧 timer 被清理 | `test.js:408` | （回归）`clearTimeout` 收到旧任务 timer，`stopAll` 不漏 |

前 3 个回归用例都是「先让它红」验证过的：临时把修复改回去，`test.js:343`、`test.js:379`、`test.js:408` 三个用例分别失败，改回来即全绿。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 模型返回多工具调用时，服务端报 `400 ... must be followed by tool messages` | 本章修的老朋友：Loop 判定后原来用 `break` 跳出同批循环，剩余 `tool_call` 没回填。现在改为逐条回填（`agent.js:149-162`），子 Agent 同款（`subagent.js:142`）。用例 `test.js:343` 钉住 |
| 连续失败后所有请求秒失败，错误写「熔断器已短路」 | 熔断器进了 open（默认连续 5 次失败、冷却 30 秒）。这是设计行为：short-circuit 期间不发请求。等冷却期，或调 `llm_chain.js:29` 的 `failureThreshold` / `cooldownMs` |
| `/stats` 里成本是估算，和账单对不上 | 价格表是教学近似值（`telemetry.js:15`），token 用 `countTokens` 估算（流式响应拿不到 `usage`）。要准就改用 API 返回的 `usage` 字段 |
| 回复不是逐字出的 | 打字机只对终端通道生效（`main.js:97-102` 判断 `currentChannel === TERMINAL_CHANNEL`）；QQ 通道没有 `onDelta`，是整段回复 |
| 重启后 `/stats` 归零 | 观测事件在内存（`telemetry.js:27`），进程退出即丢。生产要落到 OTel/时序库，见「缺口表」 |
| QQ 连不上，终端还能用吗 | 能。`main.js:141-157` 把 QQ 接入包在 try/catch 里，凭证失效只打一行警告并降级到终端通道 |
| `/eval` 跑完提示 `处理失败` | 评测走真实模型调用（`main.js:193`），`env.json` 配错或模型名不存在时用例会记 error。先修配置，再看通过率 |
| 想单独验证某个行为 | `node --test --test-force-exit --test-name-pattern="熔断" test.js`，只跑名字匹配的用例 |

## 文档导航

- **教程**：`docs/course.md` —— 从「能跑」到「敢上线」的差距、逐个文件讲代码、实跑输出与一次带重试的调用链时序、全书收尾
- **面试**：`docs/interview.md` —— 10 题三层（T1 基础 / T2 工程深度 / T3 架构设计），每题带考点、答题结构、参考话术、真实行号锚点与追问