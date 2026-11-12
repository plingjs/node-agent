# lesson06-multi-agent · 多 Agent 委派

**一句话定位**：把"委派子任务"做成一个普通工具（`delegate_task`）——子 Agent 拿自己的上下文管理器跑自己的循环，父 Agent 只收到一段结果摘要，收不到它那几十次工具调用的过程。

第 5 章的记忆与核心工具里 17 个文件原样继承（`memory_store.js`、`memory_entries.js` 带过来的是第 5 章修复前的版本，见下文），本章在这套骨架上叠一层"雇人干活"的能力。全部改动 = 新增 5 个文件（396 行）+ `agent.js` 注册一个工具 + `main.js` 加一条 `/demo` 命令。

## 学完这一章，你应该能做到

- 用一句话说清多 Agent 的价值是上下文隔离，而不是"人多力量大"
- 拆开 `delegate_task` 的工厂函数 + 闭包，讲明白 `depth` 怎么沿调用链传递
- 说出防递归的两个门限（工具列表物理过滤、执行时 `canDelegate` 兜底），并指出这两个门限在本章并不等价
- 手算并行委派的时间账：4 个任务并发 2，墙钟耗时接近最慢的 2 个，而不是 4 个相加
- 指出委派链路上哪里做了错误隔离、哪里没做

## 前置要求

- Node ≥ 18（内置 `fetch` 直连 OpenAI 兼容端点）
- **跑测试不需要 API key**；`node main.js` 真实对话才需要 `env.json`
- 读过第 5 章（记忆 + 核心工具）：本章 22 个共享文件里有 17 个与那一章逐字节相同

## 快速开始

### 1. 先跑测试

```bash
cd lesson06-multi-agent
npm test
```

实测输出（19 个用例，约 300ms）：

```text
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 296.904792
```

测试不需要联网：模型调用是注入的 `fakeLlm`（用 `messages[0].content.includes("子 Agent")` 区分父/子调用），工具却是真跑的——子 Agent 的 `search_files` 真的扫了 `demo/` 目录。

### 2. 真实运行

```bash
cd lesson06-multi-agent
node main.js

你> /demo                     # 两个子 Agent 并行搜 TODO / FIXME，父汇聚结果
你> 分析 demo 目录的代码质量    # 父 Agent 自己决定要不要委派
```

`/demo` 走 `delegateParallel`（`main.js` 第 54 行），终端会打印每个子 Agent 自己的工具调用（形如 `[子Agent#1] [tool] search_files -> ...`）和末尾的 `【子任务 N】` 汇聚块。第 5 章的元命令仍在：`/memories`、`/forget <名称>`、`/budget`、`/reset`。

本轮改造没有对端点发起真实调用（相关命令被权限层拦下），因此文档里的运行记录来自脚本化模型驱动真实模块的实跑——真实路径、真实工具，只是模型那一侧被换成了脚本。

## 文件地图

