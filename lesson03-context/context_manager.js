/**
 * 第3课 · v3: context_manager —— 保留 system + 分层截断
 *
 * 修复 v2 滑动窗口的致命缺陷：system prompt 永不截断。
 * 策略升级为"分层"：
 *   1. system 消息永远保留（角色/规则/工具说明，丢失即失控）
 *   2. 最后一条 user 消息永远保留（用户当前指令，丢失即答非所问）
 *   3. 中间历史从旧到新逐步丢弃，直到预算内
 *
 * 面试点：为什么 system 不能丢？
 *   system prompt 承载模型的行为约束（"你是助手""只读操作""输出 JSON"），
 *   丢掉后模型会"忘记自己是谁"，可能做出越界行为。
 */

import { countTokens, estimateMessageTokens } from "./token_counter.js";

export class ContextManager {
  constructor({ maxTokens }) {
    this.maxTokens = maxTokens;
  }

  /**
   * 分层截断。
   * @returns {Array<Object>} 保留下来的消息
   */
  trim(messages) {
    if (messages.length === 0) return [];

    const systemMsgs = messages.filter((m) => m.role === "system");
    const lastUser = messages[messages.length - 1].role === "user"
      ? messages[messages.length - 1]
      : null;

    // 中间可裁剪的历史（排除 system 和最后一条 user）
    const middle = messages.filter(
      (m) => m.role !== "system" && m !== lastUser,
    );

    let budget = this.maxTokens;
    const kept = [];

    // 1. system 先占预算
    for (const s of systemMsgs) {
      const t = estimateMessageTokens(s);
      kept.push(s);
      budget -= t;
    }

    // 2. 最后一条 user 先占预算（从尾部往前，保证它一定在）
    const tail = [];
    if (lastUser) {
      const t = estimateMessageTokens(lastUser);
      tail.unshift(lastUser);
      budget -= t;
    }

    // 3. 中间历史从新到旧填充剩余预算
    const filled = [];
    for (let i = middle.length - 1; i >= 0; i--) {
      const t = estimateMessageTokens(middle[i]);
      if (budget - t < 0) break;
      filled.unshift(middle[i]);
      budget -= t;
    }

    return [...kept, ...filled, ...tail];
  }

  /** 当前是否超预算 */
  isOverBudget(messages) {
    return countTokens(messages) > this.maxTokens;
  }
}
