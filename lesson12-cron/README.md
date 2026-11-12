# lesson12-cron · 定时任务（让 Agent 从被动应答到主动服务）

**一句话定位**：新增 3 个文件 365 行（`cron/cron_parser.js` + `cron_scheduler.js` + `cron_tool.js`），给多通道 Agent 装上时钟——`nextRun` 算出下一次触发时刻、睡到点执行、结果推回设置者所在的通道。

前 11 章的消息都来自用户：QQ 消息或终端输入，用户不说话 Agent 就不动。真实办公场景里有一类需求反过来——"每天早上 9 点生成日报""每 5 分钟查一次库存水位"，到点要主动干活、主动推送。这一章加的调度器就是第三条消息来源：时间。

## 学完这一章，你应该能做到

- 写一个 cron 表达式解析器，并说清为什么产物是"每字段一个匹配值集合"而不是正则
- 手推 `nextRun` 的进位过程：分钟不匹配怎么跳、小时不匹配怎么跳、日/月不匹配怎么进位
- 讲清 `setTimeout` 单次延迟 2^31-1 ms 上限为什么会让年度任务当场触发，以及分段 sleep 怎么绕开
- 说清定时任务为什么必须走 `handleSystemMessage` 而不是复用 `handleMessage`
- 跑通 25 个用例并说清每条钉住什么，包括 2 条钉住本章修复的回归用例

## 前置要求

- Node ≥ 18（用内置 `node:test`、内置 `fetch`，零第三方依赖）
- **跑测试不需要任何 API key**；只有真实对话（`node main.js`）才需要模型服务
- 推荐先读完第 11 章：本章的 Agent 是在第 11 章代码上叠加的，44 个文件带过来，只有 `agent.js`、`subagent.js`、`agent_bridge.js`、`main.js`、`test.js` 五个动过（见"本章增量"）

## 快速开始

### 1. 先跑测试（第一步，不需要配置）

```bash
cd lesson12-cron
npm test
```

期望输出：25 个用例全绿，约 600ms。测试用假 LLM 驱动，不联网、不花 token。

### 2. 真实跑一次（需要 OpenAI 兼容端点）

在章节目录下建 `env.json`（不要提交进 git），结构与前面各章一致：

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

启动后终端直接可用（配了 QQ 凭证则 QQ 通道同时在线）。**没有任何预注册任务**，任务是你在对话里说出来的：

```
你> 每天早上9点帮我生成日报
[approval] 需要你的批准：create_cron_job … 回复：1 (批准) / 2 (拒绝) / 3 (始终允许)
你> 1
你> 现在有哪些定时任务？
```

三条命令值得试：`/sessions`、`/new`、`/help`（终端会话管理继承第 10 章）。定时任务本身没有元命令，查看它靠对话触发 `list_cron_jobs` 工具。

## 文件地图

本章只列新增与改动的文件；其余 44 个源文件（工具、上下文、记忆、委派、技能、Hooks、MCP、会话、网关）从第 11 章带过来，其中 39 个零改动。

```
lesson12-cron/
├── cron/
│   ├── cron_parser.js      86 行  ★ 5 字段 cron → 匹配值集合（* / a,b / a-b / */N）
│   ├── cron_scheduler.js  198 行  ★ nextRun 进位计算 + 分段 sleep 的触发循环
│   └── cron_tool.js        81 行  ★ 工具化：create_cron_job（write 级）+ list_cron_jobs（read 级）
├── agent_bridge.js        139 行  ★ 新增 handleSystemMessage 独立入口
├── agent.js               208 行  ★ 死循环判定后逐条回填（本章修）
├── subagent.js            161 行  ★ 同一处修复同步到子 Agent
├── main.js                172 行  装配：装配调度器 + 注册两个 cron 工具
├── test.js                554 行  25 个用例（mock LLM，无需 key）
├── package.json                 name / description 改名；test 脚本带 --test-force-exit
└── docs/
    ├── course.md                教程：为什么需要时钟 / 逐文件讲代码 / 真实输出 / 下一章
    └── interview.md             10 题三层：考点 / 答题结构 / 话术 / 代码锚点 / 追问
```

**推荐阅读顺序**：`cron/cron_parser.js`（时间怎么变成数据）→ `cron/cron_scheduler.js`（`nextRun` 是灵魂）→ `cron/cron_tool.js`（怎么交到模型手里）→ `agent_bridge.js:72-80`（系统消息入口）→ `main.js:109-124`（装配）→ `test.js`。

## 本章增量（相对第 11 章）

