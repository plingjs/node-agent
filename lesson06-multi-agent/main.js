/**
 * lesson06 · 入口 —— 多 Agent 协作 REPL
 *
 * 主 Agent = lesson05（记忆+工具）+ delegate_task 委派能力。
 * /demo 命令触发预置的并行委派演示：两个子 Agent 分别搜索 TODO / FIXME，
 * 父 Agent 汇聚结果（演示 委派 → 隔离 → 汇聚 三步）。
 *
 * 元命令：/memories /forget <名称> /demo /budget /reset /exit
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { call_llm } from "./llm.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { listMemories } from "./memory_entries.js";
import { buildCoreTools } from "./core_tools.js";
import { delegateParallel, mergeResults } from "./parallel.js";

const rl = createInterface({ input: stdin, output: stdout });

async function cliConfirm(name, args) {
  console.log(`\n  ⚠️  需要确认: ${name}(${JSON.stringify(args)})`);
  const choice = (await rl.question("  批准? (y=一次 / a=始终允许 / n=拒绝): ")).trim().toLowerCase();
  if (choice === "a") return "always";
  return choice === "y";
}

const SYSTEM_PROMPT =
  "你是带长期记忆和委派能力的代码助手。" +
  "能用工具直接干活；任务可拆成独立子任务时，用 delegate_task 委派给子 Agent。" +
  "回答简洁准确，用户偏好相关时优先参考记忆。" +
  "用户提问与本机文件/代码相关时，先用工具探索再回答。";

/** /demo：并行委派演示 —— 两个子 Agent 分别搜索 TODO / FIXME */
async function demoParallelDelegation() {
  console.log("\n[demo] 并行委派两个子 Agent：分别搜索 TODO 和 FIXME...");
  const registry = buildCoreTools(cliConfirm);

  const tasks = [
    {
      task:
        "在 demo 目录下搜索所有含 TODO: 标记的文件，列出文件路径和每处 TODO 内容。",
      tools: ["search_files", "read_file"],
    },
    {
      task:
        "在 demo 目录下搜索所有含 FIXME: 标记的文件，列出文件路径和每处 FIXME 内容。",
      tools: ["search_files", "read_file"],
    },
  ];

  const results = await delegateParallel({
    llm: call_llm,
    registry,
    tasks,
    maxConcurrent: 2,
    depth: 0,
    maxDepth: 2,
    verbose: true,
  });

  console.log(`\n[demo] 汇聚结果：\n${mergeResults(tasks, results)}`);
}

async function repl() {
  const registry = buildCoreTools(cliConfirm);
  const memory = new MemoryManager();
  const agent = new Agent({
    llm: call_llm,
    memory,
    registry,
    systemPrompt: SYSTEM_PROMPT,
    maxDepth: 2,
    verbose: true,
  });

  const existing = await listMemories();
  console.log("=== 多 Agent 协作（lesson06）===");
  console.log(`记忆库：${existing.length} 条 | 委派深度上限：2`);
  console.log("输入 /demo 看并行委派演示；或直接提问（复杂任务会自动委派）");

  while (true) {
    const raw = await rl.question("\n你> ");
    const line = raw.trim();
    if (!line) continue;

    if (["/exit", "/quit", "/q"].includes(line)) break;
    if (line === "/demo") {
      await demoParallelDelegation();
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
