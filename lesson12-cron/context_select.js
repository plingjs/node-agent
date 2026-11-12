/**
 * lesson06 · v4: context_select —— 子 Agent 的上下文选择
 *
 * 两种模式（对应 Qwen Code 的 Regular Subagent vs Fork）：
 *   INDEPENDENT  独立上下文：子 Agent 只看任务描述（默认，推荐）
 *   FORK         继承上下文：把父的近期对话注入子 Agent 作背景
 *
 * 面试点：默认独立，为什么？
 *   1. 防污染：子 Agent 的探索过程不塞爆父的上下文
 *   2. 防串扰：子任务 A 的历史不影响子任务 B
 *   3. 防越权：子 Agent 只看到"该看的"，不知道父的无关细节
 *   Fork 只在"子任务强依赖父上下文"时用（如"根据我刚说的继续改"），
 *   且只传近期窗口（recent），不传全量历史。
 */

export const CONTEXT_MODE = {
  INDEPENDENT: "independent",
  FORK: "fork",
};

/**
 * 决定子 Agent 是否注入父上下文（以及注入多少）。
 * @param {string} mode
 * @param {Array<Object>} parentRecent 父的近期消息
 * @param {number} [maxInherit] 最多继承多少条（默认 4）
 * @returns {Array<Object>|null} 注入的消息（null = 独立模式）
 */
export function buildInheritedContext(mode, parentRecent, maxInherit = 4) {
  if (mode !== CONTEXT_MODE.FORK) return null;
  if (!parentRecent || parentRecent.length === 0) return null;
  // 只继承最近窗口（时间局部性），且只继承对话部分
  return parentRecent.slice(-maxInherit).map((m) => ({ ...m }));
}
