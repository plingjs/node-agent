# lesson11-gateway · 消息网关（QQ 机器人 + 多通道）

**一句话定位**：新增 8 个文件 1052 行，把 Agent 的入口从终端 REPL 换成一个平台无关的消息网关——QQ 用户私聊机器人就是对话，每个用户一个独立会话，危险工具在聊天里用「1 / 2 / 3」审批，终端和 QQ 同时在线互不影响。

前 10 章的入口一直是终端。真实用户不开终端，他们在 IM 里发消息，所以这一章写的是**入口层**：把「收发消息 + 平台鉴权 + 协议细节」收进 `gateway/`，中间加一层桥接负责会话路由，Agent 本体不动。QQ 是第一个适配器，企微、钉钉按同一抽象再加一个子类。

## 学完这一章，你应该能做到

- 画出 Gateway / Bridge / Agent 三层，说清统一消息模型里每个字段（`channelId` / `userId` / `text` / `msgId`）为什么必须存在
- 解释 Node 内置 WebSocket 为什么接不上 QQ（握手阶段就要带鉴权头），手写的 `gateway/ws_client.js` 怎么补上这一段：TLS → HTTP Upgrade → 帧解析 → 掩码 → ping/pong
- 说清 IM 审批流的死锁点（等确认的 `agent.run` 正占着串行队列），以及两个绕开它的细节：确认回复不进队列、pending 先注册再发消息
- 讲清「单 Agent 实例 + 上下文切换」怎么做到多用户隔离，以及记忆为什么是**刻意共享**而对话上下文是**刻意隔离**的

跑通 25 个用例并说清每个钉住什么（新增 3 个：主 Agent 与子 Agent 的防失控回归、QQ 全链路握手到群回复），能对着 `verify_qq.js` 讲一遍从「连不上」到「READY」的排查顺序。

## 前置要求

- Node ≥ 18（本章只用到 `node:tls` / `node:net` / `node:readline/promises` / 内置 `node:test`，零第三方依赖）
- 跑测试**不需要任何配置**；真实对话需要 OpenAI 兼容端点；接 QQ 需要 QQ 开放平台的机器人凭证
- 建议先读完第 10 章：本章的桥接层直接复用它的 `SessionManager` 与 `session_state.js`

QQ 凭证和 LLM 配置放在同一个 `env.json`（章节目录下，不要提交进 git）。**注意 `QQ_SECRET` 是机器人 appsecret，不是 token**——`main.js:88` 会先拿 appid + secret 去 `POST /app/getAppAccessToken` 换一次 access_token（有效期 7200 秒）；老版自带 token 的机器人可以改用 `QQ_TOKEN` 直连（两条路径都在 `main.js:32-47`）。

```json
{
  "OPENAI_API_KEY": "你的key",
  "OPENAI_BASE_URL": "https://你的推理服务/v1",
  "OPENAI_MODEL": "qwen38-27b",
  "QQ_APPID": "你的机器人appid",
  "QQ_SECRET": "你的机器人appsecret"
}
```

两个 QQ 字段都留空时，`main.js:93-95` 只启用终端通道，程序照常能跑。

## 快速开始

### 1. 先跑测试（第一步，不需要配置）

```bash
cd lesson11-gateway
npm test
```

```
ℹ tests 25
ℹ suites 0
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 901.596
```

全程离线：LLM 是注入的假函数，QQ 用 `MockGateway`（记录发送内容）和本地假 WS server（`test.js:390`，真握手真解帧）替代，不联网、不花 token、不需要机器人凭证。

### 2. 真实跑一次（双通道）

```bash
node main.js
```

配好 `env.json` 后启动会依次打印（终端通道一定会出现，QQ 行取决于凭证）：

```
[gateway] 使用 appid+secret 换取 access_token...
[qq] WebSocket 握手成功，等待 HELLO...
[qq] 鉴权成功，机器人已就绪
[gateway] QQ 机器人已上线（appid: ...）
[approval] 权限确认在对应通道交互（QQ 消息 / 终端输入；超时 60s 自动拒绝）
[session] 终端会话命令：/sessions /new /use <id> /delete <id>
[bridge] 通道已接入（LLM: ...）
[terminal] 终端通道已启动（输入 /help 查看命令；/exit 退出）
在终端直接输入即可对话；QQ 用户消息同样处理，互不影响。
```