```
lesson06-multi-agent/
├── ★ 本章新增（5 个文件，396 行）
│   ├── depth_guard.js        32 行  防递归门限：canDelegate / shouldExposeDelegateTool / depthLimitMessage
│   ├── subagent.js          161 行  子 Agent：独立 cm + 简化主循环 + Loop 检测 + 工具白名单
│   ├── agent_tool.js         99 行  delegate_task 工具：工厂函数 + 闭包传 depth + mode=fork
│   ├── context_select.js     33 行  上下文选择：independent（默认）/ fork（继承父最近 4 条）
│   └── parallel.js           71 行  并行委派（并发池）+ mergeResults 结果汇聚
├── 本章改动（3 个文件）
│   ├── agent.js             172 行  主 Agent：构造时注册 delegate_task（第 44-54 行），主循环未动
│   ├── main.js              129 行  入口：REPL + /demo（第 90 行）+ 元命令
│   └── test.js              512 行  19 个用例（含 2 个错误隔离用例，其中 1 个是负向测试）
├── 第 5 章原样继承（17 个文件逐字节相同）
│   ├── core_tools.js        128 行  六个高杠杆工具：read/list/search/write/fetch/shell
│   ├── registry_full.js      86 行  执行流水线：查找→解析→权限→校验→执行→结构化错误
│   ├── registry.js           72 行  第 2 章 v1 版注册表（本章无引用，留作 v1→v2 对照）
│   ├── permissions.js        72 行  权限分级（read/write/danger）+ 三态确认
│   ├── validation.js         89 行  参数按 schema 校验 + 宽容转换
│   ├── errors.js             70 行  错误码表 + ToolError.toResult()
│   ├── context_manager_v2.js 144 行 三层上下文（system/summary/recent）+ 压缩 + 结果截断
│   ├── token_counter.js      57 行  token 估算（CJK 每字 1，其余每 4 字符 1）
│   ├── summary_compactor.js  63 行  LLM 摘要压缩
│   ├── memory_store.js      165 行  记忆落盘（markdown + frontmatter，按类型分目录）★ 与第 5 章有差异
│   ├── memory_entries.js     79 行  记忆 CRUD + 写入侧去重 + 索引重建 ★ 与第 5 章有差异
│   ├── extract.js            84 行  从对话提取记忆条目（LLM + 三层解析容错）
│   ├── recall.js            111 行  召回：中文 2-gram 分词 + 权重评分（+ 可选 LLM 精排）
│   ├── memory_manager.js    123 行  记忆门面 + 异步提取调度
│   ├── llm.js                51 行  /chat/completions 调用（配置读同级 env.json）
│   └── tools/               252 行  shell(68) / filesystem(66) / search(83) / fetch(35)
├── demo/                     21 行  TODO / FIXME 标记文件（委派演示的靶子）
├── docs/
│   ├── course.md                    教程：逐文件讲代码 + 实跑记录 + 用例行号表
│   └── interview.md                 面试 10 题（考点 / 结构 / 话术 / 行号锚点 / 追问）
└── package.json              12 行  npm test（node --test test.js）/ npm start
```

**推荐阅读顺序**：`depth_guard.js`（护栏）→ `subagent.js`（工人）→ `agent_tool.js`（任务单）→ `context_select.js`（带不带背景去）→ `parallel.js`（一次派发多个）→ `agent.js`（包工头怎么装配）→ `main.js`（怎么入口）→ `test.js`（怎么验证）。

`demo/` 里三处标记是演示靶子，`app.js` 有 2 个 TODO + 1 个 FIXME、`utils.js` 有 1 个 TODO、`styles.css` 有 1 个 FIXME——子 Agent 搜的就是它们。

## 本章增量（相对第 5 章）

| 维度 | 相对第 5 章的变化 |
|---|---|
| 新增文件 | `depth_guard.js`、`subagent.js`、`agent_tool.js`、`context_select.js`、`parallel.js`，共 396 行 |
| `agent.js` | 只改了构造函数的末尾：`registry.register(createDelegateTool({...}), "write")`（第 44-54 行）；`run()` 主循环、`_checkLoop`、压缩、记忆注入全部原样 |
| `main.js` | 加 `demoParallelDelegation()`（第 37 行）与 `/demo` 分支（第 90 行）；系统提示补一句"任务可拆成独立子任务时用 delegate_task"（第 30-34 行） |
| `test.js` | 用例整体换成本章的 19 个委派用例（第 5 章的记忆能力由 17 个同源文件与其自身用例背书） |
| 其余文件 | 17 个与第 5 章逐字节相同（`context_manager_v2.js`、`registry*.js`、`tools/*` 等，用 `diff` 逐个核对过）；`memory_store.js` 与 `memory_entries.js` **不同**——第 5 章修的两处（手写 frontmatter 的分隔符放宽、换类型时删旧目录副本）没有跟过来 |

