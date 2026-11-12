/**
 * lesson07 · v3: skill_tool —— skill 加载工具（显式触发）
 *
 * 注册进 registry 的普通工具：Agent 推理中可主动调用
 *   skill("code-review") → 返回技能内容 → 按步骤执行
 * 对应 Qwen Code 的 SkillTool。
 *
 * 设计要点：
 *   - 技能名不存在 → 返回错误 + 可用技能清单（帮模型纠错）
 *   - 返回内容 = 技能 body（步骤/要点），作为 tool 结果回填上下文
 *   - 技能清单不进工具 description，而是由 Agent 注入 system prompt
 *     （buildAvailableSkillsPrompt），模型才知道"有哪些技能可调"
 */

/**
 * 创建 skill 工具定义。
 * @param {import("./skill_registry.js").SkillRegistry} skillRegistry
 */
export function createSkillTool(skillRegistry) {
  return {
    name: "skill",
    description:
      "加载一个技能并按其指导执行任务。技能包含完成某类任务的步骤和要点。",
    params: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "技能名",
        },
      },
      required: ["name"],
    },
    fn: async ({ name }) => {
      const skill = skillRegistry.get(name);
      if (!skill) {
        return {
          error: `技能不存在: ${name}`,
          available: skillRegistry.list().map((s) => s.name),
        };
      }
      return {
        skill: {
          name: skill.name,
          description: skill.description,
          content: skill.body,
        },
      };
    },
  };
}

/** 可用技能清单文本（注入 system prompt，让 Agent 知道有什么技能） */
export function buildAvailableSkillsPrompt(registry) {
  const list = registry.list();
  if (list.length === 0) return "";
  return (
    "\n\n## 可用技能（可调用 skill 工具加载）\n" +
    list.map((s) => `- ${s.name}：${s.description}`).join("\n")
  );
}