在终端输入 `看看磁盘占用`，模型会调 `run_shell`（danger 级），确认请求打印在终端：

```
  ⚠️  危险操作确认: run_shell({"command":"df -h"})

[agent] ⚠️ 需要你的批准：
工具：run_shell
参数：{"command":"df -h"}

回复：1 (批准) / 2 (拒绝) / 3 (始终允许)
```

输入 `1` 之后 Agent 继续跑完并回复结果。QQ 里私聊机器人走的是同一条链路，只是确认请求发到 QQ 消息里，回复也是 `1 / 2 / 3`。

### 3. 只想确认 QQ 通不通

```bash
node verify_qq.js     # 换 token → 握手 → READY，成功即退出（10 秒超时保护）
```

`DEBUG_WS=1 node main.js` 会打印握手响应头和原始帧，QQ 服务端的错误文本（`Authentication fail` / `invalid intents`）直接指路，这是排查连接问题最快的一步。

## 文件地图

本章只列新增与改动的文件；其余 29 个源文件从第 10 章原样带过来，零改动（`mcp/` 三个文件只差文件头注释里的一处课号）。

```
lesson11-gateway/
├── gateway/
│   ├── gateway.js         42 行   抽象接口：connect / onMessage / send / close + 统一消息模型
│   ├── ws_client.js      253 行   ★ 手写 WebSocket 客户端（TLS/Upgrade/帧/掩码/ping-pong）
│   ├── qq_gateway.js     286 行   ★ QQ 官方机器人：换 token、握手、心跳、事件解析、被动回复
│   ├── mock_gateway.js    39 行   本地替身（测试与无凭证演示），同一抽象接口
│   └── terminal_gateway.js 159 行  终端通道：readline 循环 + /命令 + 打字机收尾
├── approval_flow.js      120 行   ★ IM 审批流：确认请求发到通道，三态回复，超时自动拒绝
├── agent_bridge.js       129 行   ★ 桥接：channelId → 会话、串行队列、确认回复绕过队列
├── main.js               167 行   组装：组装 Agent、两个通道 attach 到同一 bridge、终端命令
├── verify_qq.js           24 行   连接自检（换 token → 握手 → READY，成功即退出）
├── agent.js              212 行   主循环（本章修：Loop 判定后仍逐条回填 tool 消息）
├── subagent.js           167 行   子 Agent（与 agent.js 同一处 Loop 回填，同族缺陷）
├── llm.js                 69 行   模型调用层（改：加 60s AbortController 超时）
├── test.js               803 行   25 个用例（改：新增 3 个用例，修 1 处竞态）
├── package.json                   name / description 改名
└── docs/
    ├── course.md                 教程：为什么需要网关 / 逐文件讲代码 / 真实往返 / 下一章
    └── interview.md              10 题三层：考点 / 答题结构 / 话术 / 代码锚点 / 追问
```

**推荐阅读顺序**：`gateway/gateway.js`（抽象定在哪）→ `gateway/mock_gateway.js`（最小的实现长什么样）→ `gateway/ws_client.js`（协议层）→ `gateway/qq_gateway.js`（平台细节）→ `approval_flow.js`（审批）→ `terminal_gateway.js`（第二通道）→ `agent_bridge.js`（三者接起来）→ `main.js`（组装）→ `test.js`。

**从第 10 章原样继承的 29 个源文件**（本章不动它们）：`agent_tool.js` / `context_manager_v2.js` / `context_select.js` / `core_tools.js` / `depth_guard.js` / `errors.js` / `extract.js` / `memory_entries.js` / `memory_manager.js` / `memory_store.js` / `parallel.js` / `permissions.js` / `recall.js` / `registry.js` / `registry_full.js` / `session_manager.js` / `session_state.js` / `skill_registry.js` / `skill_store.js` / `skill_tool.js` / `skill_trigger.js` / `summary_compactor.js` / `token_counter.js` / `validation.js` / `tools/`（shell、filesystem、search、fetch）/ `hooks/hook_registry.js`。

## 本章增量（相对第 10 章）

