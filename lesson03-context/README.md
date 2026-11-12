# lesson03-context · 上下文管理（合并版）

**一句话定位**：14 个源文件、1105 行、零第三方依赖——在第 2 章工具系统之上加一层上下文预算（数 token → 截断 → 摘要压缩 → 三层结构 + 水位线），把工具系统、防失控、上下文管理三套能力装进同一个主循环。

第 2 章的 Agent 有一个必然代价：`messages` 只增不减，而一条工具结果的尖峰可能是 839 KB（本课 `search_logs` 的实测值）。这一章把"往数组里塞"换成"预算管理"，也顺手把前两章的能力收进一个完整形态的 Agent。

## 学完这一章，你应该能做到

- 说清上下文为什么会爆，以及"增长尖峰来自工具结果"这条为什么是 Agent 独有的；讲透截断与压缩的区别（取舍依据、成本、风险）以及生产为什么用组合而不是二选一
- 背出三层结构 system / summary / recent 与水位线公式，解释 `reserveForOutput` 不预留会怎样
- 亲手跑通 20 个用例（**不需要 API key**），说清每个用例在钉住什么行为
- 认出全章最容易踩的协议坑：`tool` 消息必须与 `assistant(tool_calls)` 成对，切分或提前终止时漏一个 id 就是 API 400

## 前置要求

- Node ≥ 18（本课用内置 `fetch`，这就是"零依赖"的来源）
- 先读过第 2 章：`registry.js` / `registry_full.js` / `validation.js` / `errors.js` / `permissions.js` 这 5 个文件继承自第 2 章，本课不重讲；其中 3 个文件与第 2 章有细微差异（第 2 章后续的小修没回补），见缺口表最后一行
- 跑测试不需要任何 API key，只有 `node main.js` 需要 OpenAI 兼容端点

## 快速开始

### 先跑测试

```bash
cd lesson03-context
npm test
```

期望输出：20 个用例全绿，约 45ms。`npm test` 展开是 `node --test test.js test-context.js`（package.json:8）——两个文件显式列出，不依赖自动发现规则。测试全程不联网：LLM 是构造函数注入的脚本化函数。

### 真实跑一次

`env.json` 放在本课目录（不进 git）：

```json
{"OPENAI_API_KEY":"你的key","OPENAI_BASE_URL":"http://你的推理服务/v1","OPENAI_MODEL":"qwen38-27b"}
```

```bash
node main.js
```

main.js 交给 Agent 的任务会一次走完三条路径：查北京天气（read 直放）、搜索日志关键词 timeout（结果 839 KB，必须截断）、保存笔记（write 级，要你在终端回 `y` / `a` / `n`）。跑完打印 `[agent]` 结果、`[notes]` 落库内容与 `[budget]` 账本。

下面这段是把 LLM 换成脚本化替身跑出来的真实输出（Agent、registry、cm 都是本课真代码，字段结构与接真实端点一致）：

```
  [tool] get_weather({"city":"北京"}) -> {"result":{"city":"北京","weather":"晴 25°C"}}...
  [tool] search_logs({"keyword":"timeout"}) -> {"result":"[2026-07-28] INFO request handled keyword=timeout trace_id=0.16047720...
  [confirm] write_note({"title":"例会","content":"周三下午三点"}) -> true
  [tool] write_note({"title":"例会","content":"周三下午三点"}) -> {"result":"已保存笔记: 例会"}...
[agent] 已查北京天气（晴 25°C）、检索到日志、并保存笔记「例会」。
[notes] [["例会","周三下午三点"]]
[budget] {"maxTokens":4096,"reservedForOutput":512,"compactThreshold":2867,"used":{"system":28,"summary":0,"recent":1245,"total":1273}}
```

三条 tool 消息的字符数是 43、4025、22：中间的 search_logs 工具返回 858901 字符（包成结果 JSON 后 868901 字符），被 `truncateToolResult` 切成 4025 字符（含"已截断"标记）。`used.total` 1273 没到水位线 2867，所以这一次没有压缩——想让压缩在这次演示里出现，把 main.js:30 的 `maxTokens` 调到 400 左右即可。

## 文件地图

