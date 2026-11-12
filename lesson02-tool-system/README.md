# lesson02-tool-system · 工具系统

**一句话定位**：把第 1 章的 `call_tool` 升级为安全工具流水线：按名字匹配工具、校验参数、确认权限、执行并回填结果。

第 1 章证明"模型能自己决定调什么工具"；这一课解决"它乱调怎么办"。LLM 是不可信的调用方：会传错参数、幻觉工具名、陷入死循环、在你不知情的时候删东西。工具系统的本质是给这个不可信调用方建一套防御性 API。

先从[请求与响应教程](docs/request-response-walkthrough.md)开始，跟着一条具体消息看模型请求、工具调用、本地执行和结果回填。再读 [`docs/course.md`](docs/course.md) 查看模块设计细节。

## 学完这一课，你应该能做到

- 沿着 `tool_calls` 找到注册表中的工具定义，再读到本地 `fn` 执行的位置
- 说清参数解析、校验、权限确认、执行和 `role: "tool"` 回填的先后顺序
- 讲清 `"3"` → `3` 这类无损转换的边界：哪些转、哪些坚决不转、为什么
- 说清 read/write/danger 的决策树，以及 fail-closed 和实例级 `alwaysAllow` 各防什么
- 解释 `MAX_TURNS` 挡不住哪两类失控，Loop 检测与错误预算分别怎么处置

## 前置要求

- Node ≥ 18（内置 `fetch` + `node:test`，零第三方依赖）
- 读完第 1 章（本章的 `agent.js` 是它的主循环加两层防护）
- **离线自测不需要 API key，也不需要 `env.json`**——Agent 的模型调用由假模型替代

## 快速开始

### 先跑测试

```bash
cd lesson02-tool-system
npm test
```

用例全部离线：`agent.js` 的 LLM 调用是构造函数注入的，自测传一个脚本化的 `fakeLlm`，不联网、不花 token。危险操作相关用例会打印确认提示，这是预期输出。

### 真实运行

在同目录 `env.json` 里填三个字段（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`），或者 export 同名环境变量：

```bash
node main.js
```

`main.js` 让模型做三件事：查北京天气（read，自动执行）→ 存一条笔记（write，弹确认）→ 删一条笔记（danger，强制确认）。确认提示长这样，答案是 `y` / `a` / `n`：

```
  批准? (y=一次 / a=始终允许 / n=拒绝):
```

`write_note` 选 `a` 之后再存一条同类笔记就不会再问；`delete_note` 属于 danger，选 `a` 也只放行本次。

## 文件地图

```
lesson02-tool-system/
├── registry.js       72 行   v1 注册表：定义对象 + register/getSchemas/execute
├── validation.js     89 行   v2 参数校验：schema 驱动 + 类型宽容转换表
├── errors.js         70 行   v3 结构化错误：ErrorCode + ToolError + toResult
├── permissions.js    72 行   v4 权限分级：read/write/danger + 三态确认
├── registry_full.js  86 行   ★ 六步流水线：把 v1~v4 串成一次 execute()
├── agent.js         主循环：轮数上限 + Loop 检测 + 错误预算，llm 依赖注入
├── tools_demo.js     93 行   4 个演示工具，覆盖三种安全等级
├── llm.js            56 行   模型层：env.json 优先 → 环境变量 → 默认值
├── main.js           44 行   入口：readline 三态确认
├── test.js          25 个用例（离线，含安全等级声明检查）
├── env.json                  本机配置（缺失也能跑测试）
└── docs/
    ├── request-response-walkthrough.md 逐次拆解请求、响应和工具结果回填
    ├── course.md             深入教程：模块设计、代码细节和工程边界
    └── interview.md          面试 10 题：考点 / 答题结构 / 话术 / 代码锚点 / 追问
