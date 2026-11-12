/**
 * lesson05 · 入口 —— 交互式记忆 + 核心工具 Agent（REPL）
 *
 * 继承 lesson04：核心工具（搜索/读文件/执行命令/写文件/联网）
 * 叠加 lesson05：跨会话记忆（自动提取 + 按需召回注入）
 *
 * 演示：
 *   会话1： 你> 记住，我写代码用4空格缩进
 *           agent> 已记住
 *           你> 搜索 demo 目录下含 TODO 的文件      ← 工具能力仍在
 *           你> /exit
 *   会话2（重开终端）：
 *           你> 我写代码用什么缩进？                 ← 记忆生效
 *
 * 元命令：/memories /forget <名称> /reset /budget /exit
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { call_llm } from "./llm.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { listMemories } from "./memory_entries.js";
import { buildCoreTools } from "./core_tools.js";

const rl = createInterface({ input: stdin, output: stdout });

/** 三态确认（danger 级工具 run_shell 会触发） */
async function cliConfirm(name, args) {
  console.log(`\n  ⚠️  需要确认: ${name}(${JSON.stringify(args)})`);
  const choice = (await rl.question("  批准? (y=一次 / a=始终允许 / n=拒绝): ")).trim().toLowerCase();
  if (choice === "a") return "always";
  return choice === "y";
}

const SYSTEM_PROMPT =
  "你是带长期记忆的代码助手，能用工具读文件、搜索、执行命令。" +
  "回答简洁准确。当用户提到个人偏好或项目约定时，主动记住；" +
  "回答问题时如相关记忆存在，优先使用。" +
  "用户提问与本机文件/代码相关时，先用工具探索再回答。";

async function printMemories() {
  const all = await listMemories();
  if (all.length === 0) {
    console.log("  （记忆库为空）");
    return;
  }
  for (const m of all) {
    console.log(`  [${m.type}] ${m.name} — ${m.description}`);
  }
}

async function repl() {
  const registry = buildCoreTools(cliConfirm);
  const memory = new MemoryManager();
  const agent = new Agent({ llm: call_llm, memory, registry, systemPrompt: SYSTEM_PROMPT, verbose: true });

  const existing = await listMemories();
  console.log("=== 记忆 + 核心工具 Agent（lesson05）===");
  console.log(`当前记忆库：${existing.length} 条（/memories 查看）`);
  console.log("试试：'记住我用4空格缩进' → 重开程序问'我用什么缩进'；或 '搜索 demo 目录'");

  while (true) {
    const raw = await rl.question("\n你> ");
    const line = raw.trim();
    if (!line) continue;

    if (["/exit", "/quit", "/q"].includes(line)) break;
    if (line === "/memories") {
      await printMemories();
      continue;
    }
    if (line.startsWith("/forget ")) {
      const name = line.slice("/forget ".length).trim();
      const ok = await memory.forget(name);
      console.log(ok ? `已删除记忆: ${name}` : `未找到记忆: ${name}`);
      continue;
    }
    if (line === "/budget") {
      console.log(JSON.stringify(agent.cm.budget(), null, 2));
      continue;
    }
    if (line === "/reset") {
      agent.reset();
      console.log("本轮对话上下文已清空（记忆保留）。");
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
