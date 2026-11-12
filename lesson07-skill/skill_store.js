/**
 * lesson07 · v1: skill_store —— Skill 存储与解析
 *
 * Skill = skills/<name>/SKILL.md，frontmatter + body：
 *   name        技能名（唯一标识）
 *   description 一句话描述（Agent 判断何时用它）
 *   when_to_use 触发场景（自动匹配的关键字段）
 *   tools       技能用到的工具白名单（可选）
 *   body        步骤/要点/示例（注入后指导 Agent 执行）
 *
 * 对应 Qwen Code 的 `.qwen/skills/<name>/SKILL.md` 和 Hermes 的 skill 系统
 * （当前会话就在用 agent-course-builder 这个 skill 指导本课程）。
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 技能根目录（本课固定放课程目录下） */
export const SKILLS_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "skills",
);

/** 解析 SKILL.md 内容 → skill 对象（解析失败返回 null）
 *  正则宽容：frontmatter 结束分隔符后允许任意数量换行（空行可有可无） */
export function parseSkill(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!m) return null;

  const meta = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "tools") {
      // tools: [a, b] → ["a", "b"]
      meta[key] = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      meta[key] = value;
    }
  }
  if (!meta.name) return null;

  return {
    name: meta.name,
    description: meta.description || "",
    when_to_use: meta.when_to_use || "",
    tools: meta.tools || [],
    body: m[2].trim(),
  };
}

/** 序列化 skill 对象 → SKILL.md 内容（测试往返用） */
export function serializeSkill(skill) {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `when_to_use: ${skill.when_to_use}`,
    `tools: [${(skill.tools || []).join(", ")}]`,
    "---",
    "",
    skill.body.trim(),
    "",
  ].join("\n");
}

/** 加载 skills/ 目录下所有技能（每个子目录一个 SKILL.md） */
export async function loadAllSkills() {
  let dirs = [];
  try {
    dirs = await readdir(SKILLS_ROOT);
  } catch {
    return []; // 目录不存在
  }

  const skills = [];
  for (const dir of dirs) {
    const skillPath = path.join(SKILLS_ROOT, dir, "SKILL.md");
    try {
      const content = await readFile(skillPath, "utf8");
      const skill = parseSkill(content);
      if (skill) skills.push(skill);
    } catch {
      // 非技能目录（无 SKILL.md）跳过
    }
  }
  return skills;
}
