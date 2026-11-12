# lesson01-minimal-agent · 最小 Agent 循环

**一句话定位**：4 个源文件、206 行代码、零第三方依赖——跑通 Agent 的完整闭环（LLM 自己决定调哪个工具、调几轮）。

这一章是全书的地基：后面 12 章（工具系统、上下文管理、记忆、多 Agent、MCP、IM 接入、定时任务、生产化）都是在这 206 行上长出来的。

**本章主教程**：[每次请求到底发生了什么](docs/request-response-walkthrough.md)——按请求和响应的顺序，配合 `agent.js`、`llm.js`、`tools.js` 讲清 `tools`、`tool_calls`、`role` 和工具执行顺序。

## 学完这一课，你应该能做到

- 不看代码，画出 Agent 主循环（想 → 做 → 看结果 → 再想）
- 说清 Function Calling 协议一次往返的三段报文（tools 声明 → tool_calls → role:"tool" 回填）
- 解释为什么 `messages` 数组就是"记忆"，以及它的必然代价（上下文膨胀）
- 亲手跑通 10 个测试用例（**不需要 API key**）并说清每一个在验证什么；指出本课故意留下的两个缺口（工具异常未捕获）及为什么留

## 前置要求

- Node ≥ 18（本课用内置 `fetch` 直接调 HTTP，这就是"零依赖"的来源）
- **跑测试不需要任何 API key**；只有真实对话（`node main.js`）才需要模型服务

## 快速开始

### 先跑测试（推荐第一步，不需要任何配置）

```bash
cd lesson01-minimal-agent
npm test
```

期望输出：10 个用例全绿，约 40ms。测试用"脚本化 LLM 响应"的方式驱动主循环，不联网、不花 token。

### 真实跑一次（需要 OpenAI 兼容端点）

本课直接读环境变量（**第 2 章起改用 env.json**，因为密钥不该出现在命令行历史里）：

```bash
export OPENAI_API_KEY=你的key
export OPENAI_BASE_URL=http://你的推理服务/v1     # vLLM / SGLang / Xinference / OpenAI 都行
export OPENAI_MODEL=qwen38-27b

node main.js
```

期望输出（`Round N` 就是循环转的圈数）：

```
Round 0: {"role":"assistant","content":null,"tool_calls":[{"id":"call_1",...,"function":{"name":"get_city","arguments":"{}"}}]}
Round 1: {"role":"assistant","content":null,"tool_calls":[{...,"function":{"name":"get_weather","arguments":"{\"city\":\"北京\"}"}}]}
Round 2: {"role":"assistant","content":"北京今天晴 25°C，推荐烤鸭"}
Final Result: 北京今天晴 25°C，推荐烤鸭
```

三轮：查城市 → 查天气 → 给答案。**顺序是模型自己推理出来的**，代码里没有任何"先调 get_city"的指令——这就是 Agent 和"调一次 API"的区别。

## 文件地图

```
lesson01-minimal-agent/
├── llm.js         57 行   模型层：fetch 直连 /chat/completions（怎么"说话"）
├── tools.js       94 行   工具层：工具说明书 TOOLS（给模型看）+ 执行器 call_tool（给框架用）
├── agent.js       48 行   ★ 主循环：想 → 做 → 回填 → 再想（本课 80% 的考点在这）
├── main.js         7 行   入口：调 run_agent() 并打印结果
├── test.js       181 行   10 个用例（mock fetch，无需 key）
├── package.json          type: module（ESM）+ npm test / npm start
└── docs/
    ├── request-response-walkthrough.md  主教程：逐次请求/响应 + 关键代码导读
    ├── course.md        延伸教程：运行机制 / 逐文件讲解 / 动手练习 / 下一章
    ├── interview.md     面试：10 题（考点 / 答题结构 / 话术 / 代码锚点 / 追问）
    └── video-script.md  教学视频脚本：4 集，含画面安排与可配音旁白
```

**推荐学习顺序**：先读 [`docs/request-response-walkthrough.md`](docs/request-response-walkthrough.md)，再按 `llm.js`（怎么发请求）→ `tools.js`（工具说明和执行器）→ `agent.js`（怎么循环）→ `main.js`（怎么启动）的顺序对照代码，最后读 `test.js`（怎么验证每次请求）。

