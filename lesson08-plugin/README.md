# lesson08-plugin · Plugin 系统（Hooks 扩展点 + 审计插件）

**一句话定位**：新增 3 个文件 215 行，给 Agent 装一套"插座 + 电器"——框架在工具执行前后各开一个钩子点（Hooks），插件订阅它注入能力；配套写一个真解决合规问题的 `audit-log` 插件，工具调用留痕、危险命令拦截、敏感参数脱敏、调用统计。

前七章里，工具一旦被模型调用就直接执行：没有留痕、没有旁路检查、没有统计。企业里跑 Agent 最先被问的三个问题恰好都在这里——"谁让它跑了什么命令"（审计）、"删库命令怎么挡住的"（安全）、"这个月工具调了多少次、错了多少次"（成本与质量）。这一章不新增 Agent 能力，而是给已有能力加上可插拔的横切层。

## 学完这一章，你应该能做到

- 一句话分清 Plugin / MCP / Skill：谁是代码、谁是协议、谁是知识，各自在什么时机加载
- 讲清 Hooks 为什么是插件系统的核心：框架只定义事件 + 注册 API + 触发点，插件订阅，框架零改动
- 手写一个插件：`install(hooks)` 注册钩子并返回卸载函数，卸载只摘掉自己注册的那几个引用
- 说清 PreToolUse 的拦截为什么回填 `HOOK_BLOCKED` 而不是静默跳过，以及 PostToolUse 的改写为什么必须用返回值
- 跑通 10 个用例并说清每个钉住什么，包括 3 个回归用例（2 处缺陷 + 1 处子 Agent 同族）

## 前置要求

- Node ≥ 18（本章用内置 `node:test`、内置 `fetch`，零第三方依赖）
- **跑测试不需要任何 API key**；只有真实对话（`node main.js`）才需要模型服务
- 推荐先读完第 7 章：本章的 Agent 是在第 7 章代码上叠加的，22 个源文件逐字节带过来

## 快速开始

### 1. 先跑测试（第一步，不需要配置）

```bash
cd lesson08-plugin
npm test
```

实测输出（10 个用例，约 240ms）。测试用假 LLM（`fakeLlm`）驱动主循环，审计日志写到 `/tmp/audit-test-*.log`，不联网、不花 token。

```text
> lesson08-plugin@1.0.0 test
> node --test test.js

✔ HookRegistry：pre 拦截 + post 改写 + 卸载 (1.417209ms)
✔ 插件：危险命令被拦截（可配置规则） (0.802208ms)
✔ 插件：敏感参数脱敏（token/password 打码） (0.269ms)
✔ 插件：调用留痕 + 结果状态（query） (0.360291ms)
✔ 插件：summary 使用统计（调用/错误/拦截） (0.372458ms)
✔ 插件：install 返回卸载函数（可插拔） (0.151791ms)
✔ Agent + audit-log 插件：端到端拦截与留痕 (64.078625ms)
✔ Loop 检测触发后，同一响应的剩余 tool_calls 也逐条回填 (64.096ms)
✔ PostToolUse 改写的结果被回填给模型（改写生效） (62.753125ms)
✔ 子 Agent：Loop 判定后同轮剩余 tool_calls 也逐条回填 (2.045666ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 237.649666
```

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

启动时先打印插件安装确认（`main.js:47`），再进 REPL：

```text
[plugin] audit-log 已安装（审计 + 危险拦截 + 脱敏）
=== Plugin 系统（lesson08）===
试试：'搜索 demo 目录'（留痕）/ '运行 rm -rf /'（被审计拦截）/ /audit 看记录
```

进 REPL 后试这几句，元命令实现见 `main.js:70-106`：

```text
你> 列出当前目录 doc 开头的文件     → 正常执行，同时被审计留痕
你> 运行 rm -rf / 清理磁盘         → 命中 dangerRules，回填 HOOK_BLOCKED
你> /audit                        → 最近的审计记录（可按工具过滤：/audit run_shell）
你> /audit-summary                → 每工具 调用 / 错误 / 拦截 次数
你> /plugins                      → 已装插件列表
```

本章文档里的"真实模型证据"来自与 `main.js` 同一套装配（同一个 `agent.js` + `buildCoreTools` 注册表 + audit-log 插件）的脚本运行：把 `/audit` 这类输入直接 pipe 进 REPL 的命令被权限层拦下，所以没贴 REPL 的原始屏录，贴的是等价装配下真实模型跑出的消息序列与审计记录（见 `docs/course.md` 里的插件实跑输出）。

## 文件地图

本章只列新增与改动的文件；其余 22 个根目录源文件从第 7 章逐字节带过来（`diff` 实跑确认）。