| 位置 | 改了什么 |
|---|---|
| 新增 `gateway/` 五个文件 | 779 行，网关抽象 + 手写 WS 客户端 + QQ 实现 + 本地替身 + 终端通道 |
| 新增 `approval_flow.js` | 120 行，把权限确认从终端搬进聊天（三态回复 + 超时拒绝 + 按通道路由） |
| 新增 `agent_bridge.js` | 129 行，channelId → 会话映射、串行队列、确认回复绕过队列 |
| 新增 `verify_qq.js` | 24 行，连接自检脚本固化调试路径 |
| 重写 `main.js` | 从「多会话 REPL」变成「多通道组装」：两个 Gateway attach 到同一 bridge，审批流按通道分发 |
| `agent.js` | Loop 判定后仍逐条回填 `role:"tool"`（原来是 `break`，一条响应带多个 `tool_calls` 时会漏回填，下一轮配对断裂） |
| `subagent.js` | 同族缺陷，子 Agent 的 Loop 分支也是 `break`，改成同样的 `loopDetected` + `continue` |
| `gateway/qq_gateway.js` | 群回复端点按「收到过群消息」的记账判断（原来只看 `channelId.startsWith("group")`，真实群 openid 不带这个前缀，回复会打到私聊端点） |
| `llm.js` | `AbortController` 60 秒超时，LLM 挂起时抛可识别错误而不是无限等 |
| `test.js` | 12 → 25 个用例：第 10 章的 12 个换成本章的 25 个，最后 3 条是本次书化时补的防失控回归与 QQ 全链路用例；顺手修掉一个分帧到达才暴露的竞态断言 |
| `package.json` | name / description 改为 lesson11-gateway |

网关这一层没有碰 Agent 内部任何一个机制：工具调度、权限、压缩、记忆、技能、MCP、委派全部原样复用，改动集中在"消息从哪来、回复往哪去"。

## 本课刻意不做的事（缺口 = 后续路线图）

| 缺口 | 后果 | 在哪补 |
|---|---|---|
| access_token 不缓存不刷新 | 7200 秒后过期，长跑进程重连会拿着废 token 反复失败 | 生产：缓存 + 到期前刷新；`getAppAccessToken` 是唯一改动点（`qq_gateway.js:78`） |
| 重连有上限（5 次后放弃） | 网络抖动超过 5 次就彻底掉线，没有恢复路径 | 教学选择；生产改无限退避 + 告警（`qq_gateway.js:196-202`） |
| 没有发送限流 | QQ 官方大约 5 条/秒/机器人，批量回复会被拒 | 生产：发送队列 + 退避；`send()` 里加令牌桶（`qq_gateway.js:245`） |
| 单实例串行队列，吞吐低 | 一条消息处理期间其它用户排队，长任务会堵住所有人 | 第 13 章之后的扩展方向：按 channelId 分片并行 / 每用户独立实例 |
| pending 期间用户的任何回复都当审批决定 | 用户在等确认时问的别的问题会被吞掉（未识别输入按拒绝处理） | 设计取舍：安全默认优先；生产可加"仅短文本/仅数字"判定或让模型兜底 |
| 只有 QQ 一个真实适配器 | 企微/钉钉接入未验证，"平台无关"目前只有两个样本（QQ、终端） | 同一抽象再加子类即可，这是本课刻意留下的扩展点 |
| 没有内容安全与用户体系 | 敏感词不过滤，openid 与企业员工身份没有映射 | 生产必做：审核 + RBAC（谁能用哪些工具） |
| 没有按通道的成本观测 | 不知道哪个用户烧了多少 token | 第 13 章 telemetry 按 channelId 聚合 |
| WebSocket 客户端不做分片重组 | 服务端把一条消息拆成 FIN=0 的续帧时会被当成独立帧（QQ 的文本帧都在单帧内，暂未撞上） | 生产：按 opcode 0x0 续帧聚合，`ws_client.js:193` 的帧处理加状态机 |
| 群通道靠「收到过群消息」记账 | 进程重启后、或首次就主动推送到群时（第 12 章定时任务），群端点判断会退回前缀启发式 | 生产：把 channel 类型持久化到会话元数据，或从平台接口查会话类型 |

## 测试覆盖（25 个用例，全部可离线跑）

