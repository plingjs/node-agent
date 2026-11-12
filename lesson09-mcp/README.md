# lesson09-mcp · MCP 协议接入（给 Agent 装外部工具）

**一句话定位**：新增 3 个文件 248 行（`mcp/mcp_server.js` 92 + `mcp/mcp_client.js` 109 + `mcp/mcp_tools.js` 47），Agent 用 stdio JSON-RPC 连上一个独立子进程，把它的工具动态发现并注册成 `mcp__calc__add` 这样的名字——注册完和 `run_shell` 完全平等。

第 7、8 章解决的是"手上已有的工具怎么用对"：技能把经验写成文本，Hooks 把扩展点做成钩子。这一章换方向，把手伸到进程外面。tools 列表里出现 `mcp__` 前缀的工具时，Agent 并不知道自己发出的是一次跨进程 JSON-RPC 请求——这就是本章要展示的效果。

## 学完这一章，你应该能做到

- 按生命周期讲出三步协议：`initialize` 握手 → `tools/list` 动态发现 → `tools/call` 调用，并说清工具 schema 由谁声明
- 讲清 JSON-RPC 客户端的请求-响应匹配（自增 id + pending Map + 逐请求超时），以及为什么它不依赖 FIFO 顺序
- 用真实输出说明"注册即平等"：外部工具进同一个 registry，权限拒绝的返回体和 `run_shell` 一模一样
- 解释 MCP 接进来为什么 `agent.js` 一行都不用改
- 说清本章修掉的那处配对缺陷：Loop 检测触发时，为什么同一条响应里剩下的 `tool_calls` 必须逐条回填

## 前置要求

- Node ≥ 18（内置 `node:test`、`node:child_process`，零第三方依赖）
- **跑测试不需要 API key**：MCP 那部分真实 spawn 子进程、真走 stdio，只有模型换成 `fakeLlm`
- 推荐先读第 8 章，本章 `main.js` 里演示的钩子机制就是第 8 章的 `hooks/hook_registry.js`

## 快速开始

### 1. 先跑测试

```bash
cd lesson09-mcp
npm test
```

本次交付的实跑结果（完整输出，8 个用例全绿；耗时数字随机器浮动）：

```text
> lesson09-mcp@1.0.0 test
> node --test test.js

✔ MCP client：连接 → 发现工具 → 调用（真实 stdio 通信） (24.434834ms)
✔ registerMcpTools：mcp__ 前缀注册 + registry 执行 (22.989708ms)
✔ HookRegistry：pre 钩子可拦截，post 钩子可改写 (0.234041ms)
✔ HookRegistry：add 返回移除函数 (0.079542ms)
✔ Agent：Hook 拦截危险命令（rm -rf）并回填错误给模型 (62.885083ms)
✔ Agent：MCP 工具 + 记忆 + 技能共存（完整能力面） (85.285791ms)
✔ Agent：Loop 检测触发时，同一响应里剩余 tool_calls 仍逐条回填 (62.758875ms)
✔ 子 Agent：Loop 检测触发时同样逐条回填，不留孤儿 tool_calls (2.090708ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 301.549333
```

前两个用例会真的 `spawn` 出 `mcp/mcp_server.js` 子进程并走一遍 JSON-RPC，全程离线。

### 2. 真实跑一次（需要模型服务）

章节目录下放 `env.json`（不要提交进 git）：

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

启动阶段这一段是实跑抓到的（`connectMcpServer` 与两段钩子注册都不经过模型）：

```text
[mcp] 已连接外部服务器，发现工具: add, echo, get_time
=== MCP + Hooks（lesson09）===
试试：'用计算器算 123+456'（会走 MCP 外部系统）或 '运行 rm -rf /'（被钩子拦截）
```

**REPL 里的对话没有实跑**：`node main.js` 要联网调真实模型，本次交付中这条命令被权限层拒绝执行。下面写的是预期行为，不是抓来的输出：

| 输入 | 预期会发生什么 |
|---|---|
| `用计算器算 123+456` | 模型调 `mcp__calc__add`（write 级）→ 终端问 `批准? (y=一次 / a=始终允许 / n=拒绝)` → 子进程返回 `579` |
| `运行 rm -rf /` | `run_shell` 是 danger 级，先过第一个 `PreToolUse` 钩子 → 被拦，回填 `HOOK_BLOCKED` |
| `/mcp` | 打印三个 `mcp__calc__*` 工具，输出形态与「main.js：启动连一次，退出收一次」一节的实跑片段一致 |

## 文件地图