`memory_store.js` 与 `memory_entries.js` 的差异不是本章的改动，是复制时带过来的旧版本：解析那条正则仍是 `\n\n`（手写记忆文件读不出来），换类型时也不删旧目录副本。它不影响委派，但"第 5 章能力原样继承"这句话对这两个文件不成立。

这次"加一层能力"的代价很小：框架侧只多了一次注册，因为 `delegate_task` 对主循环来说就是一个普通工具——模型决定调不调、传什么参数，registry 统一执行，结果以 `role:"tool"` 回填。

## 本章刻意不做的事（缺口 = 后续课程路线图）

| 缺口 | 后果 | 在哪一章补 |
|---|---|---|
| `delegateParallel` 没有单任务错误隔离 | 一个子 Agent 的 LLM 失败会让整批 `Promise.all` 抛出；`main.js` 第 90-92 行调用它时不在 `try/catch` 内，表现为 REPL 直接退出（已写成负向测试，`test.js` 第 390 行） | 第 13 章：错误兜底 + 重试 + 熔断 |
| 子 Agent 没有错误预算（`ERROR_BUDGET` 只在父 Agent 里） | 子 Agent 遇到反复 `retryable` 的失败只能靠 `MAX_TURNS=8` 或 Loop 检测兜底 | 第 13 章 |
| 子 Agent 不写记忆 | 子任务里发现的事实随子 Agent 一起消失，父要重新说一遍才进记忆 | 保持现状（记忆归父）；跨 Agent 共享要等编排层 |
| 无法取消、无超时 | 子 Agent 跑飞了只能等 `MAX_TURNS` 走完 | 第 13 章（AbortController） |
| 无跨 Agent 通信、无编排引擎 | 只有"父→子、结果回填"这一条边；做不了 A 完成触发 B、条件分支、依赖 DAG | 第 10~13 章路线图 |
| 无子 Agent 级观测 | 子 Agent 花了多少 token、跑了多久查不到 | 第 13 章 telemetry |
| 两个深度门限不一致 | `canDelegate(1, 2)` 为 `true` 但 `shouldExposeDelegateTool(1, 2)` 为 `false`：子 Agent 拿不到 `delegate_task`，于是那个运行时兜底在子 Agent 路径上不可达（`test.js` 第 110 行的用例把两个值都钉住了） | 要改哪一侧是产品决策，改前需你确认；`README` 与教程按现状描述 |
| `permissions.js` 第 51 行注释写着"生产应 fail-closed，第 6 章改" | 本章没改这个默认值，注释与实现不符（未知 kind 仍按 read 放行） | 需你确认改法，本章未动该文件 |
| `registry.js`（第 2 章 v1）在本章无任何引用 | 容易被误读成活代码 | 有意保留作 v1→v2 对照 |

## 测试覆盖（19 个用例，全部离线）

