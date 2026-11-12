# 第 11 章 · 消息网关（QQ 机器人 + 多通道）—— 面试题讲解（Node 版）

> 10 题，三层深度。每题按固定结构展开：**考点 → 答题结构 → 参考话术 → 代码锚点 → 常见追问**。
> 本章可引用的证据：新增 8 个文件 1052 行（`gateway/` 五个 779 行 / `approval_flow.js` 120 行 / `agent_bridge.js` 129 行 / `verify_qq.js` 24 行）；25 个用例离线全绿（`npm test` 实测 `tests 25 / pass 25 / fail 0 / duration_ms 901.596`）；本章修掉 Loop 判定后漏回填 `tool` 消息的同族 bug 两处（主 Agent + 子 Agent），各配一个回归用例，子 Agent 那份修复前的真实失败输出是 8 条孤儿 `tool_call`（`s2b`…`s8b`）。
> 真实 QQ 连接**本次没有实跑**：`node main.js` 需要真实模型服务和机器人凭证，下面引用的数字全部来自离线用例与假 WS server；Q10 的 6 层踩坑链来自本章开发期的验证记录，只有"`verify_qq.js` 固化自检路径"这一设计可直接在代码里指认。
> 使用建议：T1 三题必须脱口而出；T2 要能讲"我踩过 / 我这么修"；T3 直接对标"0→1 方案设计"。

---

## T1 基础原理（必过线）

### Q1：Agent 接入 IM 之后，架构变成几层？每层管什么？

- **考点**：能不能把"平台细节 / 会话路由 / 业务能力"分开，而不是写一个 `if (平台 === "qq")` 的大函数。
- **答题结构**：三层各一句话 → 统一消息模型的字段为什么必须存在 → 一句话收口。
- **参考话术**："三层，边界按"谁需要知道什么"划。**Gateway** 只认平台：连接、鉴权、心跳、事件解析、发消息，它完全不知道 Agent 是什么（`gateway/gateway.js:19`）。**Bridge** 只认会话：这条消息属于谁、什么时候能处理、处理完存哪（`agent_bridge.js:18`）。**Agent** 一行不改，它拿到的还是一条文本——第 2 到 10 章的能力全部原样复用。中间那层是**统一消息模型**，五个字段各有分工：`channelId` 决定会话归属（私聊是用户 openid，群聊是群 openid，一个群共享一个会话）；`userId` 是'谁发的'，群聊里和 `channelId` 不同，审计和后续权限要用；`text` 是归一化后的正文；`msgId` 是原消息 id，QQ 的被动回复必须带上；`type` 记来源事件，网关自己拿它决定回复走群端点还是私聊端点（`gateway/gateway.js:7-12`）。收益是可验证的：本章终端也实现同一个抽象（`terminal_gateway.js:23`），两个通道 attach 到同一个 bridge，业务代码零改动——这就是适配器模式落到 Agent 架构上的样子。"
- **代码锚点**：抽象定义 `gateway/gateway.js:19-41`（`connect` / `onMessage` / `send` / `close` 四个方法都抛"未实现"，漏实现的方法启动就炸，不会等到第一条消息才静默失败）；统一消息模型注释 `gateway/gateway.js:7-12`；桥接 `agent_bridge.js:40-58`；第二个适配器 `gateway/terminal_gateway.js:23`。
- **常见追问**：*为什么不让 Agent 直接对接平台？* → 平台细节会渗进主循环：QQ 的 `<@!bot>` 前缀、群/私聊两种回复端点、`msg_id`/`msg_seq` 规则，每加一个平台都要改 Agent 并重跑全量测试。分层之后新平台的改动量是"加一个子类 + attach"（本章实测：终端通道 159 行、零改动 Agent）。

### Q2：QQ 官方机器人的完整接入链路是什么？

