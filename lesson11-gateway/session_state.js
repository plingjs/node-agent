/**
 * lesson10 · v1: session_state —— 上下文序列化/反序列化
 *
 * Session 保存恢复的核心：把 cm 的三层状态（system + summary + recent）
 * 序列化为可存盘的 JSON，恢复时原样填回。
 *
 * 关键设计（面试必讲）：
 *   1. 只持久化"基础 system"——每轮注入的记忆召回/技能是临时的，
 *      恢复后第一轮 run 自动重新召回（与正常流程一致，零额外代码）
 *   2. tool_calls/tool 配对完整性——序列化时截断到完整配对，
 *      防止恢复后 tool 消息前面没有 assistant(tool_calls)（lesson04 的坑）
 *   3. 消息浅拷贝——序列化不引用原对象，防外部修改污染 cm
 */

/**
 * 截断消息到"完整配对"边界：去掉孤立的 tool 消息及其之后的所有消息。
 * （防御性：正常流程不会产生孤立 tool，这是恢复前的最后一道保险）
 */
export function truncateToCompletePairs(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const replies = [];
      for (let j = 0; j < m.tool_calls.length; j++) {
        const reply = messages[i + 1 + j];
        if (
          !reply ||
          reply.role !== "tool" ||
          reply.tool_call_id !== m.tool_calls[j].id
        ) break;
        replies.push(reply);
      }
      // 工具调用组必须全部配齐；不完整时连 assistant 消息也不保留。
      if (replies.length !== m.tool_calls.length) break;
      out.push(m, ...replies);
      i += replies.length;
      continue;
    }
    if (m.role === "tool") {
      // tool 结果只能由上面的完整工具调用组写入，孤立结果立即截断。
      break;
    }
    out.push(m);
  }
  return out;
}

/**
 * 序列化 cm → 可存盘的 plain object。
 * @param {import("./context_manager_v2.js").TieredContextManager} cm
 * @returns {{system: Array, summary: string, recent: Array}}
 */
export function serializeContext(cm) {
  return {
    system: (cm.system || []).map((m) => ({ ...m })),
    summary: cm.summary || "",
    recent: truncateToCompletePairs(cm.recent || []).map((m) => ({ ...m })),
  };
}

/**
 * 反序列化：把状态填回 cm（覆盖当前内容）。
 * @param {import("./context_manager_v2.js").TieredContextManager} cm
 * @param {Object} state serializeContext 的产物
 */
export function restoreContext(cm, state) {
  const s = state || {};
  cm.system = (s.system || []).map((m) => ({ ...m }));
  cm.summary = s.summary || "";
  cm.recent = truncateToCompletePairs(s.recent || []).map((m) => ({ ...m }));
}

/** 从序列化状态重建一个全新的 cm（SessionManager.load 用） */
export function rebuildContext(TieredContextManager, state) {
  const cm = new TieredContextManager({
    maxTokens: 4096,
    reserveForOutput: 512,
    compactRatio: 0.8,
    keepRecent: 6,
  });
  restoreContext(cm, state);
  return cm;
}
