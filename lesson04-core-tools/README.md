# lesson04-core-tools · 高杠杆核心工具

**一句话定位**：给前面三章那副会循环、会调工具、会管上下文的骨架装上真正的手——代码执行、文件读写、目录探索、内容搜索、联网取数五个能力，收敛成 6 个工具、390 行新代码。

前 3 章的工具都是假的（`get_weather` 返回写死的天气）。真实任务里没有"查天气 API"这么单一的能力，模型需要的是能读、能搜、能跑命令的手。这一章把玩具换成真的，顺手把"危险动作要人点头"这条线接到终端上。

## 学完这一章，你应该能做到

- 说清"高杠杆工具"的含义：为什么真实 Agent 收敛到 6 个工具，而不是堆 60 个专用工具
- 讲透 `run_shell` 的五层锁（黑名单只防呆不防攻击，真正的边界是沙箱），并解释 `fetch_url` 这个 GET 工具为什么算 write 级：权限按风险分，不按语义分
- 复述一次工具调用的完整流水线：注册表查找 → 解参 → 权限门 → 参数校验 → 执行 → 错误分层
- 亲手跑通 19 个测试用例（**不需要 API key**），说清每个验证什么，以及那两条"配对完整性"用例钉住的是哪类线上 400

## 前置要求

- Node ≥ 18（`AbortSignal.timeout`、`node:test`、内置 `fetch` 都要它）
- 跑测试不需要任何 API key；只有真实对话（`node main.js`）需要模型服务
- 建议先读完第 2 章（工具系统）和第 3 章（上下文管理）：本章的框架文件直接从它们继承，讲的是"加了什么"，不重复讲注册表和压缩算法

## 快速开始

### 先跑测试（推荐第一步，不需要任何配置）

```bash
cd lesson04-core-tools
npm test
```

期望输出（实测）：

```
ℹ tests 19
ℹ pass 19
ℹ fail 0
ℹ duration_ms 257.364625
```

测试真的会执行 `echo`、`sleep 2`（用一个 200ms 的超时把它掐掉）、读写 `/tmp`、在 `demo/` 里搜 `TODO:`，只有 `fetch_url` 一条用 mock 顶替网络。

### 真实跑一次（需要 OpenAI 兼容端点）

在本目录放 `env.json`（已在 `.gitignore` 里）：`{"OPENAI_API_KEY":"...","OPENAI_BASE_URL":"http://你的推理服务/v1","OPENAI_MODEL":"..."}`，然后：

```bash
node main.js
```

这是一个 REPL，不是一次性脚本。输入一句自然语言，模型自己决定调哪些工具：

```
你> 统计 demo 目录下含 TODO: 标记的行数（用 shell 统计，不要写文件）。

  ⚠️  危险操作确认: run_shell({"command":"grep -r \"TODO:\" demo/ 2>/dev/null | wc -l; ..."})
  批准? (y=一次 / a=始终允许 / n=拒绝): y
  [tool] run_shell({...}) -> {"result":{"stdout":"       5\n---files---\ndemo/README.md\n...
agent> demo 目录下共有 **5 行** 含 `TODO:` 标记，分布在 `demo/README.md`、`demo/utils.js`、`demo/app.js` 三个文件中。
```

`run_shell` 是 danger 级，所以会停下来问你。read 级的工具（读文件、搜内容、列目录）不问，直接执行。元命令有四个：`/help`、`/budget`（打印 token 账本）、`/reset`（清空上下文）、`/exit`。

## 文件地图

```
lesson04-core-tools/
├── core_tools.js       128 行  ★ 翻译层：6 个工具 → schema + 权限等级，统一注册
├── tools/               262 行  ← 本章新增的全部"手"
│   ├── shell.js         68 行    run_shell：黑名单 + 超时 + 输出上限
│   ├── filesystem.js    66 行    read_file / write_file / list_files
│   ├── search.js        93 行    search_files：grep + glob 合一
│   └── fetch.js         35 行    fetch_url：HTTP GET，截断，超时
├── agent.js            126 行  ★ 主循环（继承第 3 章，本章只改了 Loop 分支一处）
├── registry_full.js     86 行    完整执行流水线（继承第 2 章）
├── registry.js          72 行    v1 版注册表，作对照读
├── permissions.js       72 行    权限三档 + 三态确认（继承）
├── validation.js        89 行    参数按 schema 校验 + 宽容转换（继承）
├── errors.js            70 行    错误码 + ToolError 结构化结果（继承）
├── context_manager_v2.js 144 行  三层上下文 + 水位线 + 工具结果截断（继承第 3 章）
├── summary_compactor.js 63 行    LLM 摘要压缩（继承第 3 章）
├── context_manager.js   73 行    分层截断，v3 对照件（继承）
├── sliding_window.js    44 行    滑动窗口，负面对照件（继承）
├── token_counter.js     57 行    token 估算（继承）
├── llm.js               51 行    从 env.json 读配置，fetch 直连 /chat/completions（继承）
├── main.js             112 行  ★ 交互式 REPL + 终端三态确认
├── test.js             276 行    19 个用例
├── demo/                         三个含 TODO 标记的示例文件，供真实任务用
├── report.md             6 行    真实跑出来的产物（见"常见问题"）
├── env.json                      API 配置，不进 git
└── package.json                  type: module + npm test / npm start
```