## 本章增量

本课是起点，没有"上一章"：4 个源文件全部从零写起。往后每一章都是"上一章全部代码 + 新增能力"，同样的文件会逐章长大。

## 本课刻意不做的事（缺口 = 后续课程路线图）

| 缺口 | 后果 | 在哪一课补 |
|---|---|---|
| 工具异常未捕获 | 模型传个假表外的城市，进程直接崩（实测） | 第 2 章：结构化错误回传 |
| 无 `response.ok` 检查 | API 返回 401/500 时报看不懂的 TypeError | 第 2 章起、第 13 章做成重试+熔断 |
| 无超时 / 重试 | 模型服务挂了就僵住 | 第 13 章 |
| 工具硬编码在源码里 | 加一个工具要改核心文件 | 第 2 章：ToolRegistry 动态注册 |
| 无 system prompt | 没有角色设定与行为边界 | 第 2 章起 |
| 记忆 = 无限增长的数组 | 长会话撑爆上下文窗口 | 第 3 章 |
| 只有轮数保险丝 | 烧钱无感知（无 token/成本预算） | 第 2 章 + 第 13 章 |
| 无流式输出 | 用户干等整句生成完 | 第 13 章 |

## 测试覆盖（10 个用例，全部可离线跑）

| 用例 | 验证什么 |
|---|---|
| 正常路径 | 循环正好 3 轮；`tool_call_id` 与 assistant 消息配对；最终返回 content |
| 一轮多个 tool_calls | 顺序执行、按 id 一一回填（p1/p2） |
| content + tool_calls 同时出现 | 以 tool_calls 为准继续循环（不提前结束） |
| 自定义输入 | 输入作为第一条 user 消息；tools 说明书每轮都带 |
| MAX_ROUND 拦截 | 每轮都调工具时，**精确在第 10 轮**停下，不多转一轮 |
| TOOLS 说明书 | 三个工具名、required 字段、参数类型 |
| call_tool 正常路径 | 三个工具返回确定性假数据（北京 / 晴 25°C / 烤鸭） |
| 未知工具 | 返回结构化错误而不是抛异常 |
| 缺口①（负向测试） | 假表外的城市 → 抛 TypeError（本课不处理） |
| 缺口②（负向测试） | 非法 JSON 参数 → 抛 SyntaxError（本课不处理） |

负向测试是刻意的：把"本课的缺口"钉死在测试里，第 2 章修好之后，这两个用例会改成断言"结构化错误"——**测试记录了演进**。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `401 Unauthorized` 或看不懂的 `Cannot read properties of undefined` | 本课没做 `response.ok` 检查（见缺口表）；先确认 KEY / BASE_URL / MODEL 三个变量是否正确 |
| 模型一直不调工具，直接编答案 | 工具的 `description` 写太含糊；或模型能力太弱。改描述、换模型试试 |
| 输出一大堆 `Round N: {...}` JSON | 这是教学用的原始报文打印（`run_agent(input, verbose)` 的第二参数，传 `false` 可关） |
| `EADDRNOTAVAIL` / 连接超时 | BASE_URL 写错（漏了 `/v1`、用了 https 打 http 端口等） |
| 想让每次输出都一样 | 本课假数据已经写成确定性的（不是随机数），输出稳定可复现 |

## 文档导航

- **主教程**（逐次拆解请求、响应、工具匹配、消息角色和关键代码）：[`docs/request-response-walkthrough.md`](docs/request-response-walkthrough.md)
- **教程**（含运行机制、逐文件讲解、动手练习和下一章预告）：`docs/course.md`
- **面试**（10 题讲解：考点 / 答题结构 / 话术 / 代码锚点 / 追问）：`docs/interview.md`
- **视频脚本**（4 集：普通问答、工具调用请求、本地执行与回填、最终回答和代码走读）：[`docs/video-script.md`](docs/video-script.md)
- **课件和视频**（23 页 PPT、4 段 MP4、SRT 与独立音轨）：[`docs/media/README.md`](docs/media/README.md)
