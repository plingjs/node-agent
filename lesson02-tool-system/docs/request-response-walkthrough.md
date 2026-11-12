# 第 2 章教程：一次工具调用怎样经过安全检查

第一章讲清了模型怎样提出工具调用，程序怎样执行并把结果交回模型。第二章沿着同一条请求链继续看：**工具名怎样匹配到本地代码，参数怎样检查，权限怎样确认，失败怎样作为结果返回。**

## 先看全程

`main.js` 给 Agent 一个任务：查北京天气、保存一条笔记、删除一条笔记。程序把当前对话和工具说明发给模型。下面用一个可能的模型响应举例；真实模型可能分几次提出调用，调用顺序也由模型决定。

### 第一次请求：把对话和工具说明发给模型

`Agent.run()` 一开始创建两条消息：

```js
[
  { role: "system", content: "你是助手，可调用工具获取实时信息。" },
  {
    role: "user",
    content: "查询北京天气，保存一条例会笔记，再删除临时笔记。",
  },
]
```

发给模型时，`llm.js` 还会带上 `tools`。这份工具清单来自 `registry.getSchemas()`，例如天气工具的说明大致是：

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "查询指定城市的当前天气。",
    "parameters": {
      "type": "object",
      "properties": { "city": { "type": "string" } },
      "required": ["city"]
    }
  }
}
```

这里的 `tools` 是模型可选能力的说明书。它告诉模型工具叫什么、适合做什么、参数要长什么样；它不会把 `fn` 函数发给模型，也不会让模型直接执行本地代码。

对应代码：`agent.js` 每轮调用 `this.llm(messages, this.registry.getSchemas())`；`llm.js` 把两部分放进一次 HTTP 请求。

### 第一次响应：模型提出调用意图

模型可能返回这样的 `assistant` 消息：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_weather_1",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\":\"北京\"}"
      }
    },
    {
      "id": "call_write_1",
      "type": "function",
      "function": {
        "name": "write_note",
        "arguments": "{\"title\":\"例会\",\"content\":\"周三下午三点\"}"
      }
    },
    {
      "id": "call_delete_1",
      "type": "function",
      "function": {
        "name": "delete_note",
        "arguments": "{\"title\":\"临时\"}"
      }
    }
  ]
}
```

模型返回的是**调用意图**，不是工具执行结果。

- `function.name` 是路由键，程序用它在注册表里找本地工具定义。
- `function.arguments` 是 JSON 字符串，程序要先解析，再按工具的参数 schema 校验。
- `id` 是这次调用的编号。后续 `role: "tool"` 消息必须带相同的 `tool_call_id`，模型才能知道哪条结果对应哪次调用。

`agent.js` 先把这条 assistant 消息放进 `messages`，再按 `tool_calls` 顺序逐个处理。一次响应里可以有多个调用；程序不会把调用意图误当成执行结果。

### 本地执行：名字匹配，参数检查，再决定是否放行

每个调用进入 `registry_full.js` 的 `execute(name, argumentsStr)`。处理顺序如下：

1. 用 `tools.get(name)` 找定义。没有这个名字，就生成 `TOOL_NOT_FOUND`。
2. 解析 `arguments`。不是合法 JSON，就生成 `INVALID_PARAMS`。
3. 按定义里的 `params` 校验并规范化参数。缺必填项、类型不合或多出未知字段，都会在执行前拦下。
4. 根据工具等级做权限决策：`read` 自动放行；`write` 询问一次，用户可选择本次或本会话始终允许；`danger` 每次都要确认。
5. 只有校验通过且权限放行，才调用定义对象里的 `fn`。
6. 成功值或结构化错误统一转成普通对象，交回 Agent。

先校验再确认有个直接好处：确认界面展示的参数，就是函数最终收到的参数。比如整数参数把 `"3"` 无损转换成 `3` 后，用户看到和批准的也是 `3`；像 `3.7` 这种会改变含义的值会被拒绝，不会偷偷截成 `3`。

工具名怎样找到函数，可以缩成两行：

```js
const tool = tools.get(name);       // 模型给名字，Map 找定义
const result = await tool.fn(args); // 通过校验和权限后才运行本地函数
```

而模型能看到的 schema 和本地执行函数放在同一个注册对象里：

```js
r.register({ name, description, params, fn }, "write");
```

