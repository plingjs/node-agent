# lesson10-session · 多会话 + 保存恢复（让对话活过进程）

**一句话定位**：新增 2 个文件 211 行，把上下文管理器（cm，第 3 章起就有的 `TieredContextManager`，装着 system / summary / recent 三层）连同会话元数据写成一个 `sessions/<id>.json`，进程重启后 `/use` 切回去接着聊。

前九章的 Agent 手、脑、记性、帮手、经验都齐了，但上下文只活在进程内存里——Ctrl+C 之后这段对话就没了，也没法同时开两条线。这一章补的就是"存盘"和"切换"。

## 学完这一章，你应该能做到

- 分清运行时状态的四层里哪两层该落盘、哪两层该重建，并用一句话说清依据（"状态要存，资产要建"）
- 讲清"注入 vs 持久"这条线：为什么 system 里每轮重新召回的记忆和技能不能写进会话文件
- 指着代码说清序列化的两个坑：`tool_calls` / `tool` 配对完整性、`.tmp` + `rename` 原子写
- 说清切会话时内存里发生了什么（save 旧 → load 新 → `restoreContext` 覆盖三层），以及为什么记忆是刻意共享的
- 跑通 12 个用例并说清每个钉住什么，包括 2 个钉住"Loop 判定后不能 break"的回归用例

## 前置要求

- Node ≥ 18（本章只用内置 `node:test`、`node:fs/promises`、`node:crypto`，零第三方依赖；实测跑在 Node v26.8.2 上）
- **跑测试不需要任何 API key**；只有真实对话（`node main.js`）才需要模型服务
- 推荐先读完第 9 章 MCP：本章 30 个源文件（外加 `skills/` 下 3 个 SKILL.md）是从第 9 章原样带过来的

## 快速开始

### 1. 先跑测试（不需要任何配置）

```bash
cd lesson10-session
npm test
```

期望输出：12 个用例全绿，约 50ms。测试离线跑（假 LLM + 系统临时目录），不联网、不花 token，跑完不在章节目录里留任何东西——会话写进 `/tmp`，`memories/` 如果存在会先改名为 `.seed-backup`、测试结束再放回（见"常见问题"最后两条）。

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

启动时会先把最近一个会话恢复进内存（`main.js:107-117`），然后打印命令表（`main.js:118`）。REPL 里能用这些：

| 命令 | 作用 |
|---|---|
| `/sessions` | 列出全部会话：8 位 id、标题、更新时间、消息数，活跃会话带 `*`（`main.js:92-104`） |
| `/new` | 保存当前会话 → 新建一个 → `agent.reset()` 清空上下文（`main.js:135-145`） |
| `/use <id>` | 保存当前 → 载入目标 → `restoreContext` 覆盖三层（`main.js:146-154`） |
| `/delete <id>` / `/rename <id> <标题>` | 删除（删的是活跃会话则一并 reset）／改标题 |
| `/skills` `/memories` `/budget` `/reset` | 第 5~9 章带过来的元命令 |

每轮对话结束会打印 `[已自动保存到会话 xxx]`（`main.js:213`）。

本章记录文档时只实跑了离线部分：`npm test`、会话保存/恢复的跨进程往返、Loop 配对的修复前后对照。`node main.js` 这条交互路径需要真实模型服务（本机 `env.json` 已配好 base_url 与 model），但交互式运行在本轮的权限层被拒绝执行，所以文档里没有贴 REPL 的对话输出——引用到的都是源码行号和离线实跑结果。

## 文件地图

本章只列新增与改动的文件；其余 30 个源文件（外加 `skills/` 下 3 个 SKILL.md）从第 9 章原样带过来，一行没动。

```
lesson10-session/
├── session_state.js     69 行  ★ v1 序列化层：serializeContext / restoreContext / truncateToCompletePairs
├── session_manager.js  142 行  ★ v2 仓库层：create / list / load / save / delete / rename / touch + 原子写
├── main.js             225 行  ★ v3 多会话 REPL：自动保存、切换、跨进程恢复、/sessions 等命令
├── agent.js            216 行  主 Agent：本章修 Loop 判定后的配对 bug
├── subagent.js         164 行  子 Agent：同一个 bug 的第二处，同章修复
├── llm.js               56 行  加 getConfig() 导出，供 main.js 把模型名写进会话元数据
├── test.js             325 行  12 个用例
├── package.json              name / description 改为 lesson10-session
├── sessions/                 两个真实会话文件（跑 main.js 落盘的产物，人类可读）
│   ├── 963958b8.json      813 B   一次 "hi" 对话
│   └── 833be714.json     1883 B   一次会话里问了句 session id
└── docs/
    ├── course.md             教程：为什么需要存盘 / 逐文件讲代码 / 实跑输出 / 下一章
    └── interview.md          10 题三层：考点 / 答题结构 / 话术 / 代码锚点 / 追问
```

