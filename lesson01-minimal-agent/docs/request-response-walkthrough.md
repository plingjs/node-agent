# 第一章代码导读：每次请求到底发生了什么

第一章先不背定义。我们沿着代码和报文看清楚：**每次发给模型什么、模型回了什么、Node.js 接下来做了什么。**学完后，你应该能逐轮读懂 `messages`、`tools`、`tool_calls` 和 `role`，并说清工具如何匹配、按什么顺序执行。

## 一张图先看完整流程

```text
用户问题
  ↓
Node.js 发送一次模型请求：messages + tools
  ↓
模型返回一条 assistant 消息
  ├─ 有 tool_calls → Node.js 按名称找到本地函数并执行
  │                   ↓
  │                 追加 role: "tool" 结果，带回 tool_call_id
  │                   ↓
  │                 带着更新后的完整历史，再发下一次模型请求
  └─ 没有 tool_calls → 读取 assistant.content，交给用户
```

一次模型请求只会得到一条模型响应。工具是在 Node.js 本地执行的，不会因为模型“说要调用”就自动运行。工具执行完，程序才会决定是否再请求模型。

## 例 1：普通聊天，一次请求得到一次文本响应

先看最普通的一问一答。为了突出对比，这里直接调用 `call_llm`，不传工具说明：

```js
await call_llm([
  { role: "user", content: "用一句话解释 Node.js" },
]);
```

`llm.js` 会把请求发到 `/chat/completions`。请求体的关键部分是：

```json
{
  "model": "模型名称",
  "messages": [
    { "role": "user", "content": "用一句话解释 Node.js" }
  ]
}
```

请求里的 `role: "user"` 表示这是用户的问题，`content` 是问题文本。这里没有传 `tools`，所以 `JSON.stringify` 会省略值为 `undefined` 的 `tools` 字段。API Key 放在 HTTP 请求头用于鉴权，不属于这个请求体。

模型服务返回的完整 JSON 外层还有 `choices` 等字段。`llm.js` 只取第一条消息 `data.choices[0].message`。例如：

```json
{
  "role": "assistant",
  "content": "Node.js 是让 JavaScript 在服务器等环境中运行的运行时。"
}
```

这是一次 HTTP 请求、一次模型响应。程序读取 `content` 后就可以把回答显示给用户。这个小例子是普通聊天的基准；后面的 `run_agent` 会在每轮请求中都附带工具清单。

## 例 2：把工具说明和用户问题一起发出去

现在问模型：“我现在所在城市是哪里？”程序除了问题，还把可用工具的说明放进请求体的 `tools` 字段。以下只展示 `TOOLS` 中的 `get_city`，实际代码还声明了 `get_weather` 和 `get_food`：

```json
{
  "model": "模型名称",
  "messages": [
    { "role": "user", "content": "我现在所在城市是哪里？" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_city",
        "description": "获取当前我的城市",
        "parameters": {
          "type": "object",
          "properties": {},
          "required": []
        }
      }
    }
  ]
}
```