- **考点**：有没有真接过一个长连接平台，而不是只写过 HTTP 调用。
- **答题结构**：凭证 → 握手 → 协议状态机（HELLO → IDENTIFY → READY）→ 心跳 → 事件 → 回复，六步一条线；最后点名 intents。
- **参考话术**："六步。**凭证**：新版 union 机器人给的是 appid + appsecret，不是 token，要先 `POST /app/getAppAccessToken` 换 access_token，有效期 7200 秒（`qq_gateway.js:78-89`）。**握手**：连 `wss://api.sgroup.qq.com/websocket`，鉴权头 `Authorization: QQBot <token>` 和 `X-Union-Appid` 必须在**握手阶段**带上。**状态机**：服务端发 HELLO（op 10，带 `heartbeat_interval`）→ 客户端发 IDENTIFY（op 2，`token` + `intents` + `shard`）→ 服务端回 READY（op 0）才算就绪（`qq_gateway.js:151-177`）。**心跳**：按 HELLO 给的间隔定时发 op 1，收了不回连接会被判死（`qq_gateway.js:225-230`）。**事件**：`C2C_MESSAGE_CREATE` 私聊、`GROUP_AT_MESSAGE_CREATE` 群@。**回复**：私聊 `POST /v2/users/{openid}/messages`，群聊 `POST /v2/groups/{group_openid}/messages`（`qq_gateway.js:245-251`）。最值得记的是 `intents = 1 << 25`（GROUP_AND_C2C_EVENT）——它是事件订阅的位掩码，`1 << 30` 是频道消息，两者不是包含关系，选错的症状是连接完全正常、心跳也正常、就是收不到任何消息。"
- **代码锚点**：换 token `qq_gateway.js:78-89`；握手头与 `WsClient` 构造 `qq_gateway.js:128-134`；HELLO / IDENTIFY / READY `qq_gateway.js:151-177`；心跳 `qq_gateway.js:225-230`；事件转发与群通道记账 `qq_gateway.js:178-183`；双端点发送 `qq_gateway.js:245-251`。
- **常见追问**：*鉴权放在握手而不是连上之后发，有什么区别？* → 握手阶段服务端就能拒绝非授权连接，401 直接返回、不建立 WebSocket；如果放到连上之后再发 IDENTIFY，连接会先建立（101），然后回一个 op 9 表示会话无效再断开——症状变成"连上就断、无限重连"，排查成本高得多。QQ 两种都用了：握手带 token 头，IDENTIFY 里还要再带一次 token。

### Q3：平台事件为什么要用纯函数归一化？

- **考点**：测试意识——有没有把"能离线测的部分"从网络里摘出来。
- **答题结构**：纯函数的定义 → 它要兼容什么（新旧结构 / 前缀 / 非消息事件）→ 纯函数带来的测试能力 → 一句话。
- **参考话术**："`parseDispatch` 不碰网络、没有状态，输入是原始事件 payload，输出是统一消息模型或者 `null`（`qq_gateway.js:43-69`）。它要兼容三类现实：**结构升级**——新版 C2C 事件的 openid 在 `d.author.user_openid`，旧版在 `d.openid`，消息 id 同理 `d.msg_id` 和 `d.id` 都要兜（`qq_gateway.js:49`、`qq_gateway.js:55`），不兜的话平台升级一次就"突然收不到消息"；**正文装饰**——群@的 content 自带 `<@!机器人ID>` 前缀，要正则剥掉（`qq_gateway.js:64`），否则模型看到一串它无法解释的标记；**非消息事件**——READY、心跳这些 op 0 但不是消息的，统一返回 `null`，绝不制造假消息。因为是纯函数，这四类情况全都能离线断言（`test.js:53` / `65` / `82` / `102`），不需要机器人凭证也不需要网络。"
- **代码锚点**：`parseDispatch` 定义 `qq_gateway.js:43-69`；新版 openid 兼容 `qq_gateway.js:49`；群@前缀剥离 `qq_gateway.js:64`；非消息返回 null `qq_gateway.js:68`；四个纯函数用例 `test.js:53`、`test.js:65`、`test.js:82`、`test.js:102`。
- **常见追问**：*`msgId` 为什么也进统一模型，不是 QQ 特有的吗？* → "回复哪一条消息"每个 IM 都有，QQ 叫 `msg_id`（被动回复必须回显，否则发送被拒），其他平台叫 thread id 或 reply id 之类；把它放进模型是把它当成会话层概念，而不是平台私有字段。将来接企微时 `send(channelId, text, msgId)` 的签名不用动。

---

## T2 工程深度（区分度所在）

### Q4：Node 有内置 WebSocket，为什么要手写一个客户端？