```
lesson03-context/
├── 上下文管理（本章新增）
│   ├── token_counter.js      57 行   v1 token 估算：CJK 1 字 1 token、其余 4 字符 1 token
│   ├── sliding_window.js     44 行   v2 滑动窗口：故意留的失败版本 + isSystemPreserved 负向探针
│   ├── context_manager.js    73 行   v3 分层截断：system 与最后 user 永保，中间从新到旧填预算
│   ├── summary_compactor.js  63 行   v4 LLM 摘要：保留清单 prompt + summarize + compact
│   └── context_manager_v2.js 144 行  v5 三层结构 + 水位线 + 递归压缩 + 工具结果截断（★ 上下文侧核心）
├── 主循环
│   └── agent.js             129 行   v6 三套能力合体（★ 全章考点集中地）
├── 工具系统（继承第 2 章，本课不改；3 个文件与第 2 章各差一处）
│   ├── registry.js           72 行   注册表 v1：工具定义对象 + getSchemas
│   ├── registry_full.js      86 行   完整流水线：查找 → 解析 → 权限 → 校验 → 执行 → 结构化错误
│   ├── validation.js         89 行   参数校验 + 类型宽容转换（"3" → 3）
│   ├── errors.js             70 行   错误码 + ToolError + toResult
│   └── permissions.js        72 行   权限分级 read/write/danger + 三态确认
├── 演示与入口
│   ├── tools_demo.js        102 行   5 个工具：4 个小结果演示权限分级 + search_logs 演示截断
│   ├── llm.js                51 行   fetch 调 /chat/completions，配置读 env.json
│   └── main.js               53 行   入口：终端三态确认与预算参数都在这配
├── 测试
│   ├── test.js              202 行   7 个用例：三套能力协同（含 2 条边界补齐）
│   └── test-context.js      204 行   13 个用例：上下文机制自身的演进
├── package.json                     type: module + npm test / npm start
└── docs/
    ├── course.md                    教程：上下文六步演进 + 合体主循环
    └── interview.md                 面试：10 题（考点 / 答题结构 / 话术 / 代码锚点 / 追问）
```

**推荐阅读顺序**：`token_counter.js` → `sliding_window.js` → `context_manager.js` → `summary_compactor.js` → `context_manager_v2.js` → `agent.js` → `tools_demo.js` → `main.js` → 两份测试。前五个是零件，`agent.js` 是总装，测试是对总装的验证。

## 本章增量（相对第 2 章）

| 文件 | 状态 | 变了什么 |
|---|---|---|
| `token_counter.js` | 新增 | 字符近似 token 计数，预算管理的第一块砖 |
| `sliding_window.js` | 新增 | 滑动窗口，作为"按位置取舍"的失败对照 |
| `context_manager.js` | 新增 | 分层截断：按角色取舍 |
| `summary_compactor.js` | 新增 | LLM 摘要压缩：按语义取舍 |
| `context_manager_v2.js` | 新增 | 三层结构 + 水位线 + 递归压缩 + 工具结果截断 |
| `agent.js` | 重写 | 消息所有权交给 cm、每轮加水位线检查、回填前截断、LLM 纯注入 |
| `tools_demo.js` | 改动 | 4 个工具加到 5 个，新增 `search_logs`（858901 字符）用来演示截断 |
| `test.js` | 重写 | 第 2 章的 25 个用例留在第 2 章目录继续跑；本课改成 7 个协同用例 |
| `test-context.js` | 新增 | 13 个演进用例（从归档的独立版第 3 章恢复，改了三处适配：类名 Agent、registry 装配、test 脚本显式列文件） |
| `registry*.js` / `validation.js` / `errors.js` / `permissions.js` | 未改 | 与第 2 章同源：`registry.js`、`permissions.js` 逐字节相同，`registry_full.js` 只差一处缩进，`validation.js` 与 `errors.js` 各差一处第 2 章后续的小修（见缺口表） |
| `llm.js` | 改动 | 第 2 章用 `import env.json with { type: "json" }`，本课改成 `readFileSync` + try/catch：env.json 缺失时 fallback 环境变量，不会因为少一个文件就启动失败。这份实现第 4 章起沿用 |
| `package.json` | 改动 | test 脚本显式列出两个文件 |