**推荐阅读顺序**：`sessions/833be714.json`（先看存下来的东西长什么样）→ `session_state.js`（怎么序列化、怎么截断配对）→ `session_manager.js`（存哪、怎么原子写、怎么列）→ `main.js:66-104`（保存与切换）→ `main.js:199-213`（对话主循环里的三个会话钩子）→ `test.js`。

**从第 9 章原样继承的 30 个源文件**：`core_tools.js` / `registry.js` / `registry_full.js` / `validation.js` / `errors.js` / `permissions.js` / `tools/`（shell、filesystem、search、fetch）/ `mcp/`（mcp_client、mcp_server、mcp_tools）/ `hooks/hook_registry.js` / `context_manager_v2.js` / `summary_compactor.js` / `context_select.js` / `token_counter.js` / `memory_store.js` / `memory_manager.js` / `memory_entries.js` / `recall.js` / `extract.js` / `agent_tool.js` / `depth_guard.js` / `parallel.js` / `skill_store.js` / `skill_registry.js` / `skill_tool.js` / `skill_trigger.js`；另有 `skills/` 下 3 个 SKILL.md 数据文件同样原样带过来。

## 本章增量（相对第 9 章）

| 位置 | 改了什么 |
|---|---|
| 新增 `session_state.js`（69 行） | cm 三层 ↔ JSON；序列化和恢复两个方向都做配对截断；消息浅拷贝 |
| 新增 `session_manager.js`（142 行） | `SessionManager`：CRUD + 原子写 + 损坏文件跳过 + `autoTitle` |
| `main.js`（122 → 225 行） | 从单会话 REPL 改成多会话 REPL：`saveActiveSession` / `switchSession` / `listSessions` 三个函数，命令集加了会话管理的 5 条 |
| `llm.js` | 导出 `getConfig()`，`main.js:113` 建会话时要拿 model 名字写进元数据 |
| `test.js`（297 → 325 行） | 第 9 章的 8 个用例换成本章的 12 个：序列化、配对、管理、原子写，加 2 个 Loop 配对回归 |
| `agent.js` `subagent.js` | 修同一个 bug：Loop 判定后用 `break` 跳出工具循环，同一条响应里剩下的 `tool_calls` 没有 `tool` 消息回填（下一轮 API 400）。改成 `loopDetected` 标记 + 逐条回填 |
| `package.json` | name / description 改名 |

接入点只有 `main.js` 里新增的三个函数，加上 `agent.cm` 的两处读写；工具调度、权限、压缩、记忆、委派、技能、MCP、Hooks 的代码没动——这是这一章能做到"只存状态不碰机制"的证据。

## 本课刻意不做的事（缺口 = 后续课程路线图）

| 缺口 | 后果 | 在哪一章补 |
|---|---|---|
| 存储是单机 JSON 文件，无并发写锁 | 两个进程同时 `save` 同一会话会互相覆盖（后写的赢） | 未排课；生产换 SQLite（事务）或加文件锁 |
| `list()` 全表扫 + 全量 `JSON.parse` | 会话上千后 `/sessions` 变慢，没有分页和索引 | 未排课；生产落 SQLite 加索引 |
| 没有会话级 token / 成本统计 | 答不出"这个会话花了多少钱" | 第 13 章 telemetry（按 `session_id` 聚合） |
| 单活跃会话 | 同一时刻只有一个会话的 cm 在内存，`/use` 要 save + load，做不到两条线同时推理 | 需要多 Agent 实例，未排课 |
| 标题只截取首句前 20 字 | "帮我查一下杭州天气" 只是被截短，不是被概括 | 生产用两段式：截取兜底 + 后台 LLM 润色（渐进增强） |
| 会话没有导入导出、没有多用户隔离 | `sessions/` 是单用户目录，没法分享会话、没法按租户分权 | 未排课；企业版按租户分目录 + 权限 |
| `rebuildContext`（`session_state.js:60`）没有调用方 | 会话恢复走的是 `restoreContext` 直接填 `agent.cm`，这个工厂只在接口上留了口子，预算参数（4096/512）与 `agent.js:81-88` 相同，差别在它造的是新实例 | 留着当接口示例；接线要改成"从存储恢复出一个完整 cm"的用法 |
| 崩溃最多丢当前这一轮 | `run()` 期间崩溃，这一轮的用户输入和模型输出都不在盘上 | 与 ChatGPT 同款取舍；要更细就每轮推理后 save + 防抖 |

