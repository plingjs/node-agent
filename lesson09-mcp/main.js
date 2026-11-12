/**
 * lesson09 · 入口 —— MCP + Hooks REPL
 *
 * 启动时连接模拟 MCP server（计算器外部系统），注册 mcp__ 工具；
 * 注册两个示例 Hooks：审计日志（pre）+ 拦截演示（pre）。
 *
 * 元命令：/mcp 查看 MCP 工具 /skills /memories /budget /reset /exit
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { call_llm } from "./llm.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { listMemories } from "./memory_entries.js";
import { buildCoreTools } from "./core_tools.js";
import { SkillRegistry } from "./skill_registry.js";
import { HookRegistry, HookEvent } from "./hooks/hook_registry.js";
import { connectMcpServer } from "./mcp/mcp_tools.js";

const rl = createInterface({ input: stdin, output: stdout });

async function cliConfirm(name, args) {
  console.log(`\n  ⚠️  需要确认: ${name}(${JSON.stringify(args)})`);
  const choice = (await rl.question("  批准? (y=一次 / a=始终允许 / n=拒绝): ")).trim().toLowerCase();
  if (choice === "a") return "always";
  return choice === "y";
}

const SYSTEM_PROMPT =
  "你是带记忆、委派、技能和外部系统接入的代码助手。" +
  "mcp__ 前缀的工具来自外部系统，与其他工具同样使用。" +
  "回答简洁准确，优先使用工具探索再回答。";

async function repl() {
  const registry = buildCoreTools(cliConfirm);
  const memory = new MemoryManager();
  const skills = new SkillRegistry();
  const hooks = new HookRegistry();

  // ── 示例 Hook 1：审计日志（记录所有工具调用）──
  hooks.add(HookEvent.PRE_TOOL_USE, async ({ name, args }) => {
    console.log(`  [audit] 调用 ${name}(${JSON.stringify(args)})`);
  });

  // ── 示例 Hook 2：拦截危险命令（演示 PreToolUse 拦截能力）──
  hooks.add(HookEvent.PRE_TOOL_USE, async ({ name, args }) => {
    if (name === "run_shell" && String(args.command || "").includes("rm -rf")) {
      return { blocked: true, reason: "审计钩子拦截了 rm -rf 命令" };
    }
  });

  // ── 连接 MCP 外部服务器（模拟计算器系统）──
  const { client: mcpClient, toolNames } = await connectMcpServer(registry, {
    serverName: "calc",
  });
  console.log(`[mcp] 已连接外部服务器，发现工具: ${toolNames.join(", ")}`);

  const agent = new Agent({
    llm: call_llm,
    memory,
    registry,
    systemPrompt: SYSTEM_PROMPT,
    maxDepth: 2,
    skills,
    hooks,
    verbose: true,
  });
  await skills.load();

  console.log("=== MCP + Hooks（lesson09）===");
  console.log("试试：'用计算器算 123+456'（会走 MCP 外部系统）或 '运行 rm -rf /'（被钩子拦截）");

  while (true) {
    const raw = await rl.question("\n你> ");
    const line = raw.trim();
    if (!line) continue;

    if (["/exit", "/quit", "/q"].includes(line)) break;
    if (line === "/mcp") {
      const mcpTools = registry.getSchemas().filter((s) => s.function.name.startsWith("mcp__"));
      console.log(mcpTools.map((s) => `  - ${s.function.name}：${s.function.description}`).join("\n"));
      continue;
    }
    if (line === "/skills") {
      const all = await skills.list();
      console.log(all.map((s) => `  - ${s.name}：${s.description}`).join("\n") || "  （空）");
      continue;
    }
    if (line === "/memories") {
      const all = await listMemories();
      console.log(all.length === 0 ? "  （空）" : all.map((m) => `  [${m.type}] ${m.name}`).join("\n"));
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
      console.error(`\n[错误] ${e.message}`);
    }
  }

  mcpClient.close();
  console.log("再见！");
  rl.close();
}

repl().catch((e) => {
  console.error(e);
  process.exit(1);
});