本章只列新增与改动的文件；其余 28 个源文件从第 8 章原样带过来（根目录 23 个 + `tools/` 4 个 + `hooks/` 1 个）。

```
lesson09-mcp/
├── mcp/mcp_server.js      92 行   ★ 外部系统：独立进程，stdin 读请求行 / stdout 写响应行
├── mcp/mcp_client.js     109 行   ★ 客户端：spawn 子进程 + 自增 id + pending Map + 逐请求超时
├── mcp/mcp_tools.js       47 行   ★ 桥接：tools/list 发现 → mcp__<server>__<tool> 注册进 registry
├── hooks/hook_registry.js 65 行     Pre / PostToolUse 两个扩展点（第 8 章原样带过来）
├── agent.js              217 行     集成点：钩子拦在工具执行前后（本章改了 Loop 回填，见下）
├── subagent.js           164 行     子 Agent 执行器（本章一并修掉同款 Loop 回填缺陷）
├── main.js               122 行     入口：连 MCP server + 注册两段钩子 + /mcp 命令
├── test.js               297 行     8 个用例，含真实子进程 IPC
├── skills/**/SKILL.md  21~25 行     三个示例技能（第 7 章的数据，不是代码）
├── package.json           12 行     name / description 改成本章
└── docs/
    ├── course.md                    教程：三步协议 / 逐文件讲代码 / 真实报文 / 下一章
    └── interview.md                 10 题三层：考点 / 答题结构 / 话术 / 代码锚点 / 追问
```

**推荐阅读顺序**：`mcp/mcp_server.js`（外部世界长什么样）→ `mcp/mcp_client.js`（怎么通信）→ `mcp/mcp_tools.js`（怎么入籍）→ `main.js:42-58`（怎么接上）→ `hooks/hook_registry.js` + `agent.js:167-184`（拦在哪）→ `test.js`。

**从第 8 章原样继承的文件**：`hooks/hook_registry.js`、`tools/`（shell、filesystem、search、fetch）、`core_tools.js`、`registry.js`、`registry_full.js`、`validation.js`、`errors.js`、`permissions.js`、`context_manager_v2.js`、`summary_compactor.js`、`context_select.js`、`token_counter.js`、`memory_store.js`、`memory_manager.js`、`memory_entries.js`、`recall.js`、`extract.js`、`agent_tool.js`、`depth_guard.js`、`parallel.js`、`skill_store.js`、`skill_registry.js`、`skill_tool.js`、`skill_trigger.js`、`llm.js`。

## 本章增量（相对第 8 章）

| 位置 | 改了什么 |
|---|---|
| 新增 `mcp/` 三个文件 | 248 行，一条完整的 stdio JSON-RPC 链路：外部进程 / 客户端 / 注册桥接 |
| `agent.js` | MCP 接入本身**零改动**（它只认 registry 里的工具名）；本章只改了 Loop 检测的回填方式 |
| `subagent.js` | 同款 Loop 回填修复 |
| `main.js` | 去掉第 8 章的 audit-log 插件装配和 `/audit` 命令，换成 `connectMcpServer` 一行接入 + 两段内联钩子 + `/mcp` 命令 |
| `test.js` | 10 → 8 个用例：第 8 章的用例改写成本章的 8 个，保留 Hook 拦截/卸载与 Loop 回填回归，换成 MCP 真实 stdio 与注册用例 |
| `package.json` | name / description 改为 lesson09-mcp |

本章还修了一处跨章同族缺陷。Loop 检测命中时原代码用 `break` 跳出工具循环，同一条响应里排在后面的 `tool_calls` 就没人执行、也没有配对回填——下一轮把历史发给服务端时，`assistant(tool_calls)` 与 `tool` 的配对断了，真实 API 直接 400。修法是 `loopDetected` 标志位加逐条回填：判定命中后剩下的调用不再执行，但每条都补一条 `role="tool"` 的错误结果（`agent.js:143-165`）。第 2、3、4 章有同一处缺陷，第 4 章已修并留了同款用例（`lesson04-core-tools/test.js:237`）；第 5 章的 `agent.js`、第 6/7 章的 `agent.js` 与 `subagent.js`、第 8 章的 `subagent.js` 还是旧写法（第 8 章的 `agent.js` 已修），都不在本章改动范围。

## 本课刻意不做的事（缺口 = 后续课程路线图）