- **考点**：能不能说清一个具体限制（而不是"为了炫技"），以及协议层的实现分寸。
- **答题结构**：限制是什么 → 备选方案为什么不行 → 手写要写哪四块 → 两个 TLS 层的坑 → 顺手拿到的面试价值。
- **参考话术**："限制在握手：Node 的全局 `WebSocket` 是浏览器 API 形态，构造函数只有 `(url, protocols)`，第二个参数只能放子协议字符串，**塞不进自定义请求头**（`ws_client.js:5-13`）；而 QQ 网关要求握手阶段就带 `Authorization` 和 `X-Union-Appid`。官方提到的 `undici` 在 Node 22 里也不能直接 import。所以自己写 RFC 6455 的最小子集，一共四块：**TLS 连接 + HTTP Upgrade 请求**（拼 `Sec-WebSocket-Key`，校验服务端回的 `Sec-WebSocket-Accept`，`ws_client.js:113-145`）；**帧解析**（FIN、opcode、7/16/64 位三档长度、掩码位，`ws_client.js:156-191`）；**帧发送**（客户端发出的每一帧都必须带掩码，4 字节随机 key 加 XOR，方向反了服务端直接断开，`ws_client.js:223-243`）；**控制帧**（收到 ping 自动回 pong、close 回执，`ws_client.js:193-215`）。两个坑都是 TLS 层的：`tls.connect` 必须显式传 `servername`（`ws_client.js:83`）——QQ 网关是共享负载，不带 SNI 会拿到默认证书 `*.ias.tencent-cloud.net`，报 `ERR_TLS_CERT_ALTNAME_INVALID`，而域名解析和证书本身看起来都正常；另一个是 `Host` 头在默认端口上不要带 `:443`，部分网关会拒。这一段还有个副产品：`test.js` 里的假 WS server（`test.js:390`）是 `net.createServer` 手写 Upgrade 响应和帧编解码，**真握手真解帧**，掩码写反、粘包拆包这类 bug 它都能抓到，比 mock 掉网络层有价值得多。"
- **代码锚点**：文件头限制说明 `ws_client.js:5-13`；Upgrade 请求拼接（含 headers 展开）`ws_client.js:60-74`；**SNI 那一行 `ws_client.js:83`**；Accept 校验 `ws_client.js:113-145`；帧头解析 `ws_client.js:156-191`；ping → pong 与 close `ws_client.js:193-209`；`_sendFrame` 掩码 `ws_client.js:223-243`；假 server `test.js:390`；两个 WsClient 用例 `test.js:448`、`test.js:482`。
- **常见追问**：*帧边界和 TCP 段边界不一致，你怎么处理的？* → 解析时维护一个 buffer，读头不够 2 字节就返回、等下一个 chunk，长度字段读完发现 payload 不够也返回；一次 `data` 事件里可能含多条完整帧，所以用一个 `while` 循环连续解（`ws_client.js:148-153`）。没做的是**分片重组**：读到 `FIN = 0` 的续帧（opcode 0x0）会被当成独立帧，QQ 的文本帧暂时都在单帧内所以没撞上，这条在 README 的缺口表里记着，生产要补状态机。

### Q5：一个 Agent 实例怎么服务多用户？并发消息怎么办？

