/**
```
请求:
  POST /chat/completions
  {
    "messages": [...],
    "tools": [                       ← 工具说明书（JSON Schema）
      {"type": "function",
       "function": {
         "name": "get_weather",
         "description": "查询天气",
         "parameters": {"type": "object", "properties": {"city": {...}}, "required": ["city"]}
       }}
    ]
  }

响应:
  message: {
    "content": null,
    "tool_calls": [                  ← 模型决定调用工具
      {"id": "call_abc123",
       "type": "function",
       "function": {"name": "get_weather", "arguments": "{\"city\": \"北京\"}"}}
    ]
  }
```

然后**由我们（Agent 框架）**执行工具，把结果按协议回填：

```
请求:
  messages: [
    ..., 模型那条带 tool_calls 的消息,
    {"role": "tool", "tool_call_id": "call_abc123", "content": "{\"city\":\"北京\",\"weather\":\"晴 25°C\"}"}
  ]
```
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export async function call_llm(messages, tools) {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            messages,
            tools,
        }),
    });
    const data = await response.json();
    return data.choices[0].message;
}