`agent.js` 的三处实质改动：构造函数签名从 `(registry, { llm, verbose })` 变成 `({ registry, cm, llm, verbose })`（agent.js:28），messages 数组的持有权交给 cm；每轮推理前多一步水位线检查（agent.js:59），工具结果回填前多一步截断（agent.js:114）；Agent 不再 `import` llm.js，真实实现由 main.js:39 传入。顺带删掉了第 2 章 `_newGuards` 里只写不读的 `errorCounts` Map（agent.js:35-39）。

## 本课刻意不做的事（缺口 = 后续课程路线图）

| 缺口 | 后果 | 在哪一章补 |
|---|---|---|
| token 是字符近似，不是真 tokenizer | 预算判断有 10~20% 偏差 | 第 13 章：精确计数与成本对账（它自己那套用法就是这个估算器接口） |
| 工具结果按"4 字符 ≈ 1 token"折算字符数（context_manager_v2.js:30-36） | 纯中文大结果会被多留约 4 倍字符 | 本课不补；第 4 章的真实工具在工具内部先截一道，余下的精度问题归到第 13 章 |
| 摘要只在内存（`cm.summary`） | 进程退出即丢，重启后失忆 | 第 10 章：把 cm 三层序列化到磁盘 |
| 截断掉的部分没有落盘 | 省掉的中间内容读不回来，模型只能重查 | 第 4 / 10 课：返回文件路径，需要时分段读 |
| 未知工具默认按 read 放行（permissions.js:51） | 模型拼错工具名或注册遗漏时绕过审批 | 注释里留了一条待办（第 6 章再改），但第 4~13 章的 `permissions.js` 与本章仍是同一份（`diff` 验证过），尚未修 |
| 单一静态水位线 | 按任务类型、按模型窗口调不上去 | 第 13 章：观测与动态预算 |
| 摘要质量只靠 prompt 保留清单 | 压缩可能失真，丢关键事实 | 第 13 章的评测集能测出来；结构化摘要（JSON 字段化）是升级方向 |
| LLM 调用失败直接打穿 run（llm.js:46 抛错） | 一次 500 就整轮任务失败 | 第 13 章：重试 + 退避 + 熔断 |
| 无流式输出 | 用户干等整句生成完 | 第 13 章 |
| 单 Agent 单上下文 | 子任务共享同一个预算，无法隔离 | 第 6 章：子 Agent 各自持有 cm |
| 工具系统 3 个文件没跟上第 2 章后来的小修（`validation.js:40` 未知参数文案、`errors.js:16` 错误码键名、`registry_full.js:61` 缩进） | 两课同名文件的报错文案与常量键名不一致，跨章引用时容易引错 | 本批只改文档不改代码；回补要同步这 3 个文件（`lesson02-tool-system/` 是上游） |

## 测试覆盖（20 个用例，全部离线）

`test.js` 的 7 个用例，验证三套能力协同：

| 用例 | 行号 | 验证什么 |
|---|---|---|
| 完整工具系统：权限分级仍生效 | test.js:28 | confirm 返回 false → `PERMISSION_DENIED`，且 `NOTES.size` 仍为 0（拒绝即不落库） |
| 完整工具系统：参数校验仍生效 | test.js:36 | `get_weather {}` 缺参 → `INVALID_PARAMS` |
| Agent 调用大结果工具时结果被截断 | test.js:44 | search_logs 的结果回填进 tool 消息时含"已截断" |
| Agent 多轮对话触发压缩仍能收尾 | test.js:66 | 极小预算（maxTokens 200 / ratio 0.5）+ 30 条前置消息 → 出现 `[对话历史摘要]` 消息，任务仍完成 |
| Agent Loop 检测仍生效 | test.js:101 | 反复调同一工具 → 最后一条 tool 消息是 `LOOP_DETECTED` |
| Loop 检测触发时，同一响应里剩余 tool_calls 仍逐条回填 | test.js:124 | 一轮 3 个 tool_calls、第 2 个触发死循环 → 4 个 id 全部有配对回复，无孤儿 |
| retryable 错误累计到预算上限后注入 ERROR_BUDGET_EXHAUSTED | test.js:172 | 前 3 次是 `EXECUTION_FAILED`，第 4 次起变 `ERROR_BUDGET_EXHAUSTED` |

