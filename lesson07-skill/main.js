/**
 * lesson07 · 入口 —— Skill 系统 REPL
 *
 * 演示：输入"帮我 review 一下 lesson07-skill 目录的代码" → 自动加载 code-review 技能
 * 元命令：/skills 列出技能 /memories /forget <名称> /budget /reset /exit
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { call_llm } from "./llm.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { listMemories } from "./memory_entries.js";
import { buildCoreTools } from "./core_tools.js";
import { SkillRegistry } from "./skill_registry.js";

const rl = createInterface({ input: stdin, output: stdout });

async function cliConfirm(name, args) {
  console.log(`\n  ⚠️  需要确认: ${name}(${JSON.stringify(args)})`);
  const choice = (await rl.question("  批准? (y=一次 / a=始终允许 / n=拒绝): ")).trim().toLowerCase();
  if (choice === "a") return "always";
  return choice === "y";
}

const SYSTEM_PROMPT =
  "你是带长期记忆、委派能力和领域技能的代码助手。" +
  "能用工具直接干活；复杂任务可委派子 Agent；任务符合技能场景时按技能步骤执行。" +
  "回答简洁准确，用户偏好相关时优先参考记忆。" +
  "用户提问与本机文件/代码相关时，先用工具探索再回答。";

async function repl() {
  const registry = buildCoreTools(cliConfirm);
  const memory = new MemoryManager();
  const skills = new SkillRegistry();
  const agent = new Agent({
    llm: call_llm,
    memory,
    registry,
    systemPrompt: SYSTEM_PROMPT,
    maxDepth: 2,
    skills,
    verbose: true,
  });

  await skills.load();
  console.log("=== Skill 系统（lesson07）===");
  console.log(`可用技能：${skills.list().map((s) => s.name).join(" / ")}`);
  console.log("试试：'帮我 review 一下 lesson07-skill 目录的代码'（会自动加载 code-review 技能）");

  while (true) {
    const raw = await rl.question("\n你> ");
    const line = raw.trim();
    if (!line) continue;

    if (["/exit", "/quit", "/q"].includes(line)) break;
    if (line === "/skills") {
      const all = skills.list();
      for (const s of all) {
        console.log(`  - ${s.name}：${s.description}`);
        console.log(`    触发：${s.when_to_use}`);
      }
      continue;
    }
    if (line === "/memories") {
      const all = await listMemories();
      console.log(all.length === 0 ? "  （记忆库为空）" : all.map((m) => `  [${m.type}] ${m.name}`).join("\n"));
      continue;
    }
    if (line.startsWith("/forget ")) {
      const name = line.slice("/forget ".length).trim();
      console.log((await memory.forget(name)) ? `已删除: ${name}` : `未找到: ${name}`);
      continue;
    }
    if (line === "/budget") {
      console.log(JSON.stringify(agent.cm.budget(), null, 2));
      continue;
    }
    if (line === "/reset") {
      agent.reset();
      console.log("上下文已清空（记忆保留）。");
      continue;
    }

    try {
      const answer = await agent.run(line);
      console.log(`\nagent> ${answer}`);
    } catch (e) {
      console.error(`\n[错误] ${e.message}（检查 env.json 配置）`);
    }
  }

  console.log("再见！");
  rl.close();
}

repl().catch((e) => {
  console.error(e);
  process.exit(1);
});
