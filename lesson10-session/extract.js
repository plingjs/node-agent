/**
 * lesson05 · v3: extract —— LLM 记忆提取
 *
 * 把一段对话历史发给 LLM，让它提炼"值得持久化的记忆条目"。
 * 对应 Qwen Code 的 extractionAgentPlanner（forked agent 做提取）。
 *
 * 面试点：
 *   - 提取是"语义压缩"——把对话里的事实变成结构化记忆
 *   - 提取 prompt 决定记忆质量：明确"什么该记"（持久事实/偏好/纠正/项目知识）
 *     和"什么不该记"（临时/寒暄/过程性细节）
 *   - LLM 输出解析要容错：模型常把 JSON 包在 ```json 代码块里
 */

/** 提取规则（质量的关键：该记什么、不该记什么、格式要求） */
export const EXTRACT_SYSTEM_PROMPT = [
  "你是记忆提取器。从对话历史中提取值得持久保存的记忆条目，供未来对话使用。",
  "",
  "必须提取：",
  "  1. 用户的偏好、习惯、工作方式（type: user）",
  "  2. 用户给出的纠正、确认的规则（type: feedback）",
  "  3. 项目相关的背景、决策、约定（type: project）",
  "  4. 外部资源的引用（type: reference）",
  "",
  "不要提取：临时性问题、寒暄、过程性细节、对话中已解决且不再相关的内容。",
  "如果没有值得保存的，返回空数组 []。",
  "",
  "输出严格为 JSON 数组，每个元素：",
  '{"name": "简短标题", "description": "一行描述（用于未来判断相关性）", "type": "user|feedback|project|reference", "body": "记忆正文，可包含 Why: 和 How to apply: 两行"}',
  "不要输出 JSON 以外的任何文字。",
].join("\n");

/** 解析 LLM 输出的记忆条目（容错：支持 ```json 代码块包裹） */
export function parseExtractOutput(text) {
  const trimmed = (text || "").trim();
  // 去掉 ```json ... ``` 代码块包裹
  const blockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = blockMatch ? blockMatch[1] : trimmed;
  try {
    const data = JSON.parse(jsonText);
    if (!Array.isArray(data)) return [];
    return data.filter((d) => d && typeof d.name === "string" && d.name.trim());
  } catch {
    // 尝试提取第一个 [ ... ] 片段
    const arrMatch = jsonText.match(/\[[\s\S]*\]/);
    if (!arrMatch) return [];
    try {
      const data = JSON.parse(arrMatch[0]);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }
}

/**
 * 从对话消息中提取记忆条目。
 * @param {Function} llm - LLM 调用函数（注入）
 * @param {Array<Object>} messages - 待分析的对话消息（快照）
 * @param {Array<Object>} existingMemories - 已有记忆（提示 LLM 避免重复）
 * @returns {Promise<Array<Object>>} 提取出的记忆条目（可能为空）
 */
export async function extractMemories(llm, messages, existingMemories = []) {
  const existingText = existingMemories
    .map((m) => `- ${m.name}: ${m.description}`)
    .join("\n");

  const userPrompt = [
    "以下是已有记忆（避免重复提取）：",
    existingText || "（无）",
    "",
    "以下是本段对话历史：",
    JSON.stringify(messages),
  ].join("\n");

  const resp = await llm(
    [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    null, // 提取是纯文本任务，不带工具
  );

  return parseExtractOutput(resp.content);
}