`test-context.js` 的 13 个用例，验证上下文机制自身的演进：

| 用例 | 行号 | 验证什么 |
|---|---|---|
| CJK 每字 1 token，英文每 4 字符 1 token | test-context.js:29 | 估算比例（"你好" = 2、"hello world" = 3） |
| countTokens 累计所有消息 | test-context.js:34 | 多条消息求和大于 0 |
| 滑动窗口超预算丢弃旧消息 | test-context.js:44 | 截断后最新一条仍在 |
| 滑动窗口会丢 system（缺陷演示） | test-context.js:56 | `isSystemPreserved` 返回 false——负向测试钉住 v2 的缺陷 |
| ContextManager 永远保留 system 和最后 user | test-context.js:67 | 分层截断的两条优先级规则 |
| ContextManager 中间历史从旧到新丢弃 | test-context.js:80 | 预算紧张时中间历史先丢 |
| summarize 调用 LLM 返回摘要 | test-context.js:96 | 摘要文本透传 |
| compact 保留最近 keepRecent 条，其余压成摘要 | test-context.js:107 | 切分点与保留条数 |
| truncateToolResult 截断超大结果 | test-context.js:122 | 10000 字符的文本变短且含"已截断" |
| TieredContextManager build 三层结构 | test-context.js:129 | system 在头部、最新消息在尾部 |
| TieredContextManager compact 触发条件 | test-context.js:138 | 20 条消息后 `needsCompaction()` 为 true，压缩后 recent 只剩 2 条 |
| budget 报告各层 token | test-context.js:159 | 账本字段齐全且 `used.total > 0` |
| Agent 集成：两次工具调用后返回最终答案 | test-context.js:171 | 两轮工具 + 收尾，至少 3 次 LLM 调用 |

两条说明。`滑动窗口会丢 system` 是负向测试：断言的不是正确行为，而是"这个缺陷确实存在"，它把 v2 到 v3 的演进钉在测试里。`Agent 集成：两次工具调用后返回最终答案` 原先与 `test.js` 的压缩用例同名（`npm test` 输出里两行一模一样），本章改成了现在这个名字。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `node main.js` 不打印 `[compaction]` | 正常。默认水位线是 2867，这次演示的账本只到 1273（实测）。想立刻看到压缩，把 main.js:30 的 `maxTokens` 调到 400 左右 |
| `401` 或 `fetch failed` | llm.js:37-48 打 `/chat/completions` 并检查了 `response.ok`；先确认 env.json 三个字段和端点路径（`/v1` 别漏）。model 值会 trim，前后空格不影响 |
| 压缩断言永远不成立 | 脚本化 LLM 必须用 `tools === null` 区分"摘要调用"和"正常推理"（summary_compactor.js:38 传的就是 null）。一律返回 `tool_calls` 会让摘要变成空字符串，`build()` 里 `if (this.summary)` 为假，摘要层根本不生成（test.js:78 按这个约定写） |
| 重试预算的用例为什么每次换参数 | 同工具 + 同参数重复 3 次会先被 Loop 检测拦下（agent.js:17）。这条用例第一次就是这么挂的，改成每次带不同 `attempt` 才走到预算分支（test.js:190） |
| 中文长文本截断后还是很大 | 截断按 4 字符 ≈ 1 token 折算（context_manager_v2.js:30-36），中文是 1 字 1 token，所以留下的字符数比预期多。见缺口表 |
| 想改预算参数看效果 | main.js:29-34 就是全部旋钮。改 `maxTokens` / `compactRatio` / `keepRecent` 后重跑，观察 `[budget]` 的 `used` 分层数字怎么变 |

## 文档导航

- **教程**（这一章做什么、十四个文件与阅读顺序、四个角色、六步演进逐文件讲、报文时序、下一章）：`docs/course.md`
- **面试**（10 题：考点 / 答题结构 / 参考话术 / 代码锚点 / 常见追问 + 自检清单）：`docs/interview.md`