**推荐阅读顺序**：`core_tools.js`（先看这一章给了模型哪 6 个工具、各自什么等级）→ `tools/shell.js` → `tools/filesystem.js` → `tools/search.js` → `tools/fetch.js`（四个实现，随便挑顺序，都只有几十行）→ `agent.js`（工具怎么被主循环调用）→ `main.js`（怎么装配起来、确认怎么问）→ `test.js`（怎么验证）。

继承来的那批文件（`registry*`、`permissions`、`validation`、`errors`、`context_manager*`、`token_counter`、`sliding_window`、`summary_compactor`、`llm`）第 2、3 章已经逐行读过，这里只需要 `registry_full.js` 的 `execute()` 有印象：工具调用的一切都要过它。

## 本章增量（相对第 3 章）

新增 5 个文件、390 行：`tools/` 下 4 个实现（262 行）+ `core_tools.js` 翻译层（128 行）。`demo/` 是新加的三个示例文件。

11 个继承文件与第 3 章**逐字节相同**（`context_manager_v2.js`、`context_manager.js`、`summary_compactor.js`、`token_counter.js`、`sliding_window.js`、`llm.js`、`registry.js`、`registry_full.js`、`permissions.js`、`validation.js`、`errors.js`）——换掉全部工具，框架一行没动。

改动的两处，都写在这里：

| 文件 | 改动 | 为什么 |
|---|---|---|
| `main.js` | 从"跑一个写死的任务就退出"改成 REPL | 工具变真之后，一次对话做不完一件事；REPL 让同一个 `cm` 跨轮复用（多轮记忆的来源） |
| `agent.js` | Loop 检测分支：`break` → `continue` + `loopDetected` 标志（第 69-96 行） | 继承来的缺陷：一条响应里多个 `tool_calls` 时，判死循环后剩下的调用不回填 → 下一轮 `assistant(tool_calls)` 与 `tool` 配对断裂 → API 400。`test.js` 第 237 行的用例钉住它 |

删除的文件：`tools_demo.js`（第 2/3 章的 5 个玩具工具：假天气、假日志、笔记增删查）。

## 本课刻意不做的事（缺口 = 后续课程路线图）

| 缺口 | 后果 | 在哪一章补 |
|---|---|---|
| `child_process` 不是沙箱 | 恶意命令逃逸即拿到宿主权限 | 第 13 章讲部署与隔离边界；代码里只留注释（`tools/shell.js` 第 13-14 行） |
| 未声明等级的工具默认 read（fail-open），见 `permissions.js` 第 51 行 | 新注册工具忘写等级 = 自动放行 | 第 6 章（子 Agent 也要注册工具，注册路径变多） |
| 工具结果内联进上下文 | 连续读几十个文件的场景仍然会吃光预算 | 第 5 章换思路：知识放到上下文之外按需取 |
| 无流式、无取消、无重试 | 模型慢就干等，服务抖一下整轮失败 | 第 13 章 |
| 无持久化 | 关掉进程记忆归零，`/reset` 即全丢 | 第 10 章（会话保存与恢复） |
| 执行中不可打断，工具串行执行 | 长任务卡住没法干预 | 第 11 章（网关与审批流）、第 13 章 |
| 搜索是教学实现：不读 `.gitignore`、单线程、无二进制保护 | 大仓库慢且噪音多 | 不单独开章；生产换 ripgrep，函数签名不变（`tools/search.js` 第 28 行） |
| 网络出向无白名单，`fetch_url` 只是"确认"不是"防护" | 提示注入可以诱导请求内网/云元数据 | 第 13 章 |
| 无审计日志 | 事后答不出"谁在什么时候执行了什么命令" | 第 8 章（audit-log 插件） |

## 测试覆盖（19 个用例，全部离线可跑）