- **考点**：是否理解"共享状态"这个约束，以及"用简单方案换正确性"的取舍。
- **答题结构**：矛盾的来源 → 解决方式（cm 切换不是共享）→ 并发保护 → 边界与演进的代价。
- **参考话术**："矛盾在于 Agent 只有一个实例、一份上下文管理器，而 QQ 里有一堆 openid。解决方式是**按 channelId 把会话切换进来再切出去**：`channelToSession` 记住通道到会话的映射，处理前 `restoreContext` 把该会话的三层填回 `agent.cm`，处理完序列化保存（`agent_bridge.js:100-125`）。是切换不是共享——共享的话 A 的对话历史会出现在 B 的回答里。这条我用了探针用例量化：A 说"我叫小明"，B 问"你好"必须答"我不认识你"，A 再问必须答"你是小明"，同时磁盘上必须是两个独立会话文件（`test.js:525`）。并发方面，单实例的 cm 一次只能服务一个人，两个用户的处理交错就会污染上下文，所以桥接层维护一个串行队列：`this.queue = task.catch(() => {})` 链式排队，同一时刻只处理一条（`agent_bridge.js:67-68`）。验证方式不是"看起来对"——3 条并发消息加一个带 30ms 延迟的假模型，断言 `maxActive ≤ 1`（`test.js:579`）。代价是吞吐：一个长任务会把所有人堵在队列里，这是本章刻意留下的边界，演进方向是按 `channelId` 分片并行，或者每用户一个实例。"
- **代码锚点**：会话映射与切换 `agent_bridge.js:100-110`；串行队列 `agent_bridge.js:67-68`；队列吞错误的写法 `agent_bridge.js:68`；隔离探针用例 `test.js:525`；并发上限用例 `test.js:579`。
- **常见追问**：*串行队列里一条消息失败了，后面的会被阻塞吗？* → 不会，`task.catch(() => {})` 把失败吞掉后再赋回 `this.queue`，下一条接的是"已 settle 的 Promise"。但错误不能只在队列层吞掉，否则用户永远等不到回复——`attach` 里给处理链配了 `.catch()`，记日志并用 `gateway.send` 回一句"处理失败请稍后重试"（`agent_bridge.js:46-52`）。这个 `.catch` 还有进程保活的意义：没有它就是 unhandled rejection，Node 22 默认让进程退出，整个服务挂掉。

### Q6：IM 里的权限确认怎么设计？"死锁"是怎么出现的？

- **考点**：本章最有区分度的一题——确认要在聊天里完成，而聊天通道又被正在等确认的那次推理占着。
- **答题结构**：问题（终端没人看）→ 机制（挂起 + 三态 + 超时）→ 死锁的两个成因与绕法 → 数字选项的取舍。
- **参考话术**："确认请求必须发到用户所在的那条通道：QQ 用户收到 QQ 消息，终端用户看到终端打印。机制是 `createConfirm(channelId, msgId)` 返回一个 confirm 回调，挂起表 `pending` 是 `channelId → {resolve, timer}`，回复由 `handleReply` 解析三态：`1` 批准一次、`2` 拒绝、`3` 始终允许，其它输入一律按拒绝（`approval_flow.js:93-107`）；超时默认 60 秒也按拒绝（`approval_flow.js:53-57`）。**死锁是这么来的**：`agent.run` 等确认时挂在 confirm 的 Promise 上，而它已经占着串行队列；用户的确认回复到达 `handleMessage`，如果按普通消息入队，就要排在正在等确认的那条后面——两条互相等，谁都不动。绕法是在 `handleMessage` 第一行先问 `approval.handleReply`（`agent_bridge.js:64`），是确认回复就消费掉、返回 `null` 不入队，用例断言"确认回复被消费、没有触发新的 `agent.run`、网关只发出确认请求那 1 条消息"（`test.js:222`）。第二个坑更隐蔽，是**竞态**：`pending` 必须**先同步注册再异步发消息**，如果先 `await send` 才 `set`，手速快的用户会在 `pending` 就位前命中 `handleReply`，那次调用因为找不到挂起项返回 false，回复被当成普通消息进了队列，确认只能等到超时（`approval_flow.js:52-70`）。"
- **代码锚点**：构造与默认超时 `approval_flow.js:28`；pending 同步注册 `approval_flow.js:59`；异步发送与文案（`1 (批准) / 2 (拒绝) / 3 (始终允许)`）`approval_flow.js:62-70`；三态解析 `approval_flow.js:95-107`；超时拒绝 `approval_flow.js:53-57`；绕过队列 `agent_bridge.js:64`；用例 `test.js:171`、`test.js:191`、`test.js:211`、`test.js:222`、`test.js:280`。
- **常见追问**：*为什么用 1 / 2 / 3 而不是"批准 / 拒绝"这样的自然语言？* → 数字在 IM 里输入成本最低、不会被输入法改写、也不会和用户正常聊天内容撞车。兼容层保留了 `y` / `yes` / `ok` / `n` / `a` 这些旧写法（`approval_flow.js:95-103`）。这里的取舍要主动说出来：pending 期间用户的**任何**回复都会被当成审批决定，等确认时问的别的问题会被吞掉（未识别输入按拒绝处理）——安全默认优先，要更宽松就得限制成"仅短文本/仅数字"，或者把判断交给模型。

### Q7：Loop 判定之后 `break` 跳出，会有什么后果？同族的第二处在哪？

