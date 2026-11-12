/**
 * lesson13 · streaming —— LLM 流式输出（SSE）
 *
 * OpenAI 兼容接口的 stream: true → 响应是 SSE（Server-Sent Events）：
 *   data: {"choices":[{"delta":{"content":"你"}}]}
 *   data: {"choices":[{"delta":{"content":"好"}}]}
 *   data: [DONE]
 *
 * 零依赖实现：fetch 读 body stream（getReader + TextDecoder 解码），
 * 按行解析 data: 前缀，逐 delta 回调。
 *
 * 集成方式（关键设计）：createStreamingLlm 返回**兼容 call_llm 签名**的
 * 函数 —— agent 代码零改动，流式只是 LLM 函数内部实现。
 * 超时：与 llm.js 一致（AbortController），超时抛可识别错误（可重试）。
 */

import { LlmError, errorFromStatus } from "./llm_retry.js";

/**
 * 创建流式 LLM 函数（兼容 call_llm(messages, tools) 签名）。
 * @param {Object} config {baseUrl, apiKey, model}
 * @param {Function} [onDelta] 逐 token 回调 (text) => void
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs] 超时，默认 60s
 * @returns {Function} async (messages, tools) => { role, content, tool_calls }
 */
export function createStreamingLlm(config, onDelta = null, { timeoutMs = 60000 } = {}) {
  const { baseUrl, apiKey, model } = config;

  return async (messages, tools) => {
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          tools,
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new LlmError(`LLM 流式调用超时（${timeoutMs}ms）`, { retryable: true });
      }
      throw e; // 网络错误（TypeError）→ isRetryable 为 true
    }

    if (!resp.ok) {
      clearTimeout(timer);
      throw errorFromStatus(resp.status, `LLM API ${resp.status}: ${await resp.text()}`);
    }

    try {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";
      const callsByIndex = new Map();

      function consumeLine(line) {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            if (onDelta) onDelta(delta.content);
          }

          // 流式工具调用会分多段到达：先给出 id/name，之后逐步补全 arguments。
          for (const part of delta?.tool_calls || []) {
            const index = Number.isInteger(part.index) ? part.index : callsByIndex.size;
            let call = callsByIndex.get(index);
            if (!call) {
              call = { id: "", type: "function", function: { name: "", arguments: "" } };
              callsByIndex.set(index, call);
            }
            if (part.id) call.id = part.id;
            if (part.type) call.type = part.type;
            if (part.function?.name) call.function.name += part.function.name;
            if (part.function?.arguments) call.function.arguments += part.function.arguments;
          }
        } catch {
          // 忽略无法解析的行
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 按行分隔，逐行解析
        const lines = buffer.split("\n");
        buffer = lines.pop(); // 最后一段可能不完整，留到下一轮

        for (const line of lines) consumeLine(line);
      }

      // 流结束时处理 decoder 与 buffer 里尚未以换行符结束的最后一行。
      buffer += decoder.decode();
      if (buffer.trim()) consumeLine(buffer.trim());

      const toolCalls = [...callsByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call);
      return {
        role: "assistant",
        content: fullContent,
        tool_calls: toolCalls.length ? toolCalls : null,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
