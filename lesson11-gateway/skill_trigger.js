/**
 * lesson07 · v4: skill_trigger —— 自动触发（启发式匹配）
 *
 * 对应 Qwen Code 的 SkillActivationRegistry（按文件路径/上下文激活技能）。
 * 本课精简版：根据用户输入匹配技能 when_to_use，命中即自动注入。
 *
 * 注入语义：
 *   - 只注入"最匹配"的 Top N 技能（默认 1），避免技能噪音稀释注意力
 *   - 注入文本标注"已加载技能"，提示模型按技能步骤执行但保留判断力
 *   - 与记忆注入（lesson05）同机制：追加到 system prompt 尾部
 */

import { tokenize } from "./recall.js";

/** 自动注入的技能数上限 */
export const AUTO_INJECT_LIMIT = 1;

/**
 * 匹配用户输入命中的技能。
 * @param {string} userInput
 * @param {import("./skill_registry.js").SkillRegistry} registry
 * @returns {Array<Object>} 命中的技能（含 score）
 */
export function matchSkillsForInput(userInput, registry) {
  return registry.match(userInput).slice(0, AUTO_INJECT_LIMIT);
}

/**
 * 把技能内容格式化为注入文本（追加到 system prompt 尾部）。
 * @param {Array<Object>} skills
 * @returns {string} 空字符串 = 无匹配
 */
export function buildSkillInjection(skills) {
  if (!skills || skills.length === 0) return "";
  return (
    "\n\n## 已加载技能（任务符合该技能场景时，按以下步骤执行）\n" +
    skills
      .map(
        (s) =>
          `### ${s.name}\n` +
          `用途：${s.description}\n` +
          `${s.body}`,
      )
      .join("\n\n")
  );
}