- **考点**：改一处要想"同族还有没有"；以及"测试全绿"到底证明了什么。
- **答题结构**：现象 → 根因 → 修复 → 同族扫描 → 验证（红/绿的真实输出）。
- **参考话术**："后果是**孤儿 tool 消息**，服务端报 400：`Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。触发条件很窄——模型一条响应里同时要调两个工具，第一个刚好触发死循环判定（同签名重复 3 次，`agent.js:21`），原来的 `break` 让第二个调用一条 `tool` 消息都没有，下一轮 `assistant(tool_calls)` 后面少一条配对。修法是加一个 `loopDetected` 闩锁：判定之后同批剩下的调用不再执行，但每条都要回填一条错误消息，用 `continue` 而不是 `break`（`agent.js:138-160`）；措辞也分开，第一条是"检测到死循环"，后面的写"本轮已判定死循环，跳过执行"，模型能看出区别。**同族扫描是这一题的真正考点**：`subagent.js` 有一份一模一样的 `break`，第 6 章复制过来时带上的，而 `npm test` 全绿——因为用例只覆盖主 Agent。补上子 Agent 的回归用例后先跑红，真实输出是 `assert.deepEqual` 的 actual 里整列缺 `s2b`、`s3b`…`s8b` **8 条**孤儿调用，改成同样的 `loopDetected` + `continue`（`subagent.js:125-150`）后 25 个用例全绿（`tests 25 / pass 25 / fail 0`，901.596ms）。"
- **代码锚点**：主 Agent 阈值 `agent.js:21`、判定函数 `agent.js:95-101`、修复段 `agent.js:138-160`；子 Agent 阈值 `subagent.js:20`、判定函数 `subagent.js:79-87`、修复段 `subagent.js:125-150`；两条回归用例 `test.js:607`、`test.js:647`。
- **常见追问**：*为什么不在执行前把整批 tool_calls 一起判掉？* → 逻辑上等价，差别在"第几条触发"：逐条判能保住前面已经真实执行成功的那几条结果，整批判会把它们也丢掉。另一个值得说的点：这个 bug 只在**一条响应带多个 `tool_calls`** 时暴露，单调用的用例永远盖不到——这也是它能从前几章一路活到第 11 章的原因，所以修复必须配"多 `tool_calls` + 触发 Loop"这种特定形状的用例。

---

## T3 架构设计（对标 AI 技术负责人）

### Q8：这套网关离生产还差什么？

- **考点**：知道当前实现的边界，并能排优先级，而不是笼统说"要加监控"。
- **答题结构**：按风险排序的差距清单（凭证 / 限流 / 部署 / 安全 / 观测）→ 每一项的具体改法落在哪个函数 → 一句话的取舍判断。
- **参考话术**："按"会不会真出事"排。**第一是 access_token 缓存刷新**：有效期 7200 秒，现在每次启动换一次，长跑进程重连时会拿过期 token 反复失败；改法只在 `getAppAccessToken` 一处（`qq_gateway.js:78`）。**第二是发送限流**：QQ 官方大约 5 条/秒/机器人，本课的 `send` 没有任何排队，短时间批量回复会被拒（`qq_gateway.js:245`），要加发送队列加令牌桶。**第三是吞吐**：单实例串行队列意味着一个长任务堵住所有用户（`agent_bridge.js:67`），要按 `channelId` 分片或每用户独立实例。**第四是安全与用户体系**：现在 openid 和企业员工身份没有映射，工具权限也没有按人分级，生产要做 RBAC。**第五是观测**：不知道哪个用户烧了多少 token，按 channelId 聚合交给第 13 章的 telemetry。还有两个更细的：重连有 5 次上限（`qq_gateway.js:196-202`），生产要改成无限退避加告警；群通道类型靠"收到过群消息"记账（`qq_gateway.js:181`），进程重启后第一次主动推送到群会退回前缀启发式，正确做法是持久化到会话元数据。"
- **代码锚点**：缺口与后果的完整表在 `README.md` 的"本课刻意不做的事"；token 刷新点 `qq_gateway.js:78-89`；重连上限 `qq_gateway.js:196-202`；发送与限流位置 `qq_gateway.js:245-279`；串行队列 `agent_bridge.js:67`；群通道记账 `qq_gateway.js:181`、`qq_gateway.js:248`；配置开关 `main.js:84-95`。
- **常见追问**：*这些缺口里哪一个最危险？* → access_token 过期。它不报错、不崩，只是让重连一直失败，日志里看到的是一串连接断开；而重连上限会在 5 次后放弃，于是机器人"过了一夜就再也没上线"。这类"静默退化"比抛异常严重，所以修复优先级最高。