## 测试覆盖（12 个用例，全部可离线跑）

| 用例 | 行号 | 验证什么 |
|---|---|---|
| serialize/restore 往返：三层状态完整 | `test.js:65` | system / summary / recent 逐字段还原 |
| serialize 只存基础 system | `test.js:84` | 注入内容属于运行时状态，不落盘 |
| truncateToCompletePairs：孤立 tool 被截断 | `test.js:97` | 5 条消息（末尾孤立 `tool c99`）截到 4 条，完整序列保留 |
| restore 防御：恢复时同样截断 | `test.js:111` | 数据入口再截一次，挡住被手工改坏的会话文件 |
| Loop 检测触发时，同一响应里剩余 tool_calls 仍逐条回填 | `test.js:122` | （回归）`c2a` 触发 LOOP 后 `c2b` 也必须有一条 `tool` 消息 |
| 子 Agent 同样处理 | `test.js:180` | （回归）第二个实例：`subagent.js` 的同一处 bug |
| SessionManager：create/list/load/save/rename/delete | `test.js:229` | 六个方法的往返；delete 不存在的会话返回 `false` |
| SessionManager：多会话并行互不干扰 | `test.js:260` | A / B 两个会话各自 load 回自己的内容 |
| SessionManager：list 跳过损坏的会话文件 | `test.js:278` | 一个坏 JSON 不让整个列表挂掉 |
| SessionManager：touch 只更新元数据 | `test.js:291` | 改标题 / 消息数，`context` 原样保留 |
| 原子写：save 后无 .tmp 残留 | `test.js:309` | `.tmp` 已被 `rename` 收走 |
| autoTitle 截取前 N 字 | `test.js:321` | 超长截断加 `…`、短标题原样、空输入兜底 |

测试隔离有两层：会话目录全部落在系统临时目录（`test.js:27-34`，跑完连临时目录一起删掉），记忆库先把整个 `memories/` 改名到 `.seed-backup`、结束时放回（`test.js:40-61`）。第二个是这一章修掉的测试污染：第 9 章传下来的写法直接 `rm(MEMORY_ROOT)`，读者只要跑过一次 `main.js` 攒下记忆，跑测试就会被删光。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 模型报 400 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` | 某个 `assistant(tool_calls)` 里的调用没等到 `tool` 消息。本章修掉的正是这个：Loop 判定后 `break` 会漏掉同一条响应里剩下的调用（`agent.js:151-163`、`subagent.js:133-145`）。手工排查法：打开会话文件，数一下每条 `tool_calls` 的条数与紧随的 `tool` 消息条数是否相等 |
| `/use xxx` 提示 `会话不存在: xxx` | id 只有 8 位短 id，用 `/sessions` 抄；也可能那个文件损坏被 `list()` 跳过了 |
| `sessions/` 里出现 `xxxx.json.tmp` | 上一次写入中途异常退出留下的。正常流程不会留（`rename` 把 `.tmp` 收走，`session_manager.js:95-101`），可以直接删 |
| 恢复会话后第一轮没看到记忆或技能注入 | 这是设计：注入内容（记忆召回、技能正文）不落盘，首轮 `run` 重新召回（`main.js:69`）。若一直召回不到，检查 `memories/` 目录是否还在 |
| 跑测试会删掉我的会话和记忆吗 | 不会。会话写 `/tmp`，`memories/` 走备份还原；测试跑完章节目录里不会多出或少了任何文件 |
| `npm test` 之后目录里多了 `memories/` | 只有你自己跑过 `main.js`（或手动调过记忆工具）才会有；测试期建的空库在 `after` 里被删掉，首次运行不会凭空造目录 |
| `[warn] 会话保存失败（不影响对话）` | `save` 抛异常被兜底了（`main.js:77-79`），磁盘满 / 权限问题；对话继续，损失是这一轮没落盘 |
| 想亲眼看配对 bug | 把 `agent.js:163` 的 `continue` 改回 `break`，`npm test` 立刻出现 2 个红灯（`test.js:122` 和 `test.js:180`），红灯信息会点出缺配对的那个 `tool_call_id` |

## 文档导航

- **教程**：`docs/course.md` —— 为什么"能存盘"是产品分水岭、四层状态怎么分流、注入与存储的边界、两个文件逐段讲、真实跑出的 JSON 与消息序列、下一章
- **面试**：`docs/interview.md` —— 10 题三层（T1 基础 / T2 工程深度 / T3 架构设计），每题带考点、答题结构、话术、真实行号锚点与追问
- **上一章**：`../lesson09-mcp/README.md` ｜ **下一章**：`../lesson11-gateway/README.md`