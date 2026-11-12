# 入门者练习册

每项练习都从章节目录里的现有代码开始。先照教程运行一次，再完成任务。练习优先使用假模型和本地数据；需要真实模型的扩展题会单独标出。

<a id="chapter-01"></a>

## 第 1 章：增加一个工具

使用[第 1 章现有练习](../lesson01-minimal-agent/docs/course.md#动手练习给-agent-增加景点查询)，给 Agent 增加景点查询。完成标准：模型可以提出 `get_attraction` 调用；程序执行本地函数，并用相同的 `tool_call_id` 回填结果。

<a id="chapter-02"></a>

## 第 2 章：注册一个只读工具

**从哪里开始：** `lesson02-tool-system/tools_demo.js`。

新增 `get_course_name` 工具，不接收参数，返回固定字符串 `build-your-agent`，权限设为 `read`。用 `buildRegistry()` 创建注册表并直接调用 `registry.execute("get_course_name", "{}")`。

**检查结果：** 返回中包含 `build-your-agent`，执行时没有询问确认。再把权限改成 `write`，确认系统会走确认流程。

<a id="chapter-03"></a>

## 第 3 章：观察一次上下文压缩

**从哪里开始：** `lesson03-context/context_manager_v2.js` 和 `summary_compactor.js`。

创建一个 `TieredContextManager`，加入 6 条 user/assistant 消息，并把 `keepRecent` 设为 4。传入一个假 LLM，让它返回固定摘要，例如“用户选择了蓝色；还需要完成报告”。调用 `compact()`。

**检查结果：** `summary` 中出现假 LLM 返回的摘要，`recent` 中保留最近 4 条。再加入一组 assistant `tool_calls` 与两条 tool 结果，确认压缩后不会只留下其中一条结果。

<a id="chapter-04"></a>

## 第 4 章：区分字面量搜索和正则搜索

**从哪里开始：** `lesson04-core-tools/tools/search.js` 和 `core_tools.js`。

在 `demo/` 新建一个文本文件，写入两行：`foo(bar)` 和 `fooXbar`。先按默认设置搜索 `foo(bar)`，再设置 `regex: true` 搜索 `foo.*bar`。

**检查结果：** 默认搜索只命中 `foo(bar)`；正则搜索能命中两行。这样可以看出什么时候字符会被当成正则语法。

<a id="chapter-05"></a>

## 第 5 章：保存并找回一条记忆

**从哪里开始：** `lesson05-memory/memory_manager.js` 和 `memory_entries.js`。

用 `MemoryManager.save()` 保存一条本地记忆，例如“项目使用 2 空格缩进”，然后用 `recall()` 搜索“缩进规则”。再用另一个会话 scope 提交不同消息，观察两边的提取进度互不覆盖。

**检查结果：** 第一条查询能找回刚保存的记忆；两个 scope 的新消息都会进入各自的提取队列。完成后删除练习写入的记忆。

<a id="chapter-06"></a>

## 第 6 章：确认委派深度按层变化

**从哪里开始：** `lesson06-multi-agent/agent_tool.js`、`subagent.js` 和 `depth_guard.js`。

把 `maxDepth` 设为 3，用假 LLM 和现有 registry 创建深度为 1 的 `SubAgent`。检查它发送给 LLM 的 schema；再检查深度为 2 的子 Agent。

**检查结果：** 深度 1 可以看到 `delegate_task`；深度 2 看不到。若触发委派，执行函数也应使用该层的深度，而不是根 Agent 的深度。

<a id="chapter-07"></a>

## 第 7 章：添加一个 Skill

**从哪里开始：** `lesson07-skill/skills/` 和 `skill_registry.js`。

新建一个 `note-format/SKILL.md`，填写 `name`、`description`、`when_to_use` 和正文。正文写一条明确规则，例如“笔记标题不超过 20 个字”。

运行以下命令查看匹配结果：

```bash
cd lesson07-skill
node --input-type=module -e 'import { SkillRegistry } from "./skill_registry.js"; const r = await new SkillRegistry().load(); console.log(r.match("帮我整理一条笔记").map((s) => s.name));'
```

**检查结果：** 输出包含 `note-format`。这个练习只检查关键词匹配，不代表 `tools` 字段已经限制了 Agent 的工具权限。

<a id="chapter-08"></a>

## 第 8 章：观察敏感参数怎样进入审计日志

**从哪里开始：** `lesson08-plugin/plugins/audit-log/plugin.js`。

使用 `createAuditLogPlugin()` 和 `HookRegistry`，构造一个带嵌套对象的工具参数：`{ options: { api_key: "demo-secret" } }`，触发工具前置钩子。

**检查结果：** 审计记录中的 `api_key` 被替换为 `***`。再触发后置钩子并检查记录：工具返回的正文不应写进审计日志，只记录成功或失败状态。

<a id="chapter-09"></a>

## 第 9 章：给 MCP 服务端增加一个工具

**从哪里开始：** `lesson09-mcp/mcp/mcp_server.js` 和 `mcp_tools.js`。

新增 `multiply` 工具，参数 schema 使用 `inputSchema`，并在服务端实现两个数相乘。用客户端发现工具后调用 `multiply({a: 3, b: 4})`。

**检查结果：** `tools/list` 返回的工具包含输入 schema；调用结果是文本 `12`。这一章的实现只处理文本结果，图片和资源需要另行实现。

<a id="chapter-10"></a>

## 第 10 章：保存完整的多工具调用

**从哪里开始：** `lesson10-session/session_state.js`。

准备一条包含两个 `tool_calls` 的 assistant 消息，再准备对应的两条 `role: "tool"` 结果。用 `truncateToCompletePairs()` 检查完整数据，再删掉第二条工具结果后重新检查。

**检查结果：** 两条结果齐全时，整组都保留；缺少任意一条时，assistant 调用和它后面的部分结果都不进入恢复后的上下文。

<a id="chapter-11"></a>

## 第 11 章：验证网关的消息转换

**从哪里开始：** `lesson11-gateway/gateway/qq_gateway.js` 的 `parseDispatch()`。

准备一条 C2C 事件，填写用户 ID、消息 ID 和正文；再准备一条缺少消息 ID 的事件。

**检查结果：** 完整事件被转换成统一消息对象；字段不全的事件返回 `null`，不会继续进入桥接层。

<a id="chapter-12"></a>

## 第 12 章：解析并验证 cron 表达式

**从哪里开始：** `lesson12-cron/cron/cron_parser.js` 和 `cron_scheduler.js`。

解析 `*/15 * * * *`，再尝试解析 `*/0 * * * *`、`60 9 * * *` 和 `0 9 * * 8`。

**检查结果：** 第一个表达式的分钟集合是 `[0, 15, 30, 45]`；后三个都给出明确错误，不会进入无限循环。

<a id="chapter-13"></a>

## 第 13 章：汇总一组运行指标

**从哪里开始：** `lesson13-production/telemetry.js`。

用固定价格表和假数据记录两次 LLM 调用（一次成功、一次失败）和一次工具调用，然后打印 `summary()`。

**检查结果：** 汇总显示 2 次 LLM 调用、1 次工具调用，错误率为 `0.5`。这些数据是内存中的估算指标；它们不等同于供应商账单。

**扩展练习（需要真实模型）：** 在 `evaluate.js` 增加一个简单对话用例，再运行 `/eval`，观察通过率和失败用例说明。