| 用例（test.js 行号） | 验证什么 |
|---|---|
| 子 Agent 独立运行（第 47 行） | `SubAgent.run` 能跑完整循环：调 `search_files` → 拿结果 → 收尾返回文本 |
| 上下文隔离（第 62 行） | 子 Agent 的 messages 只有 2 条（system + task），且 system 恰好是 `DEFAULT_SUBAGENT_PROMPT` |
| 隔离强化（第 79 行） | 父上下文里的 `abc123` 不会出现在子 Agent 收到的 messages 里（independent 模式） |
| 深度门限边界（第 110 行） | `canDelegate(0/1,2)=true`、`canDelegate(2,2)=false`；`shouldExpose(0,2)=true`、`shouldExpose(1,2)=false` |
| 物理隔离（第 121 行） | depth=1 的子 Agent，schema 列表里没有 `delegate_task` |
| 越界兜底（第 128 行） | depth=maxDepth 时执行 `fn` 返回 `{error: "深度限制..."}`，不抛异常 |
| 委派端到端（第 142 行） | 父委派 → 子跑工具 → 返回 `{result, fromSubagent: true}` |
| fork 选择（第 173 行） | `buildInheritedContext` 取最近 N 条；independent 返回 `null` |
| fork 集成（第 186 行） | `mode="fork"` 时子 Agent 收到的 messages 里含父的近期内容 |
| 自定义子提示（第 214 行） | `subagentPrompt` 真的传到了子 Agent 的 system 位 |
| 并发上限（第 235 行） | 4 个任务并发 2，实测峰值并发 ≤ 2，结果数量与顺序都对 |
| 并行越界（第 267 行） | 深度越界时直接拒绝，`fakeLlm` 一次没被调用（`llmCalls === 0`） |
| 汇聚格式（第 286 行） | `mergeResults` 输出带 `【子任务 1】` 前缀且包含各子结果 |
| 父自动委派（第 297 行） | 主 Agent 经 LLM 决定调 `delegate_task`，子结果回填后父给出最终回答 |
| 子 Agent 防失控（第 341 行） | 子 Agent 死磕同一工具时被注入 `LOOP_DETECTED`，不再空转 |
| 委派错误隔离（第 360 行） | 子 Agent 的 LLM 抛错被 `registry.execute` 转成 `EXECUTION_FAILED` 回填，父循环照常收尾 |
| 缺口（负向，第 390 行） | `delegateParallel` 无单任务隔离：一个子 Agent 抛错 → `assert.rejects`，整批挂掉 |
| Agent：Loop 判定后同轮剩余 tool_calls 逐条回填（`test.js:433`） | 一轮多个同签名调用只执行第一个，其余各回填 LOOP_DETECTED，无孤儿 tool 消息 |
| 子 Agent：同一场景（`test.js:469`） | 子 Agent 的循环同样逐条回填，父子行为一致 |

最后一条是负向测试：它断言的不是正确行为，而是"这个缺口确实存在"。第 13 章补上错误兜底之后，这条用例要改成断言"失败任务返回错误文本、其余任务的结果照常可用"——测试把演进过程也记录下来了。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 父 Agent 自己干完，从不委派 | `delegate_task` 的 `description` 决定模型怎么选它；system prompt 里也要点明可以委派（`main.js` 第 30-34 行就是这么写的） |
| 子 Agent 看不到我刚说的背景 | 默认 `independent`，子 Agent 只见 task 描述。要带背景得显式传 `mode="fork"`，且只继承父最近 4 条（`context_select.js` 第 28、32 行） |
| 子 Agent 调不到 `delegate_task` | 设计如此：depth≥1 时被物理过滤（`subagent.js` 第 69 行）。想看深层委派，把 `maxDepth` 调大 |
| `/demo` 报错后整个 REPL 退出 | `delegateParallel` 没有 per-task 错误隔离，且 `main.js` 第 90-92 行没包 `try/catch`（见缺口表，第 13 章补） |
| 并行委派没变快 | 任务之间存在依赖时不该并行；`maxConcurrent` 设成 1 也退化成串行。并行省的是墙钟时间，总 token 不变 |
| 触发 `⚠️ 需要确认` 卡住 | write / danger 级工具走 `cliConfirm`（`main.js` 第 23-28 行），`run_shell` 是 danger 级。测试里传 `() => true` 自动放行 |
| 记忆库里的东西不见了 | 测试的 `before`/`after` 会清空 `memories/` 目录；跑 `npm test` 会删掉真实会话攒下的记忆，介意就先备份 |

## 文档导航

- **教程**：`docs/course.md`——逐个文件讲代码（先贴核心代码再讲为什么这么写）、实跑记录、用例行号表
- **面试**：`docs/interview.md`——10 题三层（T1 基础 / T2 工程深度 / T3 架构设计），每题带真实行号锚点与常见追问
- 原 `lesson.md` 的内容已并入本文件与教程，文件已删除
