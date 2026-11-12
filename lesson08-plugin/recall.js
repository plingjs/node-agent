/**
 * lesson05 · v4: recall —— 记忆召回（关键词评分 + 可选 LLM 精排）
 *
 * 对应 Qwen Code 的 memory/recall（两阶段：关键词粗排 → LLM 精排）。
 *
 * 面试点：
 *   - 生产用向量检索（embedding 相似度），零依赖用关键词评分
 *   - 关键词评分便宜快、零 LLM 成本；LLM 精排准但贵
 *   - 可级联：粗排缩小候选集（Top N）→ 精排做最终选择
 *   - 评分权重：description 最高（它就是为相关性设计的）、name 次之、body 最低
 */

/** 候选上限（粗排后留给精排/注入的条数） */
export const RECALL_LIMIT = 5;

/** 中文/英文混合的关键词提取：英文按词（≥2 字符），中文按 2-gram */
export function tokenize(text) {
  const tokens = new Set();
  const str = String(text || "").toLowerCase();

  // 英文/数字词（≥2 字符）
  for (const m of str.match(/[a-z0-9]{2,}/g) || []) {
    tokens.add(m);
  }
  // 中文：2-gram（覆盖大部分中文关键词）
  const cjk = str.match(/[\u4e00-\u9fff]+/g) || [];
  for (const chunk of cjk) {
    for (let i = 0; i < chunk.length - 1; i++) {
      tokens.add(chunk.slice(i, i + 2));
    }
  }
  return [...tokens];
}

/** 单条记忆的评分：description(+3) > name(+2) > body(+1) */
function scoreMemory(queryTokens, memory) {
  const name = String(memory.name || "").toLowerCase();
  const desc = String(memory.description || "").toLowerCase();
  const body = String(memory.body || "").toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (desc.includes(token)) score += 3;
    if (name.includes(token)) score += 2;
    if (body.includes(token)) score += 1;
  }
  return score;
}

/**
 * 关键词评分召回：query → 排序后的 Top N 记忆。
 * @param {string} query
 * @param {Array<Object>} memories
 * @param {number} [limit]
 * @returns {Array<Object>} 按分数降序
 */
export function recallByKeywords(query, memories, limit = RECALL_LIMIT) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  return memories
    .map((m) => ({ memory: m, score: scoreMemory(tokens, m) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.memory);
}

/**
 * 可选：LLM 精排 —— 从候选里选出真正相关的（减噪音）。
 * @param {Function} llm
 * @param {string} query
 * @param {Array<Object>} candidates
 * @returns {Promise<Array<Object>>} 精排后的记忆
 */
export async function rerankByLLM(llm, query, candidates) {
  if (candidates.length <= 1) return candidates;

  const userPrompt = [
    `用户当前问题：${query}`,
    "",
    "候选记忆：",
    candidates.map((m, i) => `${i}. ${m.name} — ${m.description}`).join("\n"),
    "",
    "只返回 JSON 对象：relevant 是相关候选记忆的序号数组，不相关的不要返回。",
    '例如：{"relevant": [0, 2]}',
  ].join("\n");

  const resp = await llm(
    [
      {
        role: "system",
        content: "你是记忆相关性判断器。只输出 JSON，不要其他文字。",
      },
      { role: "user", content: userPrompt },
    ],
    null,
  );

  try {
    const content = String(resp.content)
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const data = JSON.parse(content);
    if (Array.isArray(data.relevant)) {
      return data.relevant
        .map((i) => candidates[i])
        .filter(Boolean);
    }
  } catch {
    // 解析失败 → 保守返回全部候选（粗排已缩小范围）
  }
  return candidates;
}
