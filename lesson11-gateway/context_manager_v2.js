/**
 * 第3课 · v5: context_manager_v2 —— 三层上下文 + Token 预算 + 工具结果截断
 *
 * v3 是"截断"，v4 是"压缩"，v5 把它们组合成生产级的三层结构：
 *
 *   messages = [
 *     system 层   （永不压缩：角色/规则/工具说明）
 *     summary 层  （已压缩的旧历史，LLM 定期生成）
 *     recent 层   （近期原始消息，保留原文）
 *     ...工具结果（超大时截断 + 可选持久化）
 *   ]
 *
 * 这对应 Qwen Code 的 auto-compact：不是等溢出才处理，而是
 * 达到水位线（如 80%）就提前触发压缩，把 recent 前半段并进 summary。
 */

import { countTokens, estimateTokens } from "./token_counter.js";
import { summarize } from "./summary_compactor.js";

/** 工具结果最大 token 数（超过则截断 head+tail） */
const MAX_TOOL_RESULT_TOKENS = 1000;

/**
 * 截断超大的工具结果：保留 head 与 tail，中间用省略标记。
 * 面试点：工具可能返回几 MB 的数据（读大文件、查日志、HTTP 响应），
 * 直接塞进 context 会瞬间打爆预算。策略：head+tail 保留 + 落盘/记文件路径。
 */
export function truncateToolResult(text, maxTokens = MAX_TOOL_RESULT_TOKENS) {
  if (estimateTokens(text) <= maxTokens) return text;
  const half = Math.floor(maxTokens / 2);
  // 按字符近似切（配合 estimateTokens 的 4:1，取 4 倍字符数）
  const headChars = half * 4;
  const tailChars = half * 4;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  return `${head}\n...[中间 ${text.length - headChars - tailChars} 字符已截断]...\n${tail}`;
}

export class TieredContextManager {
  /**
   * @param {Object} opts
   * @param {number} opts.maxTokens        总预算（context window）
   * @param {number} [opts.reserveForOutput] 为模型输出预留的 token
   * @param {number} [opts.compactRatio]   达到多少比例触发压缩（默认 0.8）
   * @param {number} [opts.keepRecent]     压缩时保留最近多少条原文
   */
  constructor({
    maxTokens,
    reserveForOutput = 0,
    compactRatio = 0.8,
    keepRecent = 6,
  }) {
    this.maxTokens = maxTokens;
    this.reserveForOutput = reserveForOutput;
    // 触发压缩的水位线：可用预算的 compactRatio
    this.compactThreshold = Math.floor((maxTokens - reserveForOutput) * compactRatio);
    this.keepRecent = keepRecent;

    this.system = [];
    this.summary = ""; // 摘要层（压缩产物）
    this.recent = [];  // 近期原始消息
  }

  /** 初始化 system 层（永不压缩） */
  setSystem(messages) {
    this.system = messages;
  }

  /** 追加一条消息（用户输入 / 模型回复 / 工具结果） */
  append(msg) {
    this.recent.push(msg);
  }

  /** 当前组装出的完整消息列表（发给 LLM 的样子） */
  build() {
    const parts = [...this.system];
    if (this.summary) {
      parts.push({ role: "user", content: `[对话历史摘要]\n${this.summary}` });
    }
    parts.push(...this.recent);
    return parts;
  }

  /** 当前总 token（不含输出预留） */
  totalTokens() {
    return countTokens(this.build());
  }

  /** 是否达到压缩水位线 */
  needsCompaction() {
    return this.totalTokens() > this.compactThreshold;
  }

  /**
   * 触发压缩：把 recent 前半段压进 summary，保留最近 keepRecent 条。
   * @param {Function} llm
   */
  async compact(llm) {
    if (this.recent.length === 0) return;

    // 通常保留最近 keepRecent 条。若消息不多但预算仍超限，也压缩旧消息，
    // 至少尝试留下最后一条；单条消息本身超过预算时则压缩整段历史。
    let split = Math.max(1, this.recent.length - this.keepRecent);
    // 关键修复：切点不能落在 role="tool" 消息上。
    // 否则会拆散 "assistant(tool_calls) → tool 结果" 的配对，
    // build() 后 tool 消息前面没有 tool_calls，API 报 400。
    // 把切点前移，让对应的 assistant(tool_calls) 一起留在 recent。
    while (split > 0 && this.recent[split]?.role === "tool") {
      split -= 1;
    }

    // 如果历史开头就是一个完整的多工具调用组，切点前移后会变成 0。
    // 整组压进摘要，避免保留只有部分 tool 结果的无效上下文。
    if (split === 0) split = this.recent.length;

    const toSummarize = this.recent.slice(0, split);
    const remaining = this.recent.slice(split);

    const newSummary = await summarize(llm, toSummarize);
    // 摘要本身也可被再次压缩（递归压缩）：旧摘要 + 新摘要再压一次
    if (this.summary) {
      const merged = await summarize(llm, [
        { role: "assistant", content: this.summary },
        { role: "assistant", content: newSummary },
      ]);
      this.summary = merged;
    } else {
      this.summary = newSummary;
    }
    this.recent = remaining;
  }

  /** 预算分配报告（面试点：展示给用户/日志的账本） */
  budget() {
    const systemTokens = countTokens(this.system);
    const summaryTokens = this.summary ? estimateTokens(this.summary) : 0;
    const recentTokens = countTokens(this.recent);
    return {
      maxTokens: this.maxTokens,
      reservedForOutput: this.reserveForOutput,
      compactThreshold: this.compactThreshold,
      used: {
        system: systemTokens,
        summary: summaryTokens,
        recent: recentTokens,
        total: systemTokens + summaryTokens + recentTokens,
      },
    };
  }
}