| 位置 | 改了什么 |
|---|---|
| 新增 `cron/cron_parser.js` / `cron_scheduler.js` / `cron_tool.js` | 365 行，从表达式到触发到工具化的整条链路 |
| `agent_bridge.js` | 新增 `handleSystemMessage`（`agent_bridge.js:72-80`）、`_process` 加 `system` 形参（`agent_bridge.js:106`） |
| `main.js` | 装配 `CronScheduler`（`main.js:109`）、以 write 级注册 `create_cron_job`（`main.js:113-120`）、以 read 级注册 `list_cron_jobs`（`main.js:121`）；SYSTEM_PROMPT 里补上"定时任务"能力声明 |
| `agent.js` / `subagent.js` | 死循环判定的回填补上 `continue`（`agent.js:155`、`subagent.js:142`），同批剩余 `tool_call` 不再丢回填 |
| `test.js` | 改写成 25 个用例：QQ 事件解析用例留在第 11 章，本章补 `nextRun` 兜底、孤儿 `tool_call` 回归、同名任务句柄回归 |
| `package.json` | name / description 改名；test 脚本保留 `--test-force-exit` |
| 未带过来 | 第 11 章的 `verify_qq.js`（当时的排查脚本）没有复制到本章 |

Agent 主循环、工具调度、权限、压缩、记忆、委派这些机制一行逻辑都没改——定时任务对 Agent 来说是"又一条消息进来了"，接入点是 `main.js` 的装配和三处工具注册。

## 本课刻意不做的事（缺口 = 后续课程路线图）

| 缺口 | 后果 | 在哪一章补 |
|---|---|---|
| 任务不持久化 | 进程重启，用户设的任务全丢 | 第 13 章之后的部署环节；数据模型用第 10 章的原子写现成 |
| 错过不补偿 | 进程睡了 3 小时，期间的日报不补跑 | 需要的是策略层（学 anacron：错过且未过窗口才补），不是调度器本身 |
| 无进程守护 | 进程挂了 = 定时服务消失 | systemd / PM2 拉起 + 开机重载任务 |
| 多实例重复触发 | 部署 3 副本，日报发 3 遍 | 分布式锁或调度独立成单点服务 |
| 日 / 周字段用 AND（标准 cron 是 OR） | `0 9 13 * 5` 只能表达"13 号且恰好周五" | 有意保留的简化，标准语义改一行判断即可（`cron_scheduler.js:35-36`） |
| 最小粒度是分钟 | "每 10 秒"只能用 `scheduleInterval` | 标准 cron 本来就无秒；要秒级得扩展 6 字段格式 |
| NL → cron 没有评测集 | 翻译"每月最后一个工作日"可能翻错，只能靠工具报错纠正 | 第 13 章的评测三型用例正好可以承接 |
| `main.js:12` 注释宣称有 `/cron` 元命令，实现里没有 | 注释与实现不符，不影响主流程（对话查任务走 `list_cron_jobs`） | 有意保留：本章不动 `main.js` 逻辑。要补就在 `main.js:161` 后加一个 `terminal.onCommand("/cron", …)` 打印 `cron.list()`，5 行 |
| 任务与用户消息共享同一个串行队列 | 定时任务恰好撞上正在处理的用户消息要排队；长任务会拖住对方 | 单 Agent 实例的并发保护（第 11 章设计），要并行得给 Agent 池 |
| 同名任务靠 name 覆盖，没有任务 id | 用户两次说同一句话，后一个覆盖前一个（旧 timer 已在本章清理，见"常见问题"） | 生产要给任务一个独立 id 与 owner 字段 |

面试话术的收口：**课程版证明了链路正确（25 用例），生产版要补的是持久化、补偿、守护、去重四件套——数据模型和工程手段都是成熟的，难的是把它们和 Agent 的会话、记忆、审批整合成产品。**

## 测试覆盖（25 个用例，全部离线）

| 用例 | 行号 | 验证什么 |
|---|---|---|
| parseCron：基础字段展开 | `test.js:53` | `0 9 * * *` → minute `[0]`、hour `[9]`、day 31 个值、month 12 个、weekday 7 个 |
| parseCron：步进 / 列举 / 范围 | `test.js:62` | `*/15`、`1,15`、`1-5` 三种写法展开正确 |
| parseCron：非法表达式抛错 | `test.js:68` | 4 字段与空串都抛 `/5 字段/` |
| nextRun：当天未到 → 当天触发 | `test.js:75` | `30 14 * * *` 从 10:00 出发落在当天 14:30 |
| nextRun：当天已过 → 次日触发 | `test.js:86` | `0 9 * * *` 从 10:00 出发滚到次日 9:00 |
| nextRun：跨月进位（每月1日） | `test.js:94` | `0 9 1 * *` 从 8/25 落在 9 月 1 日 |
| nextRun：步进分钟对齐 | `test.js:102` | `*/15` 从 10:07 落在 10:15 |
| nextRun：结果必须匹配 spec | `test.js:109` | 性质测试：结果过 `matches()` 且严格大于起点 |
| CronScheduler：scheduleInterval 自动触发 | `test.js:120` | 20ms 间隔任务在 60ms 内至少触发一次 |
| CronScheduler：fire + list + remove | `test.js:131` | 手动触发计数、list 字段、remove 后列表为空 |
| 年度任务：24.8 天溢出 → 分段 sleep | `test.js:149` | （钉住坑）注册 `0 0 1 1 *` 后 50ms 内 `fired === 0` |
| ApprovalFlow：数字选项 1/2/3 映射 | `test.js:166` | 1=批准一次、2=拒绝、3=始终允许（与确认文案一致） |
| create_cron_job 工具：注册定时任务 | `test.js:193` | 返回 `nextRun`、list 里出现该任务 |
| create_cron_job：非法表达式返回错误 | `test.js:222` | 抛 `/5 字段/` **且** 未注册任何任务（不留半成品） |
| list_cron_jobs 工具：查看已注册任务 | `test.js:233` | 名称、表达式、`runs === 0` |
| TerminalGateway：命令分发 | `test.js:252` | `/` 开头命中 handler 不 emit；未知命令不崩；空行消费 |
| TerminalGateway：send 后刷新 prompt | `test.js:278` | 回复后重新显示输入提示；未 connect 时不崩 |
| Bridge 会话管理：list/switch/delete | `test.js:297` | 双通道各建一个会话，切换不新建、删除后映射清除 |
| call_llm：超时抛可识别错误 | `test.js:329` | `timeoutMs: 50` 时抛 `/超时/`，不无限挂起 |
| LLM 失败不退出 | `test.js:343` | LLM 抛错时用户收到"处理失败…请稍后重试"，进程存活 |
| 集成：cron 触发 → 系统消息 → 执行 → 推送 | `test.js:369` | 走完整链路，断言推送文本 |
| 集成：系统消息不被误判为审批回复 | `test.js:413` | 有 pending 审批时任务照常执行，`waitingCount` 仍为 1 |
| nextRun：永不匹配（2月30日）→ null | `test.js:462` | （本章补齐）扫描上限后返回 `null`，不空转 |
| 死循环判定后：同批 tool_call 全部回填 | `test.js:468` | （本章修复）一轮 5 个同签名调用，5 条 `tool_call_id` 都拿到回填，只有前 2 条真的执行 |
| 同名任务覆盖：旧 timer 被清理 | `test.js:536` | （本章修复）同名注册两次，旧句柄进过 `clearTimeout`，`stopAll` 不会漏 |