| 用例 | 验证什么 |
|---|---|
| `run_shell 执行正常命令`（`test.js:21`） | `echo` 的 stdout 与 `exitCode === 0` |
| `run_shell 拦截危险命令`（`test.js:27`） | `rm -rf /` 命中黑名单，返回 `blocked: true` |
| `run_shell 超时返回 timeout 标记`（`test.js:33`） | `sleep 2` 配 200ms 超时 → `timeout: true`，模型能区分"跑太久"和"写错了" |
| `write_file + read_file 往返`（`test.js:41`） | 写 `/tmp` 再读回，内容一致 |
| `read_file 大文件只回 head + 分页提示`（`test.js:50`） | 60KB 文件 → `truncated`、`head` 2000 字符、hint 让模型改用 shell 分页 |
| `read_file 不存在文件返回错误`（`test.js:61`） | 读失败返回 `{error}` 而不是抛异常 |
| `list_files 返回目录结构`（`test.js:66`） | `demo/` 下能列出 `app.js`、`utils.js` |
| `list_files 不传 dir_path 时默认当前目录`（`test.js:73`） | `dir_path` 非必填、默认 `.`（描述与 schema 一致） |
| `search_files 搜索 demo 目录的 TODO 标记`（`test.js:83`） | 精确匹配 `TODO:` → `app.js` 命中 3 条 |
| `search_files 按文件名通配过滤`（`test.js:92`） | `*.js` 过滤掉 `README.md` |
| `search_files 文件名通配支持 ? 单字符`（`test.js:98`） | `app.j?` 能命中 `app.js`（转义顺序修复的回归） |
| `fetch_url 返回内容（mock fetch）`（`test.js:106`） | 临时替换 `globalThis.fetch`，联网工具离线可测 |
| `core_tools 注册 6 个工具`（`test.js:124`） | `getSchemas().length === 6` |
| `core_tools 权限分级：run_shell 是 danger`（`test.js:129`） | 拒绝时 `PERMISSION_DENIED`，批准后能执行 |
| `（负向）未声明等级的工具默认 read：本课刻意留的缺口`（`test.js:139`） | 钉住 fail-open 缺口：用户全拒也不影响未定级工具放行 |
| `Agent 用核心工具完成搜索+写报告任务`（`test.js:148`） | 端到端：一次工具 + 一次收尾，两次推理都带 6 个 schema |
| `交互式多轮：第二轮能看到第一轮上下文`（`test.js:184`） | 第二轮请求里含第一轮的"小明"——把"记忆"测出来 |
| `compact 切点落在 tool 消息上也不拆散配对（回归 API 400）`（`test.js:207`） | 第 3 章的切点修复在本章仍有效（跨章回归） |
| `Loop 检测触发时，同一响应里剩余 tool_calls 仍逐条回填`（`test.js:237`） | 每个 `tool_call` 都有配对的 `tool` 消息，不产生孤儿调用 |

新增的 5 条用例里，第 139 行是负向用例（把 fail-open 缺口钉住，后续课程收口时会变红），第 207 行是继承来的跨章回归（第 3 章的压缩切点修复），第 73、98、237 行对应本章修掉的三处缺陷。把这三处修复逐一还原后重跑，第 73、98、237 行确实失败（16 通过 / 3 失败），改回后 19 全绿。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `PERMISSION_DENIED … 无确认通道，默认拒绝` | `buildCoreTools()` 不传 confirm 时（脚本/后台场景）write、danger 一律拒。交互式运行用 `main.js`，它注入了 `cliConfirm` |
| 模型不喊 `run_shell`，自己换搜索 | 正常，实测会这样：没有确认通道时它撞一次墙就改用 read 级工具 |
| `工具参数不合法: 缺少必填参数 \`file_path\`` | 模型漏参，校验层拦下并回灌，模型下一轮自己补 |
| 搜 `TODO` 比别人多出几条 | 不带冒号会命中注释里的"TODO 标记"这类文字。`search_files("TODO:")` 更精确；`demo/` 下严格匹配是 5 条 |
| `report.md` 里的计数是 7，模型回答是 5 | `report.md` 是松散匹配（不带冒号）那次真实运行留下的产物，7 = app.js 4 + utils.js 2 + README.md 1；同一目录下带冒号精确匹配是 5 |
| `{"url":"...","error":"fetch failed"}` | 域名解析不了或网络不通时，`fetch_url` 自己 catch 后返回 `{error}`，文案来自 Node 的 `fetch failed` |
| `/dev/null` 读出来是空的 | 正常，它不是文本文件；用例里换成"文件不存在"来验证错误路径 |
| 想让每次输出一致 | `demo/` 的示例数据是固定的，但模型的措辞不会固定；跑测试才有确定性输出 |

## 文档导航

- **教程**（这一章做什么 / 六个文件 / 一次调用过几道门 / 逐文件讲代码 / 报文时序 / 下一章）：`docs/course.md`
- **面试**（10 题：考点 / 答题结构 / 参考话术 / 代码锚点 / 常见追问）：`docs/interview.md`