```
lesson08-plugin/
├── hooks/
│   └── hook_registry.js        65 行   ★ 插座：HookEvent 两个事件 + add(返回卸载函数) + firePreToolUse(短路)/firePostToolUse
├── plugins/
│   └── audit-log/
│       ├── plugin.js          136 行   ★ 电器：留痕 / 危险拦截 / 参数脱敏 / 调用统计 + install 返回卸载函数
│       └── manifest.json       14 行   插件清单：name / version / hooks / config（三组危险规则）
├── agent.js                   218 行   ★ 接线：工具执行前 firePreToolUse、执行后 firePostToolUse
├── main.js                    124 行   REPL：/plugins、/audit [工具]、/audit-summary、卸载演示
├── test.js                    358 行   10 个用例（7 个原有 + 3 个回归）
├── skills/                            第 7 章的三个 SKILL.md（数据，非本章改动）
├── tools/ core_tools.js registry*.js  第 7 章的工具与执行流水线（22 个根目录 .js 逐字节相同）
└── docs/
    ├── course.md                      教程：为什么需要钩子点 / 逐文件讲代码 / 两个 bug 的修法 / 真实运行记录
    └── interview.md                   10 题三层：考点 / 答题结构 / 话术 / 代码锚点 / 追问
```

**推荐阅读顺序**：`hooks/hook_registry.js`（插座长什么样）→ `plugins/audit-log/plugin.js`（一个真实插件怎么插上去）→ `plugins/audit-log/manifest.json`（配置化的那份规则）→ `agent.js:133-203`（两个触发点接在主循环哪里）→ `main.js:44-47`（装配三行）→ `test.js`（怎么验证）。

## 本章增量（相对第 7 章）

| 位置 | 改了什么 |
|---|---|
| 新增 `hooks/hook_registry.js` | 65 行，Hooks 框架：两个事件、注册/触发/卸载 |
| 新增 `plugins/audit-log/plugin.js` + `manifest.json` | 150 行，"真实价值插件"的完整实现与清单 |
| `agent.js` | +20 行（198 → 218）：构造注入 `hooks`（`agent.js:55`）、Loop 检测改成逐条回填（`agent.js:138-160`）、执行前 firePreToolUse（`agent.js:163`）、执行后 firePostToolUse 并用返回值（`agent.js:181`） |
| `agent.js` 上下文预算 | 第 6 章带过来的 `maxTokens: 4096 / reserveForOutput: 512`（水位线只有 2867）本章改回第 5/7 章的 `40960 / 5120`（水位线 28672）。实跑 `countTokens`：本章注入后的 system 提示 469 token，加两个满额工具结果（截断上限 1000）就压过旧水位线 |
| `main.js` | +23 行（101 → 124）：装插件、注入 hooks、`/plugins`、`/audit`、`/audit-summary` 三个元命令、退出时 `uninstallAudit()` |
| `main.js` 分支修复 | `/audit-summary` 原先被 `line.startsWith("/audit")` 抢先命中，summary 分支是死代码，改成 `line === "/audit" \|\| line.startsWith("/audit ")`（`main.js:74`） |
| `test.js` | 7 → 10 个用例：补 3 个回归用例（Loop 回填配对、Post 改写生效、子 Agent Loop 回填） |
| `skill_store.js` / `skill_tool.js` | 与第 7 章各差一处非功能差异：多一个 `ensureSkillsDir()` 测试初始化助手、一行头注释 |

插件对 Agent 的侵入面只有三处：一个构造参数、一个执行前调用、一个执行后调用。工具、权限、上下文、记忆、委派、技能六套机制一个都没动——这是"横切扩展"在账面上的证据。

## 本章刻意不做的事（缺口 = 后续课程路线图）

| 缺口 | 后果 | 在哪一章补 |
|---|---|---|
| 钩子没有错误边界与超时 | 插件内部抛异常会直接炸掉主流程；`audit-log` 的静默只保护了它自己 | 生产要给每个钩子包 try/catch + 超时；第 13 章的重试与观测是同一类工程化 |
| 只有两个生命周期事件 | SessionStart / UserMessage / ModelResponse / PermissionDenied / ToolError 都没有挂点，输出侧脱敏无处可挂 | 第 13 章观测；事件集按需扩，Qwen Code hooks 即此思路 |
| `manifest.json` 不驱动加载 | 清单只是文档，`loadAuditLogPlugin()` 把危险规则硬编码在代码里；装新插件要改 `main.js` | 生产做 `plugins/` 目录扫描 + manifest 驱动的插件发现 |
| 被拦截的调用也计入 Loop 检测 | `_checkLoop` 在钩子之前跑，同一危险命令调 3 次先报 `LOOP_DETECTED` 而不是 `HOOK_BLOCKED` | 本章保留（教学可接受）；生产把两个计数器解耦 |
| 插件之间没有优先级与顺序声明 | 多个 pre 钩子只有"注册顺序"一种语义，谁先拦没有显式约束 | 生产在 `add` 上加 priority 字段并排序 |
| 审计只在内存 + 本地文件 | 进程重启丢内存态，多实例各写各的 `audit.log`，无法汇总查询 | 第 13 章 telemetry；生产用 OpenTelemetry + 集中式日志 |
| 没有插件沙箱 | 插件与框架同进程同权限，恶意插件可读写任意文件 | 未排课；生产用进程隔离或权限声明 |
| REPL 的元命令分发不可测 | `main.js` 导入即启动读循环，命令分发没抽成函数，所以"`/audit-summary` 曾是死代码"这处修复没有自动化用例兜底 | 生产把命令分发与终端 IO 分离，或补伪终端冒烟测试 |

