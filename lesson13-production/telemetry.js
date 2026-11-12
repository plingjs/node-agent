/**
 * lesson13 · telemetry —— 观测（trace + token + 成本估算）
 *
 * 生产 Agent 必须"可观测"：每次 LLM 调用记 token/耗时、每次工具调用记状态，
 * 才能回答"花了多少钱、慢在哪、哪出错"。
 * 对应真实产品：LangSmith / Arize / Qwen Code 的 telemetry。
 *
 * 与 lesson08 audit-log 插件的关系：
 *   audit-log 是"审计"（合规留痕，可插拔插件）
 *   telemetry 是"观测"（性能/成本，Agent 内建）
 *   一个管"该不该发生"，一个管"发生得怎么样"。
 */

/** 简化的模型价格表（元/百万 token，教学用近似值） */
const PRICE_TABLE = {
  "glm-4-flash": { input: 0.1, output: 0.1 },
  "glm-4": { input: 0.5, output: 0.5 },
  "deepseek-chat": { input: 1.0, output: 2.0 },
  default: { input: 0.5, output: 1.5 },
};

export class Telemetry {
  constructor({ now = () => Date.now(), priceTable = PRICE_TABLE } = {}) {
    this.now = now;
    this.priceTable = priceTable;
    /** 事件日志（内存，可扩展为写文件/上报） */
    this.events = [];
  }

  record(event) {
    this.events.push({ ts: this.now(), ...event });
  }

  /** LLM 调用记录（token 用估算，见 token_counter） */
  llmCall({ model, promptTokens, completionTokens, durationMs, ok = true }) {
    this.record({
      type: "llm",
      model,
      promptTokens,
      completionTokens,
      durationMs,
      ok,
    });
  }

  /** 工具调用记录（与 hooks 集成，main.js 里接线） */
  toolCall({ name, status, durationMs }) {
    this.record({ type: "tool", name, status, durationMs });
  }

  /** 成本估算（元）：按价格表 × token 数 */
  estimateCost(model, promptTokens, completionTokens) {
    const p = this.priceTable[model] || this.priceTable.default;
    return (
      (promptTokens / 1_000_000) * p.input +
      (completionTokens / 1_000_000) * p.output
    );
  }

  /** 汇总统计：调用次数/总 token/估算成本/平均耗时/错误率 */
  summary() {
    const llmEvents = this.events.filter((e) => e.type === "llm");
    const toolEvents = this.events.filter((e) => e.type === "tool");

    let promptTokens = 0;
    let completionTokens = 0;
    let llmDuration = 0;
    let llmErrors = 0;
    for (const e of llmEvents) {
      promptTokens += e.promptTokens || 0;
      completionTokens += e.completionTokens || 0;
      llmDuration += e.durationMs || 0;
      if (!e.ok) llmErrors += 1;
    }

    const model = llmEvents[0]?.model || "";
    const cost = this.estimateCost(model, promptTokens, completionTokens);

    return {
      llmCalls: llmEvents.length,
      toolCalls: toolEvents.length,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostYuan: Number(cost.toFixed(4)),
      avgLlmDurationMs: llmEvents.length
        ? Math.round(llmDuration / llmEvents.length)
        : 0,
      llmErrorRate: llmEvents.length
        ? Number((llmErrors / llmEvents.length).toFixed(2))
        : 0,
    };
  }
}