用例按课分工：本章 25 条覆盖 cron 增量与前课桥接回归（命令分发、prompt 刷新、会话管理、保活）。第 11 章的 QQ 事件解析用例留在 `lesson11-gateway/test.js`，靠同源文件未改动背书，本章不重复。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `npm test` 全绿但进程永不退出 | 测试里创建的定时任务留下 pending timer，`node:test` runner 默认等事件循环清空。**每个创建过任务的测试末尾调 `cron.stopAll()`**（`test.js:163`、`test.js:219`、`test.js:230`、`test.js:247`），`package.json` 的 `--test-force-exit` 是第二道兜底 |
| 年度任务刚注册就触发了 | `setTimeout` 的 delay 是 32 位有符号整数，超过 2^31-1 ms（24.86 天）按 Node 文档行为会立即执行。分段 sleep 已处理（`cron_scheduler.js:187-190`），行为由 `test.js:149` 钉住 |
| 定时任务文本把用户的审批"吃掉"了 | 这类消息必须走 `bridge.handleSystemMessage`，它跳过审批消费；走 `handleMessage` 会被 `approval.handleReply` 按"未识别输入=拒绝"消费（`agent_bridge.js:64-66` 是那个消费点） |
| 同名任务注册两次，旧任务还在跑 | 本章已修：`schedule` / `scheduleInterval` 先 `remove(name)` 清旧 timer（`cron_scheduler.js:112`、`cron_scheduler.js:121`），回归用例 `test.js:536` |
| 表达式非法，模型却反复重试同一句 | 工具把 `parseCron` 的抛错原样回给模型（`cron_tool.js:43-44`），registry 转成结构化错误。模型看到"必须是 5 字段"通常自己改对；一直改不对说明描述里的示例不够，看 `cron_tool.js:29-32` |
| 任务注册成功但一直不触发 | 先看启动日志有没有"在 5 年内无触发时间，已跳过"（`cron_scheduler.js:182`）——那种表达式永远不会到点，比如 2 月 30 日 |
| 日/周字段和直觉不一致 | 本课日与周是 AND（`cron_scheduler.js:35-36`），标准 cron 是 OR；`0 9 13 * 5` 只在"13 号且周五"触发 |
| 到点跑任务时报 `处理失败：LLM 调用超时` | `llm.js` 默认 60s 超时（`llm.js:38-44`）；定时任务走同一次 Agent 调用，超时后错误被 `_process` 抛给调用方，任务本身不重试 |
| 没配 QQ 凭证，启动后没有任何通道提示 | `main.js:84` 的 QQ 分支只在有凭证时进入，无凭证时静默跳过（第 11 章那句"未配置 QQ_SECRET"提示在本章被删掉了），终端通道照常启动，定时任务不受影响 |
| `main.js:12` 注释里的 `/cron` 命令无效 | 注释与实现不符（见缺口表），用对话"现在有哪些定时任务？"代替 |

## 文档导航

- **教程**：`docs/course.md` —— 为什么需要时钟、cron 解析与 `nextRun` 进位、分段 sleep、系统消息入口、真实运行输出与一次完整往返的时序图
- **面试**：`docs/interview.md` —— 10 题三层（T1 基础 / T2 工程深度 / T3 架构设计），每题带考点、答题结构、话术、真实行号锚点与追问