| 缺口 | 后果 | 在哪一章补 |
|---|---|---|
| 只实现 stdio transport | 跨机器接不了，本地子进程以外没有路径 | 生产按 Qwen Code 的 transport 抽象换成 HTTP/SSE |
| 无重连、无心跳 | 子进程崩溃后 client 无感知（写 stdin 得到 EPIPE） | 生产补健康检查 + 重连上限（Qwen Code 最多 3 次） |
| 无认证、无信任标记 | 远程 MCP 面对工具投毒和 SSRF 没有防线 | 生产补工具白名单 + trust 标记 + OAuth |
| 输出上限与内建工具同一个 | `truncateToolResult` 的 1000 token（`context_manager_v2.js:21`）对 MCP 偏紧 | 给 `mcp__` 前缀单独配上限 |
| server 路径硬编码 | `mcp_client.js:19-22` 固定指本目录的 `mcp_server.js` | 生产从配置读命令，支持挂多个 server |
| 协议级错误只有一条路径 | server 的未知方法被塞进 `result`（实跑 `_request("bogus/method")` 得到 `{"error":"未知方法: bogus/method"}`），没走 JSON-RPC 的 `error` 字段 | 一行修复：`mcp_server.js` 的 `default` 分支写 `response.error` |
| 客户端的 reject 分支没被覆盖 | `mcp_client.js:53`（JSON-RPC error → reject）在当前 server 行为下没有触发路径 | 修好上一条后补一个用例 |
| 第 8 章的 audit-log 插件没带过来 | 本章钩子是 `main.js` 里两段内联代码，留痕能力弱于第 8 章 | 按大纲推进时回补：`cp lesson08-plugin/plugins/` + `/audit` 三段 |

## 测试覆盖（8 个用例，全部可离线跑）

| 用例 | 行号 | 验证什么 |
|---|---|---|
| MCP client：连接 → 发现工具 → 调用（真实 stdio 通信） | `test.js:49` | 真子进程往返：`add(123,456)` 得 `"579"`、`echo` 回显、未知工具返回 error 不抛异常 |
| registerMcpTools：mcp__ 前缀注册 + registry 执行 | `test.js:75` | 注册后 `registry.execute("mcp__calc__add", ...)` 返回 `{"result":{"text":"42"}}` |
| HookRegistry：pre 钩子可拦截，post 钩子可改写 | `test.js:92` | `blocked=true` 命中；post 钩子原地改写 `payload.result` |
| HookRegistry：add 返回移除函数 | `test.js:116` | 调用移除函数后钩子不再触发 |
| Agent：Hook 拦截危险命令（rm -rf）并回填错误给模型 | `test.js:132` | 模型第二轮看到的 tool 消息里 `error.code === "HOOK_BLOCKED"` |
| Agent：MCP 工具 + 记忆 + 技能共存（完整能力面） | `test.js:183` | 模型调 `mcp__calc__add` 后收尾，回答含"计算完成" |
| Agent：Loop 检测触发时，同一响应里剩余 tool_calls 仍逐条回填 | `test.js:228` | 回归本章修复：每个 `tool_calls` 的 id 都有配对的 tool 消息 |
| 子 Agent：Loop 检测触发时同样逐条回填，不留孤儿 tool_calls | `test.js:270` | 子 Agent 侧的同款配对断言 |

配对断言的公共检查函数在 `test.js:34`（`assertAllToolCallsPaired`）。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `MCP 请求超时: initialize` | 子进程没起来：先单独跑 `node mcp/mcp_server.js`，手动喂一行 JSON 看有没有响应；正常时重跑即可（首个子进程冷启动偶尔慢过 5s，超时值在 `mcp_client.js:66`） |
| 模型调 `mcp__calc__add` 被拒 | 外部工具默认 write 级，需要确认；在终端回 `a`（始终允许）或 `y` |
| `/mcp` 什么都没打印 | 只有名字以 `mcp__` 开头的工具会被列出；空的说明 `main.js:55` 的连接没成功 |
| 工具名的下划线数不清 | 格式是 `mcp__<server>__<tool>`：前缀 + server 名 + 工具名。`calc` 是 `main.js:56` 传进去的 `serverName` |
| 想连远程 MCP 服务 | 本章 client 只会 `spawn` 本地脚本，换传输层要动 `mcp_client.js` 的 `connect`（`mcp_client.js:40-63`） |
| 改了 `mcp_server.js` 没生效 | 每次启动都会重新 spawn，重启进程就行（不像技能那样有加载缓存） |

## 文档导航

- **教程**：`docs/course.md` —— 三步协议、三个文件逐段讲、真实报文往返、一次完整往返的时序图、下一章
- **面试**：`docs/interview.md` —— 10 题三层（T1 基础 / T2 工程深度 / T3 架构设计），每题带考点、答题结构、话术、真实行号锚点与追问