### Q9：Mock 网关和假 WS server 各证明什么？

- **考点**：对"测试能证明架构"这件事的理解深度；能不能区分"该 mock 的"和"不该 mock 的"。
- **答题结构**：Mock 的三个用途 → 假 server 为什么不能省 → 测试的分寸感 → 用数字收口。
- **参考话术**："`MockGateway` 做三件事：测试里把"收到消息"变成一次方法调用，断言 `sent` 记录；没有凭证也能本地跑通全链路；以及最关键的一点——**能换实现就说明抽象到位**。`QQGateway`、`MockGateway`、`TerminalGateway` 三个类实现同一组 `connect` / `onMessage` / `send` / `close`，桥接层只依赖这组接口，所以换平台不改业务代码（`gateway/gateway.js:19-41`、`test.js:265`）。但**网络层不 mock**：`WsClient` 的用例起一个 `net.createServer` 的假 WS server（`test.js:390`），真跑 Upgrade 握手、真校验 `Sec-WebSocket-Accept`、真按掩码解帧，ping 就发一个真的 ping 帧验证客户端自动回 pong（`test.js:448`）。理由很直接——掩码写反、握手响应解析错、粘包拆包这些 bug 只有真收发字节才会出现，把它们 mock 掉等于把要测的东西测没了。所以分寸是：**能真测就真测，只有 LLM 用假函数**（它要花钱、还不可复现）。收口数字：25 个用例全离线，901.596ms，不联网、不花 token、不需要机器人凭证。"
- **代码锚点**：抽象接口 `gateway/gateway.js:19-41`；本地替身 `gateway/mock_gateway.js:14-39`；假 WS server `test.js:390-446`；WsClient 两个用例 `test.js:448`、`test.js:482`；三实现同接口的另一证据（终端）`gateway/terminal_gateway.js:23`。
- **常见追问**：*假 server 和真 QQ 网关的差距在哪？* → 假 server 只覆盖协议层：握手、帧编解码、心跳应答、端点的 URL 形状。它不覆盖平台行为——intents 选错会不会收不到事件、`msg_seq` 不递增会不会被去重（40054005）、证书链和 SNI、发送频率限制。所以两类测试是互补的：协议层用假 server 钉死，平台规则靠 `verify_qq.js` 这类最小真连自检加真机验证。本章的真实 QQ 连接本次没有实跑，这一点我在文档里明确标了。

### Q10（压力题）从"连不上"到"能上线"，你排查过哪些问题？方法论是什么？