| 用例 | 行号 | 验证什么 |
|---|---|---|
| parseDispatch 私聊 C2C | `test.js:53` | channelId / userId / text / type 归一化正确 |
| parseDispatch 群@去前缀 | `test.js:65` | `<@!bot123> ` 被剥掉，channelId 是 group_openid、userId 是 member_openid |
| parseDispatch 新版 C2C 结构 | `test.js:82` | openid 在 `d.author.user_openid`、消息 id 在 `d.id` 时也能解析（真机踩过） |
| parseDispatch 非消息事件 | `test.js:102` | READY / 心跳 / null 都返回 null，不制造假消息 |
| getAppAccessToken 换取成功 | `test.js:108` | 请求体是 `{appId, clientSecret}`，返回 access_token（mock fetch） |
| getAppAccessToken 换取失败 | `test.js:129` | 缺 access_token 时抛错，错误信息带原始响应 |
| QQGateway.send msg_seq 递增 | `test.js:145` | 同一 msg_id 第二次回复 seq=2；主动消息不带 msg_seq（防 40054005 去重） |
| ApprovalFlow 三态 + msgId | `test.js:171` | 确认请求发到网关且带 msgId，回复「批准」→ resolve true |
| ApprovalFlow 始终允许 / 拒绝 / 无关消息 | `test.js:191` | 「始终允许」→ "always"、「拒绝」→ false、无 pending 时返回 false 不消费 |
| ApprovalFlow 超时自动拒绝 | `test.js:211` | 50ms 超时后 resolve false，pending 清空（安全默认） |
| Bridge 集成：确认回复绕过队列 | `test.js:222` | 确认回复被消费、不触发 `agent.run`、网关只发了 1 条消息 |
| MockGateway 基本行为 | `test.js:265` | connect / receive / send 记录可断言 |
| 数字选项 1/2/3 映射 | `test.js:280` | 与确认文案一致：1→true、2→false、3→"always" |
| TerminalGateway 注入与记录 | `test.js:305` | channelId 固定 `terminal`，send 记录可断言 |
| 审批多通道路由 | `test.js:318` | terminal 的确认走终端网关，其它 channelId 走默认网关 |
| 双通道集成 | `test.js:347` | QQ 与终端 attach 到同一 bridge，各回各的，两条独立会话 |
| WsClient 握手 + 帧 + ping | `test.js:448` | 真握手（自建假 WS server）、带鉴权 headers、客户端帧掩码正确、ping 自动回 pong |
| WsClient 握手失败 | `test.js:482` | 非 101 响应触发 error，错误信息含「握手失败」 |
| AgentBridge 全链路 | `test.js:503` | 消息 → Agent → 回复，会话落盘且 system/recent 都在 |
| 多用户会话隔离 | `test.js:525` | 「小明」探针：A 的自我介绍不泄漏给 B，A 自己记得 |
| attach 自动回复链路 | `test.js:557` | gateway 收到消息后自动把回复发回原通道 |
| 串行队列 | `test.js:579` | 3 条并发消息，`maxActive` 不超过 1 |
| 主 Agent：Loop 判定后逐条回填（新增） | `test.js:607` | 一条响应带 2 个 `tool_calls` 且触发 Loop 时，2 条 `role:"tool"` 都回填，assistant/tool 配对不断 |
| 子 Agent：Loop 判定后逐条回填（新增） | `test.js:647` | 同族位置，`subagent.js` 的 `break` 会让每轮漏掉第二个 `tool_calls`（修复前实测漏 8 条），断言 tool_call 与 tool 消息一一对应 |
| QQGateway 全链路（新增） | `test.js:684` | 假 WS server 上跑真流程：握手带 `Authorization` / `X-Union-Appid` → HELLO → IDENTIFY（intents = `1<<25`）→ READY → 群消息归一化 → 群回复打到 `/v2/groups/` |

最后三条是本次书化时补的用例。写文档期间复查 `agent.js` 的 Loop 分支，发现它仍然是第 2/3 章那个老写法（`break`）——一条响应里带多个 `tool_calls` 且第一个就判定死循环时，后面的 `tool_calls` 没有对应的 `tool` 消息，下一轮请求里 assistant 与 tool 的配对断裂，服务端会直接 400。改成 `continue` 加一个 `loopDetected` 闩锁（`agent.js:138-160`）后，先把旧代码恢复回去让用例变红（`actual: undefined, expected: 'tool'`）确认它真能抓到，再改回来跑绿。