这张“说明书”由 [`tools.js`](../tools.js#L15) 中的 `TOOLS` 定义。`name` 是工具名，`description` 告诉模型用途，`parameters` 描述参数格式。`get_city` 不需要参数，所以 `properties` 和 `required` 都是空的。

如果模型判断需要查询，它会返回一条 `assistant` 消息，其中的 `tool_calls` 描述要调用什么：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_01",
      "type": "function",
      "function": {
        "name": "get_city",
        "arguments": "{}"
      }
    }
  ]
}
```

这里要抓住四点：

- `role: "assistant"`：这条仍然是模型发出的消息。
- `tool_calls`：模型提出的一个或多个工具调用请求。
- `function.name`：模型请求调用哪个工具，本例是 `get_city`。
- `function.arguments`：传给工具的参数 JSON 字符串。本例没有参数，所以内容是 `{}`。

**收到 `tool_calls` 还不等于工具已经执行。**这只是模型告诉程序“我想调用这个工具”。

## 例 3：Node.js 匹配工具、执行，再回填结果

`agent.js` 读出模型给的名称和参数，再交给 [`call_tool`](../tools.js#L80)：

```js
const tool_result = await call_tool(
  tool_call.function.name,
  tool_call.function.arguments,
);
```

`call_tool` 按名称匹配本地分支：

```js
if (name === "get_city") {
  return { city: await get_city() };
}
if (name === "get_weather") {
  const { city } = JSON.parse(args);
  return { city, weather: await get_weather(city) };
}
```

因此，模型返回 `function.name: "get_city"` 时，程序进入 `name === "get_city"` 分支，运行本地 `get_city()`。在本章的教学代码中，它从固定值 `MY_CITY` 取得“北京”，返回 `{ city: "北京" }`。如果名称写错、`TOOLS` 中声明了一个本地没有实现的工具，模型的请求就无法路由到预期功能；声明名和执行分支需要保持一致。

Agent 随后把模型的 `assistant` 调用消息留在历史里，再把工具结果追加成一条新消息：

```json
{
  "role": "tool",
  "tool_call_id": "call_01",
  "content": "{\"city\":\"北京\"}"
}
```

`role: "tool"` 表示这是工具执行结果。`tool_call_id` 原样对应先前的 `id: "call_01"`，这样模型可以知道这条结果回答的是哪次调用。`content` 是字符串；代码用 `JSON.stringify(tool_result)` 把对象转成 JSON 文本。

执行完后程序才发出第二次模型请求。它不是只发送刚才的工具结果，而是发送当前完整的 `messages` 历史，并再次带上 `TOOLS`：

```js
const request2 = {
  messages: [
    { role: "user", content: "我现在所在城市是哪里？" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_01",
          type: "function",
          function: { name: "get_city", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_01",
      content: "{\"city\":\"北京\"}",
    },
  ],
  tools: TOOLS,
};
```

模型要同时看见原问题、自己提出的调用和程序拿到的结果，才能据此继续回答。

### 工具名和执行顺序怎样配合？

1. `TOOLS` 描述模型可以请求哪些功能；模型会根据问题、工具说明和已有历史决定调用什么。
2. 模型返回的 `function.name` 必须能匹配 `call_tool` 中的本地分支。工具描述不会把 Node.js 函数代码发送给模型，也不会替程序执行函数。
3. `tool_call_id` 把某次 `assistant.tool_calls` 和对应的 `role: "tool"` 结果配对。
4. `TOOLS` 数组的排列不规定调用顺序。若一次响应中有多个 `tool_calls`，本章的 `for...of` 配合 `await` 会按模型返回数组的顺序逐个执行。
5. 同一批 `tool_calls` 是模型在看到本轮结果之前一起提出的。如果第二个工具需要第一个工具刚查到的数据，就要先执行第一个、回填结果，再发下一次请求，让模型根据新结果提出第二个调用。

`tools` 和 `tool_calls` 也不是固定的一对一关系：一次请求可以没有工具或带完整工具清单；一条响应可以没有调用、请求一个工具，或请求多个工具。

## 例 4：模型看到结果后给出最终回答

第二次请求里已经带上城市结果。模型可以返回普通的 `assistant` 文本消息：

```json
{
  "role": "assistant",
  "content": "你当前所在的城市是北京"
}
```

这条消息没有 `tool_calls`，所以 `agent.js` 读取 `response.content` 并返回。主循环按以下条件继续或结束：

```js
if (response.tool_calls && response.tool_calls.length > 0) {
  // 执行工具，回填结果，然后进入下一轮
} else {
  return response.content;
}
```

因此，“例 2 到例 4”的演示是两次模型请求：第一次请求工具，Node.js 本地执行一次；第二次请求拿到最终文本。中间的本地工具执行不是模型请求，也没有模型响应。

## `role` 在本章里分别表示谁

| role | 谁发出的消息 | 作用 |
|---|---|---|
| `user` | 用户 | 提出问题，通常是第一条消息 |
| `assistant` | 模型 | 返回普通文本，或提出 `tool_calls` |
| `tool` | Node.js 代表工具写入 | 返回本地工具执行结果，并带 `tool_call_id` |

本章没有设置 `system` 消息。最关键的区别是：**工具调用请求仍属于 `assistant`；工具的执行结果才属于 `tool`。**这些不同来源的消息都依次放在同一个 `messages` 数组里。

## 回到代码包：test.js 如何记录三次请求

`agent.js` 里的正常路径会把天气问题拆成两次工具调用。[`test.js`](../test.js#L59) 用脚本化的模型响应离线回放这条路径：

| 时点 | 发给模型的 `messages` | 模型响应 / 本地动作 |
|---|---|---|
| 请求 1 | 只有 `user: 今天的天气怎么样` | 响应 `assistant.tool_calls`：请求 `get_city`；本地返回北京 |
| 请求 2 | 原问题 + `get_city` 调用 + 北京的 `role: tool` 结果 | 响应请求 `get_weather(city=北京)`；本地返回晴 25°C |
| 请求 3 | 上述完整历史 + `get_weather` 调用 + 天气的 `role: tool` 结果 | 响应普通 `assistant.content`，循环结束 |

这条测试路径中有三次模型请求和三次模型响应，中间有两次本地工具执行。`mockLlmFetch` 替换 `fetch` 并记录每个请求体，依次返回事先准备的消息；所以学习者可以在 `m.requests[0]`、`m.requests[1]`、`m.requests[2]` 查看消息数组是如何增长的，不需要 API Key 或联网。它固定的是演示路径；真实模型在真实问题下可能选择不同工具或调用轮数。

## 按文件读关键代码

| 文件 / 位置 | 这里发生什么 | 读的时候问自己 |
|---|---|---|
| [`main.js`](../main.js#L1) | 启动 `run_agent()` 并显示最终结果 | 程序从哪里开始？ |
| [`agent.js`](../agent.js#L14) | 用第一条 `user` 消息创建历史 | 第一次请求会带什么？ |
| [`agent.js`](../agent.js#L25) | 每轮调用 `call_llm(messages, TOOLS)` | 这一轮发了哪些历史和工具说明？ |
| [`llm.js`](../llm.js#L43) | 组成 HTTP 请求并读取 `choices[0].message` | 请求体和模型响应各是什么？ |
| [`agent.js`](../agent.js#L30) | 将完整 `assistant` 响应追加到历史 | 为什么要记住模型刚才要求什么？ |
| [`agent.js`](../agent.js#L32) | 检查 `tool_calls` | 继续执行，还是返回最终文本？ |
| [`tools.js`](../tools.js#L15) | 定义 `TOOLS` 说明书 | 模型能看到哪些名称和参数？ |
| [`tools.js`](../tools.js#L80) | `call_tool` 按名称匹配实现 | 名称如何路由到具体代码？ |
| [`agent.js`](../agent.js#L33) | 按数组顺序逐个 `await` 执行调用 | 顺序由谁返回，程序如何执行？ |
| [`agent.js`](../agent.js#L38) | 把结果写成带 ID 的 `role: "tool"` 消息 | 下一次请求能看到什么？ |
| [`test.js`](../test.js#L40) | 用 mock `fetch` 记录请求并提供固定响应 | 每次请求的完整报文怎样检查？ |

最值得反复读的是 `agent.js` 的这一段：

```js
const response = await call_llm(messages, TOOLS);
messages.push(response);

if (response.tool_calls && response.tool_calls.length > 0) {
  for (const tool_call of response.tool_calls) {
    const tool_result = await call_tool(
      tool_call.function.name,
      tool_call.function.arguments,
    );
    messages.push({
      role: "tool",
      tool_call_id: tool_call.id,
      content: JSON.stringify(tool_result),
    });
  }
} else {
  return response.content;
}
```

读完这一段，自己回答五个问题：第一次调用 `call_llm` 时 `messages` 有什么？模型说要调工具时消息是什么 `role`？程序用什么值匹配本地代码？工具结果追加时有哪些字段？什么情况下循环结束？