`getSchemas()` 从注册表生成模型需要的 `tools`；`execute()` 仍从同一个注册表拿 `fn`。因此新增工具时不需要再维护一份独立的路由 `if` 分支。安全等级也必须显式写成 `read`、`write` 或 `danger`，漏写时注册立即报错。

### 工具响应：每个调用都要回填一条结果

例如天气查询成功、保存成功，删除工具返回业务错误，程序分别追加：

```json
[
  {
    "role": "tool",
    "tool_call_id": "call_weather_1",
    "content": "{\"result\":{\"city\":\"北京\",\"weather\":\"晴 25°C\"}}"
  },
  {
    "role": "tool",
    "tool_call_id": "call_write_1",
    "content": "{\"result\":\"已保存笔记: 例会\"}"
  },
  {
    "role": "tool",
    "tool_call_id": "call_delete_1",
    "content": "{\"error\":{\"code\":\"EXECUTION_FAILED\",\"message\":\"工具执行失败: 笔记不存在: 临时\"}}"
  }
]
```

这里假设用户批准了删除，但演示数据里没有“临时”这条笔记，所以工具返回业务错误。若用户拒绝，程序会回填 `PERMISSION_DENIED`；两种情况都必须保留这条 `tool_call_id` 对应的工具消息。

如果用户拒绝、参数不合法或工具报错，`content` 里会是 `error` 对象，包含错误码和可读说明。错误也会作为 `role: "tool"` 返回，因为它是这次工具调用的结果。

无论成功还是失败，**每个 `tool_call` 都要有一条匹配 `tool_call_id` 的工具消息**。否则对话历史里只说“我调用了工具”，却没有对应回执，下一次请求可能不符合模型服务要求。

### 第二次请求：把完整历史和工具结果再交给模型

`Agent` 继续循环，再次调用模型。第二次请求中的 `messages` 已包含：

```text
system 消息
user 的原始任务
assistant 的 tool_calls（调用名称、参数和 id）
role: tool 的执行结果（每条带对应 tool_call_id）
```

`tools` 清单也会再次传入。模型看到工具结果后，可以给用户最终回答；如果收到错误，也可以修正参数或提出新的工具调用，然后开启下一轮。Agent 的主循环就是：**请求模型 → 处理调用 → 回填结果 → 再请求模型**。

## 四种 role 分别做什么

| role | 这章里的作用 | 例子 |
|---|---|---|
| `system` | 给模型设定行为范围 | “你是助手，可调用工具获取实时信息。” |
| `user` | 放入用户任务 | “查询天气并保存笔记。” |
| `assistant` | 保存模型回答或工具调用意图 | `tool_calls` 及其参数、调用 id |
| `tool` | 保存程序执行后返回的结果 | `result` 或结构化 `error`，并带 `tool_call_id` |

`tool` 消息不是模型说的话，也不是用户输入；它是程序执行工具之后写入对话历史的回执。

## 沿代码读一遍

建议按运行顺序打开这些位置：

1. `main.js`：任务从哪里进入 Agent，确认回调怎样接到终端。
2. `agent.js` 的 `run()`：每轮发送哪些内容、怎样判断响应里有 `tool_calls`、怎样逐个回填 `role: "tool"`。
3. `tools_demo.js` 的 `buildRegistry()`：一个工具的 `name`、`description`、`params`、`fn` 和安全等级如何注册。
4. `registry_full.js` 的 `getSchemas()` 与 `execute()`：同一个名字如何分别变成模型可见 schema 和本地函数路由。
5. `validation.js`、`permissions.js`、`errors.js`：参数、授权和失败分别如何处理。
6. `llm.js`：最后看 messages 与 tools 怎样发到模型服务。

先读 `request-response-walkthrough.md` 能建立请求链；`course.md` 再补每个模块的设计细节和边界。

## 自己改一次

在 `tools_demo.js` 增加一个只读 `count_notes` 工具：无参数，返回当前笔记条数。完成后检查三点：

- `getSchemas()` 能列出 `count_notes`，参数 schema 表示它不需要参数。
- 模型发出 `count_notes` 后，程序按名字找到对应 `fn`，安全等级是 `read`。
- 执行结果以 `role: "tool"` 和匹配的 `tool_call_id` 回填，再由模型组织最终回答。

## 这一章记住三句话

- schema 是给模型看的调用说明，`fn` 是程序本地执行的代码。
- 路由按工具名匹配；参数校验和权限确认通过后才执行。
- 工具结果和错误都要按调用 id 回填，模型才能继续完成任务。