同一处缺陷在 `subagent.js` 也有一份——`lesson06` 复制出来时一起带过来了，`npm test` 全绿发现不了（用例只覆盖主 Agent）。修法与主 Agent 相同（`subagent.js:125-150`），补上回归后先跑红：真实失败输出是把 `s2b`、`s3b`…`s8b` 共 8 条 `tool_call` 判成孤儿（`assert.deepEqual` 的 actual 里整列缺失），改成 `continue` 后全绿。

复查 `qq_gateway.js` 还发现一个群回复的端点 bug：`send()` 原来是靠 `channelId.startsWith("group")` 判断群聊，而 QQ 真实的 `group_openid` 和用户 openid 长得一样（都是无前缀 hex），所以群里的回复会被打到私聊端点。修法是从入站事件里记账——`parseDispatch` 认出群@事件时把 channelId 记进 `groupChannels`（`qq_gateway.js:181`），`send()` 先查这本账、再退回前缀启发式（`qq_gateway.js:248`）。同样先跑红（错误端点是 `/v2/users/2C3A2F8B/messages`）确认用例有效，再改回绿。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 连上就断、HELLO 不来、无限重连 | 握手没带鉴权头或凭证不对。先 `DEBUG_WS=1 node main.js` 看握手响应与原始帧，服务端会明说原因 |
| `ERR_TLS_CERT_ALTNAME_INVALID` / 证书是 `*.ias.tencent-cloud.net` | 多租户 IP 上 SNI 没发出去。`tls.connect` 必须显式传 `servername`（`ws_client.js:83`），不传时拿的是默认证书 |
| 握手 101 但随后 op 9 `Authentication fail` | 拿 appsecret 当 token 用了。要用 `getAppAccessToken` 换 access_token（`qq_gateway.js:78`），有效期 7200 秒 |
| 连接正常但收不到任何消息 | intents 选错类别。C2C 单聊 + 群@ 要 `1 << 25`，`1 << 30` 是频道消息（`qq_gateway.js:160`）；另外群聊必须 @ 机器人才会推事件 |
| 发送被拒 / 错误码 40054005 | 被动回复缺 `msg_id`，或同一 `msg_id` 的 `msg_seq` 没递增。`send()` 里按 msg_id 维护计数器自动 +1（`qq_gateway.js:254-261`） |
| 群里能收到消息、回复发不出去 | 群端点判断错了（历史 bug：只看 `channelId.startsWith("group")`）。现在按入站事件记账（`qq_gateway.js:181`、`qq_gateway.js:248`）；进程重启后首次直接主动推送到群仍会走前缀启发式 |
| 发送返回 429 或大量失败 | QQ 官方对机器人有频率限制（约 5 条/秒），本课没做发送队列，短时间批量回复会被拒（见缺口表） |
| `[gateway] 未配置 QQ_SECRET，仅启用终端通道（配好可接入 QQ）` | `env.json` 里 QQ 两个字段为空。想只玩终端就忽略；想接 QQ 把 `QQ_APPID` / `QQ_SECRET` 填上 |
| QQ 里回复了 `1` 但 Agent 没动静 | 确认请求已经超时（默认 60 秒）按拒绝处理了；`ApprovalFlow` 的 `timeoutMs` 可调（`main.js:101-104`） |
| `[approval] xxx 拒绝了 run_shell（未识别输入，安全默认）` | 回复的文本不在三态里。只认 `1 / 2 / 3`（也兼容 `y`/`n`/`a` 等旧写法），其它一律按拒绝 |
| `⚠️ 处理失败：LLM 调用超时（60000ms）` | LLM 侧超时，消息被兜底成提示而不是让进程崩掉（`agent_bridge.js:46-52` + `llm.js:43-44`） |
| 测试跑完进程不退出 | 已在 `package.json` 里加 `--test-force-exit` 兜底；WS 测试本身也 `await server.close()` 了 |
| 终端里「你>」在回复之前冒出来 | 第 13 章修过：`TerminalGateway` 用 `waitReplyDone()` 等回复输出完再显示 prompt（`terminal_gateway.js:64-69`） |

## 文档导航

- **教程**：`docs/course.md` —— 为什么需要网关这一层、逐个文件讲代码、一次真实往返的完整输出、下一章
- **面试**：`docs/interview.md` —— 10 题三层（T1 基础 / T2 工程深度 / T3 架构设计），每题带考点、答题结构、参考话术、真实行号锚点与常见追问