```

**推荐阅读顺序**：`registry.js` → `validation.js` → `errors.js` → `permissions.js` → `registry_full.js` → `agent.js` → `tools_demo.js` → `main.js` → `test.js`。前四个是零件，`registry_full.js` 是总装，`agent.js` 装上发动机，`tools_demo.js`/`main.js` 接上真实场景，`test.js` 是质检报告。

## 本章增量（相对第 1 章）

| 维度 | 第 1 章 | 第 2 章 |
|---|---|---|
| 工具定义 | `TOOLS` 数组 + `call_tool` 的 if 分支，两处手工同步 | 一个定义对象 `{name, description, params, fn}`，协议与实现同体 |
| 路由 | `if (name === "x")` 硬编码 | `register()` 动态注册，Map 查找 |
| 参数 | `JSON.parse(args)` 裸解析，坏 JSON 直接崩 | 容错解析 + schema 校验 + 宽容转换 |
| 错误 | 字符串 `{error}` 或抛异常打穿进程 | ErrorCode + `retryable`，工具异常全隔离成结果 |
| 权限 | 没有 | read/write/danger + 三态确认 + 无通道时 fail-closed |
| 防失控 | 只有 `MAX_ROUND` | 轮数上限 + Loop 检测 + 错误预算 |
| 可测性 | 测试要替换 `globalThis.fetch` | `new Agent(registry, { llm: fakeLlm })` 构造注入 |
| 配置 | 只读环境变量 | `env.json` 优先，缺失 fallback 环境变量 |
| 规模 | 4 个核心文件 / 10 用例 | 10 个源码文件 / 25 个离线用例 |

第 1 章那两个负向用例（未知城市 `TypeError`、非法 JSON `SyntaxError`）在本章被修掉了：它们现在走结构化错误路径，见 `test.js:154`、`test.js:292`。

## 和 Python 版差在哪

| 维度 | Python 版 | Node 版 | 面试怎么讲 |
|---|---|---|---|
| Schema 来源 | 函数签名 + 类型注解自动生成 | 工具定义对象显式声明 | 语言类型系统决定框架设计 |
| LLM 调用 | `urllib`（标准库） | 内置 `fetch` | 零依赖的同一种实现思路 |
| 测试注入 | `unittest.mock.patch` 替换模块引用 | 构造函数注入 `llm` | DI 与 patch 的取舍 |
| 测试框架 | `unittest` | `node:test` | 零依赖原则贯穿 |
| 权限状态 | 模块级 `alwaysAllow` 单例 | **实例级 `alwaysAllow`** | 授权作用域 = 安全边界 |

Python 版能从 `def write_note(title: str, content: str)` 的类型注解里 `inspect` 出 schema，JS 没有运行时类型信息，只能手写（或用 Zod 这类库一次产出 schema + 校验器）。权限状态是两版之间唯一的设计差异，Node 版把 `alwaysAllow` 做成实例字段而 Python 版当时是模块级单例——成因就是"会话 A 批准过的东西，不该让会话 B 自动继承"。

面试里主动对比两版是加分项：同一个工具系统用两种语言实现过，最大的语言差异在 schema 来源，最能说明设计能力的是"权限状态从全局单例改成实例字段"这种具体改动——它不是为了简洁，是为了堵一个权限作用域的洞。

## 缺口表（缺口 = 后续课程路线图）

| 缺口 | 后果 | 在哪一章补 |
|---|---|---|
| 第 3–13 章仍需统一审计安全等级默认值 | 部分复制章节可能仍有默认放行行为 | 后续课程一致性复核 |
| 工具结果原样进 `messages`，没有截断 | 一次返回几万字的工具撑爆上下文窗口 | 第 3 章 |
| 预算只有轮数/签名/错误三种 | 没有 token 与成本维度，长任务烧钱无感知 | 第 13 章 |
| 无超时/重试/熔断，429/5xx 直接抛 `Error` | 模型服务抖一下就整轮失败 | 第 13 章 |
| 校验只覆盖一层属性 | 嵌套对象/数组的形状错误漏检 | 第 4 章没接这条；第 3~13 章的 `validation.js` 与本章同源，仍只校验一层 |
| 审批只有 readline 一条通道，没有留痕 | 无人值守时无法审批，事后无法追溯 | 第 11 章（IM 审批流）、第 8 章（audit-log） |
| 工具集写死在 `tools_demo.js` | 20+ 工具时模型选择困难，无法按场景加载子集 | 第 4 章 / 第 9 章（MCP） |

## 测试覆盖（25 个用例，全部离线）

| 用例 | 行号 | 验证什么 |
|---|---|---|
| schema 从工具定义对象生成 | `test.js:30` | 定义对象 → OpenAI Function Calling 协议格式 |
| 缺必填参数报错 | `test.js:57` | 报 `INVALID_PARAMS`，且 message 里点名缺了谁 |
| 整数无损转换 | `test.js:66` | `3.0`、`"3"` 转为 `3`；`3.7` 和超出安全范围的整数拒绝 |
| 未知参数拒绝 | `test.js:73` | 未声明的参数被拦下并报错 |
| 错误码与 retryable 语义 | `test.js:79` | 参数错/工具错不可重试，执行错可标 retryable |
| toResult 结构 | `test.js:87` | 错误转成 `{error:{code,message,...}}` |
| read 自动放行 | `test.js:95` | READ 不问直接过 |
| write 需要确认 | `test.js:101` | WRITE 会调 confirm |
| always 记住后不再询问 | `test.js:109` | 选 `always` 后第二次不问 |
| 权限状态实例隔离 | `test.js:118` | 会话 A 的授权不污染会话 B |
| 拒绝抛权限错误 | `test.js:128` | 拒绝路径抛 `PERMISSION_DENIED` |
| 流水线成功路径 | `test.js:142` | `execute("get_weather", ...)` 拿到北京 晴 25°C |
| 工具不存在 | `test.js:148` | 幻觉工具名 → `TOOL_NOT_FOUND` |
| 非法 JSON 参数 | `test.js:154` | 坏 JSON → `INVALID_PARAMS`（第 1 章这里崩进程） |
| 缺参返回结构化错误 | `test.js:160` | 缺 `city` → 结构化错误且 message 点名 |
| 权限拒绝不落库 | `test.js:167` | 被拒后 `NOTES.size === 0`，副作用没发生 |
| Loop 检测注入 LOOP_DETECTED | `test.js:177` | 同签名重复 3 次 → 注入错误让模型收尾 |
| write 工具经 Agent 落库 | `test.js:202` | 走完整主循环后笔记真的存进去了 |
| 错误预算耗尽 | `test.js:230` | 连续 retryable 错 4 次 → `ERROR_BUDGET_EXHAUSTED` |
| MAX_TURNS 兜底结束 | `test.js:256` | 模型永远不收尾时精确停在第 10 轮 |
| danger 的 always 也每次必问 | `test.js:271` | `"always"` 只对 WRITE 生效，danger 免不了审 |
| 无确认通道 fail-closed | `test.js:282` | `confirm = null` 时拒绝而不是放行 |
| 工具业务错误结构化 | `test.js:292` | 查无此城市 → `EXECUTION_FAILED`、不可重试 |
| 安全等级必填 | `test.js:300` | 注册工具时漏写或拼错安全等级会立即报错 |
| 死循环后 tool_call 仍回填 | `test.js:314` | 一轮 4 个同签名调用，4 条 `role:"tool"` 按 id 配对齐全 |

最后一条守的是协议配对：`assistant(tool_calls)` 和 `role:"tool"` 必须成对，断一条下一轮请求就被服务端 400 拒绝。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `ERR_MODULE_NOT_FOUND: .../env.json` | 旧版 `llm.js` 静态 import env.json，本仓已改成 `readFileSync` + try/catch，缺失时用环境变量；若你本地还是报这个，看 `llm.js:11` 的 `loadConfig()` |
| 测试里刷 `⚠️ 危险操作确认: delete_note({})` | `permissions.js:62` 的终端提示被 danger 用例触发，不是失败 |
| 模型返回 `TOOL_NOT_FOUND` | 它在幻觉工具名，`errors.js:54` 的 message 就是给它看的纠正指令 |
| 模型一直重复调同一个工具 | 看 `agent.js:43` 的 Loop 检测是否生效（同签名 3 次）；阈值在 `agent.js:16` |
| 确认提示卡住没人回答 | review `permissions.js:56` 起的分支：无 confirm 通道时是 fail-closed 拒绝，不是放行 |
| 想换个模型 / 换私端点 | 只改 `env.json` 的 `OPENAI_BASE_URL` 与 `OPENAI_MODEL`，代码零改动（`llm.js:11`） |
| 加一个工具要改几处 | 只写一个定义对象 + 一次 `register(toolDef, kind)`，注册表代码不动 |

## 文档导航

- **请求教程**（逐次看模型请求、响应、工具匹配和结果回填）：`docs/request-response-walkthrough.md`
- **设计教程**（模块职责、关键实现、工程边界和下一章）：`docs/course.md`
- **面试**（10 题三层：考点 / 答题结构 / 话术 / 代码锚点 / 追问 + 自检清单）：`docs/interview.md`
