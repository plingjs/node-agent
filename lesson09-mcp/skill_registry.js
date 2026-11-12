/**
 * lesson07 · v2: skill_registry —— 技能注册与查询
 *
 * 在 v1 存储层之上提供：
 *   load()   加载全部技能到内存 Map（进程内缓存）
 *   list()   列出全部
 *   get()    按名取
 *   match()  关键词匹配（query 命中 when_to_use / description 加权打分）
 *
 * 匹配权重设计：when_to_use（触发场景）> description（用途）> name（标识）。
 * 复用 lesson05 recall.js 的 tokenize（中英文关键词提取）。
 */

import { loadAllSkills } from "./skill_store.js";
import { tokenize } from "./recall.js";

export class SkillRegistry {
  constructor() {
    /** @type {Map<string, Object>} name -> skill */
    this.skills = new Map();
  }

  /** 从 skills/ 目录加载全部技能（可重复调用，幂等） */
  async load() {
    const all = await loadAllSkills();
    this.skills = new Map(all.map((s) => [s.name, s]));
    return this;
  }

  list() {
    return [...this.skills.values()];
  }

  get(name) {
    return this.skills.get(name) || null;
  }

  /**
   * 关键词匹配：query 命中技能返回匹配列表（按分数降序）。
   * 匹配字段权重：when_to_use +2 / description +1 / name +1
   * @param {string} query
   * @returns {Array<Object>} 匹配的技能（含 score 字段）
   */
  match(query) {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    return this.list()
      .map((skill) => {
        const whenToUse = String(skill.when_to_use || "").toLowerCase();
        const desc = String(skill.description || "").toLowerCase();
        const name = String(skill.name || "").toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (whenToUse.includes(token)) score += 2;
          if (desc.includes(token)) score += 1;
          if (name.includes(token)) score += 1;
        }
        return { ...skill, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}