## 测试覆盖（10 个用例，全部可离线跑）

| 用例 | 行号 | 验证什么 |
|---|---|---|
| HookRegistry：pre 拦截 + post 改写 + 卸载 | `test.js:32` | add 返回的移除函数真的生效；pre 短路、post 依次执行 |
| 插件：危险命令被拦截（可配置规则） | `test.js:46` | `rm -rf /` → blocked，`ls -la` 放行 |
| 插件：敏感参数脱敏 | `test.js:71` | `api_key: sk-secret123` → 记录里 `"***"`，整份记录不含原值 |
| 插件：调用留痕 + 结果状态（query） | `test.js:88` | 4 条记录（call + result(ok) + call + result(error)），按工具过滤生效 |
| 插件：summary 使用统计 | `test.js:113` | calls=2 / errors=1 / blocked=1 精确计数 |
| 插件：install 返回卸载函数 | `test.js:135` | 卸载后 records 不再增长 |
| Agent + audit-log 插件：端到端拦截与留痕 | `test.js:150` | 模型收到 `HOOK_BLOCKED`，审计里出现 blocked 事件 |
| Loop 检测触发后，同一响应的剩余 tool_calls 也逐条回填 | `test.js:218` | 配对校验（`test.js:204`）：一条 assistant(tool_calls) 里每个 id 都有对应 tool 消息，且没有孤儿 tool 消息 |
| PostToolUse 改写的结果被回填给模型 | `test.js:268` | 钩子替换 `payload.result` 后，模型拿到的是替换后的内容 |
| 子 Agent：Loop 判定后同轮剩余 tool_calls 也逐条回填 | `test.js:319` | 子 Agent 侧同一处缺陷的回归，父子行为一致 |

本章的 10 个用例只覆盖本章增量。第 7 章带过来的 22 个根目录源文件（工具、执行流水线、上下文、记忆、委派、技能的注册与触发部分）保持逐字节不变（`skill_store.js`、`skill_tool.js` 各差一处，见增量表），它们的回归证据仍在 `lesson07-skill/test.js` 的 17 个用例里——面试被问"怎么证明没退化"，准确答案是"改了哪三个文件、那三个文件自己的用例怎么跑"，而不是"我全测了"。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 模型收到 `HOOK_BLOCKED` 但危险命令看着还是被跑了 | 钩子拦的是"执行"，不是"模型输出"。模型可能会换一条命令继续试，第二、三次也会被同一规则拦下 |
| 同一危险命令试三次，第三次报的是 `LOOP_DETECTED` | 计数在钩子之前（`agent.js:147-149` 的 `_checkLoop` 先于 `agent.js:163` 的 `firePreToolUse`），这是本章明说的取舍 |
| 自己写的 post 钩子改了结果，模型却看到旧内容 | 检查是不是`payload.result = ...` 替换写法；本章已改成取 `firePostToolUse` 返回值（`agent.js:181`），原地改 `payload.result.x` 两种写法都有效 |
| `/audit-summary` 打印的是一串记录 | 修复前的 bug（`startsWith("/audit")` 前缀吞掉）；本章已修，见 `main.js:74` |
| 插件卸载没生效 | `install()` 返回的函数每调一次摘掉一组钩子；同一个插件 `install` 两次就有两组钩子，要分别卸载（`plugin.js:92-98`） |
| 审计日志文件在哪 | `plugin.js:135` 默认写进程工作目录下的 `audit.log`，每行一条 JSON；同时内存里保留 `records` 供 `query/summary` |
| `[错误] ...` 或连接失败 | `env.json` 的 key / base_url / model 没配好；model 值不要带尾空格 |
| 真实模型不肯执行 `rm -rf` | 正常：模型自身的安全对齐会先拒绝或绕开。插件拦的是"模型真的发出这条命令"的情况，两层防线不是一回事 |

## 文档导航

- **教程**：`docs/course.md` —— 为什么需要钩子点、插座与电器怎么分工、两个 bug 怎么暴露怎么修、真实运行记录与用例表
- **面试**：`docs/interview.md` —— 10 题三层（T1 基础 / T2 工程深度 / T3 架构设计），每题带考点、答题结构、话术、真实行号锚点与追问
