/**
 * 第3课 · v2: sliding_window —— 滑动窗口截断
 *
 * 最简单的上下文控制：超过预算就从最旧的消息开始丢。
 * 这个版本故意暴露它的缺陷，作为 v3 的对照。
 *
 * 缺陷（面试必问）：
 *   1. 会丢掉 system prompt —— 模型失去角色定义和行为约束
 *   2. 会丢掉早期的关键信息（用户目标、约束、已确认的决策）
 *   3. 按"消息条数"或"字符数"截断，而不是按"信息价值"截断
 */

import { estimateMessageTokens } from "./token_counter.js";

/**
 * 从最新往前保留，直到预算满。
 * @param {Array<Object>} messages
 * @param {number} maxTokens
 * @returns {Array<Object>} 截断后的消息（可能不含 system！）
 */
export function slidingWindow(messages, maxTokens) {
  const kept = [];
  let total = 0;

  // 从最新往旧走（时间局部性：近期消息更重要）
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(messages[i]);
    if (total + t > maxTokens) break;
    kept.unshift(messages[i]);
    total += t;
  }
  return kept;
}

/**
 * 演示缺陷：如果 system prompt 很长，滑动窗口可能把它挤掉。
 * 返回 true 表示 system 被保留，false 表示被丢（缺陷触发）。
 */
export function isSystemPreserved(original, trimmed) {
  if (original.length === 0) return true;
  const hasSystem = original[0].role === "system";
  if (!hasSystem) return true;
  return trimmed.length > 0 && trimmed[0].role === "system";
}
