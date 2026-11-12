/**
 * 第3课 · v4: summary_compactor —— LLM 摘要压缩（Compaction）
 *
 * v3 截断是"丢信息"，v4 升级为"压信息"：
 * 用 LLM 把一段旧历史压缩成摘要，用摘要替换原始历史。
 * 对应 Qwen Code 的 geminiChat.compactHistory + services/microcompaction。
 *
 * 面试点（本课灵魂）：
 *   截断 vs 压缩 —— 截断按"位置"取舍（旧的丢），压缩按"语义"取舍（关键信息保留）。
 *   摘要的核心诉求：保留"决策、事实、未完成事项、用户偏好"，
 *   丢弃"过程性的啰嗦"。
 */

/** 摘要 prompt（告诉模型压缩时保留什么） */
const SUMMARIZE_SYSTEM = [
  "你把一段对话历史压缩成摘要，供后续对话继续使用。",
  "必须保留：",
  "  1. 用户的目标、约束、已确认的决策",
  "  2. 关键事实与数据（数字、路径、结论）",
  "  3. 未完成的事项与下一步",
  "  4. 用户的偏好与纠正",
  "必须丢弃：过程性的寒暄、重复表述、已解决且不再相关的细节。",
  "只输出摘要正文，不要任何前缀。",
].join("\n");

/**
 * 用 LLM 把一段消息压缩成摘要文本。
 * @param {Function} llm - LLM 调用函数（注入，便于测试）
 * @param {Array<Object>} messages - 待压缩的消息（不含 system）
 * @returns {Promise<string>} 摘要文本
 */
export async function summarize(llm, messages) {
  const resp = await llm(
    [
      { role: "system", content: SUMMARIZE_SYSTEM },
      { role: "user", content: "请压缩以下对话历史：\n\n" + JSON.stringify(messages) },
    ],
    null, // 不带 tools —— 摘要调用是纯文本任务
  );
  return (resp.content || "").trim();
}

/**
 * 把一个消息列表的"旧段"压成一条摘要消息。
 * @returns {{ summaryMessage: Object, remaining: Array<Object> }}
 */
export async function compact(llm, messages, keepRecent) {
  // keepRecent 条最近的保留原文，其余压成摘要
  const splitPoint = Math.max(0, messages.length - keepRecent);
  const toSummarize = messages.slice(0, splitPoint);
  const remaining = messages.slice(splitPoint);

  if (toSummarize.length === 0) {
    return { summaryMessage: null, remaining };
  }

  const summaryText = await summarize(llm, toSummarize);
  const summaryMessage = {
    role: "user",
    content: `[对话历史摘要]\n${summaryText}`,
  };
  return { summaryMessage, remaining };
}
