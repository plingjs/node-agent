/**
 * lesson13 · llm_chain —— 生产级 LLM 调用链组装
 *
 * 把三个生产化能力组合成一条调用链（agent 只看到最终函数，零改动）：
 *
 *   traced( withRetry( base ) )
 *     │        │        └─ base：call_llm（非流式）或 createStreamingLlm（流式）
 *     │        └─ 重试 + 熔断：可重试错误指数退避，连续失败短路
 *     └─ 观测：每次调用记 token/耗时/成本/错误（Telemetry）
 *
 * 面试点：装饰器模式层层包装——agent 拿到的还是一个
 * (messages, tools) => message 的函数，生产能力全部透明叠加。
 */

import { withRetry, CircuitBreaker } from "./llm_retry.js";
import { countTokens } from "./token_counter.js";

/**
 * 组装生产级 LLM 函数。
 * @param {Object} opts
 * @param {Function} opts.base 底层 LLM 调用（call_llm 或 createStreamingLlm 产物）
 * @param {string} opts.model 模型名（观测用）
 * @param {import("./telemetry.js").Telemetry} opts.telemetry
 * @param {CircuitBreaker} [opts.breaker]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.baseDelayMs]
 * @returns {Function} (messages, tools) => message
 */
export function createLlmChain({ base, model, telemetry, breaker, maxRetries = 3, baseDelayMs = 500 }) {
  const cb = breaker || new CircuitBreaker();

  // ── 内层：重试 + 熔断 ──
  const retried = withRetry(base, {
    maxRetries,
    baseDelayMs,
    breaker: cb,
    onRetry: (info) => telemetry.record({ type: "retry", ...info }),
  });

  // ── 外层：观测（每次调用记 token/耗时/错误）──
  const llm = async (messages, tools) => {
    const t0 = Date.now();
    try {
      const r = await retried(messages, tools);
      telemetry.llmCall({
        model,
        promptTokens: countTokens(messages),
        completionTokens: estimateCompletionTokens(r),
        durationMs: Date.now() - t0,
      });
      return r;
    } catch (e) {
      telemetry.llmCall({ model, ok: false, durationMs: Date.now() - t0 });
      throw e;
    }
  };

  // 返回 llm + breaker（main.js /stats 可展示熔断状态）
  return { llm, breaker: cb };
}

/** 补全 token 估算：回复内容 + tool_calls 参数 */
function estimateCompletionTokens(result) {
  let text = result.content || "";
  for (const tc of result.tool_calls || []) {
    text += " " + (tc.function?.arguments || "");
  }
  return countTokens([{ role: "assistant", content: text }]);
}