- **考点**：有没有真实的落地经验，以及"把调试路径固化成资产"的习惯。
- **答题结构**：分层排查链（运输 → TLS → 鉴权 → 协议参数 → 数据模型 → 业务规则）→ 每层的症状与手段 → 最后说固化和没做的事。
- **参考话术**："有一串按层排的问题。**传输与握手层**：Node 内置 WebSocket 带不了鉴权头，症状是连接建立后立刻断开、HELLO 不来、无限重连，解法是手写客户端。**TLS 层**：`tls.connect` 没显式传 `servername` 时多租户 IP 上拿的是默认证书，报 `ERR_TLS_CERT_ALTNAME_INVALID`，而 DNS 和证书本身都正常——定位办法是写两个连接对比，一个只给 host、一个额外给 servername，后者能通就锁定 SNI（`ws_client.js:83`）。**鉴权层**：把 appsecret 直接当 token 用，症状链是"握手 101 成功 → HELLO 正常 → op 9 表示会话无效 → 断开重连"，解法是先用 appid + secret 换 access_token（`qq_gateway.js:78`）；错误处理里把服务端原始响应拼进错误信息是有意的，因为 QQ 的错误码单独看没有意义，原文那句 `invalid appid or secret` 才是线索。**协议参数层**：intents 选错（`1 << 30` 是频道消息）会"连得上但收不到消息"，调试时这个字段应该第一个怀疑（`qq_gateway.js:160`）。**数据模型层**：新版事件把 C2C 的 openid 挪到了 `d.author.user_openid`，解析要兼容新旧，否则平台升级后消息静默消失（`qq_gateway.js:49`）。**业务规则层**：被动回复缺 `msg_id` 会被拒，同一 `msg_id` 多次回复 `msg_seq` 不递增会被判重复（40054005，`qq_gateway.js:256-261`）。方法论就一条：**用 `DEBUG_WS=1` 打印握手响应头和原始帧**，逐层排除、每层验证再进下一层；然后把这条路径固化成 `verify_qq.js`——换 token、握手、等 READY，成功即退出，带 10 秒超时保护。把一次性排查变成可重复执行的自检脚本，是这一段里最值钱的习惯。"
- **代码锚点**：调试日志开关 `qq_gateway.js:133`（`DEBUG_WS === "1"`）与响应头打印 `ws_client.js:123`；SNI `ws_client.js:83`；换 token `qq_gateway.js:78-89`；intents `qq_gateway.js:160`；新旧结构兼容 `qq_gateway.js:49`、`qq_gateway.js:55`；msg_id / msg_seq `qq_gateway.js:256-261`；自检脚本 `verify_qq.js:11-24`（10 秒超时在 `verify_qq.js:11-15`）。
- **常见追问**：*这套排查顺序能复用到其他 IM 吗？* → 分层是通用的，具体症状不同：企微/钉钉也是"鉴权 + 事件订阅 + 回复",同样会踩"事件订阅类别选错 → 连得上收不到消息"和"被动回复缺关联 id"。可以直接复用的是 `MessageGateway` 抽象和 `gateway/` 里的手写 WS 客户端；要重写的是鉴权流程、事件结构和回复端点这三处平台差异。落地时先做的事也一样：把最小真连自检脚本写出来，再去写适配器。

---

## 自检清单（面试前过一遍）

| 能脱口而出 | 对应题 |
|---|---|
| Gateway / Bridge / Agent 三层职责，统一消息模型五个字段各自的用途 | Q1 |
| QQ 接入六步：换 token → 握手带鉴权 → HELLO/IDENTIFY/READY → 心跳 → 事件 → 双端点回复；intents = `1<<25` | Q2 |
| 归一化用纯函数：新旧结构兼容 + 群@前缀剥离 + 非消息返 null，所以能离线测 | Q3 |
| 手写 WS 的四块（Upgrade / 帧解析 / 掩码 / 控制帧）与两个 TLS 坑（SNI、Host 不带端口） | Q4 |
| cm 是切换不是共享（小明探针）；串行队列 `maxActive ≤ 1` | Q5 |
| 审批死锁 = 等确认的 run 占队列；确认回复绕过队列 + pending 先注册再发消息；`1/2/3` 三态与超时拒绝 | Q6 |
| Loop 判定后 `break` → 孤儿 tool_calls → 400；主 Agent + 子 Agent 两处都修，配回归用例 | Q7 |
| 缺口优先级：token 刷新 > 发送限流 > 吞吐 > RBAC/内容安全 > 观测 | Q8 |
| 能 mock = 抽象到位；能真测就真测（假 WS server），只有 LLM 用假函数 | Q9 |
| 六层排查链 + `DEBUG_WS=1` 原始帧 + `verify_qq.js` 把调试路径固化成资产 | Q10 |

> 讲这一章最有力的是**边界和数字**："入口层 8 个文件 1052 行，25 个用例离线全绿 901.596ms，QQ 那部分全程用假 WS server 跑真握手真解帧，真实 QQ 连接我没在这次改动里实跑过——引用的都是离线结果。我修了两处同族 bug：主 Agent 和子 Agent 的 Loop 分支都是 `break`，一条响应带多个 `tool_calls` 时后面的调用没回填，下一轮配对断裂直接 400；先补用例跑出红灯（子 Agent 那份 actual 里整列缺 8 条），再改成 `loopDetected` 加 `continue` 跑到全绿。审批流那个死锁不是看出来的，是从'用户在 QQ 里回了确认但 Agent 没动静'反推出来的：等确认的 run 占着串行队列，确认回复要是也排队就永远排不上。"有边界、有数字、有自己修过的坑，比背概念有说服力。
