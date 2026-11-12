/**
 * lesson08 · 入口 —— Plugin 系统 REPL
 *
 * 演示一个真实价值的插件：audit-log（安全审计）
 *   - 工具调用全部留痕（写 audit.log + 内存可查）
 *   - 危险命令（rm -rf / shutdown）被拦截
 *   - 参数中的敏感信息（token/password）脱敏
 *   - /audit 查看记录与统计
 *
 * 元命令：/audit [工具名] /audit-summary /plugins /skills /memories /reset /exit
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { call_llm } from "./llm.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { listMemories } from "./memory_entries.js";
import { buildCoreTools } from "./core_tools.js";
import { SkillRegistry } from "./skill_registry.js";
import { HookRegistry } from "./hooks/hook_registry.js";
import { loadAuditLogPlugin } from "./plugins/audit-log/plugin.js";

const rl = createInterface({ input: stdin, output: stdout });

async function cliConfirm(name, args) {
  console.log(`\n  ⚠️  需要确认: ${name}(${JSON.stringify(args)})`);
  const choice = (await rl.question("  批准? (y=一次 / a=始终允许 / n=拒绝): ")).trim().toLowerCase();
  if (choice === "a") return "always";
  return choice === "y";
}

const SYSTEM_PROMPT =
  "你是带记忆、委派、技能的代码助手。所有工具调用会被审计记录。" +
  "回答简洁准确，优先使用工具探索再回答。";

async function repl() {
  const registry = buildCoreTools(cliConfirm);
  const memory = new MemoryManager();
  const skills = new SkillRegistry();
  const hooks = new HookRegistry();

  // ── 安装 audit-log 插件（一个 install 调用，注册两个钩子）──
  const audit = loadAuditLogPlugin();
  const uninstallAudit = audit.install(hooks);
  console.log("[plugin] audit-log 已安装（审计 + 危险拦截 + 脱敏）");

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

  console.log("=== Plugin 系统（lesson08）===");
  console.log("试试：'搜索 demo 目录'（留痕）/ '运行 rm -rf /'（被审计拦截）/ /audit 看记录");

  while (true) {
    const raw = await rl.question("\n你> ");
    const line = raw.trim();
    if (!line) continue;

    if (["/exit", "/quit", "/q"].includes(line)) break;
    if (line === "/plugins") {
      console.log("  - audit-log v1.0.0：安全审计（留痕/拦截/脱敏/统计）");
      continue;
    }
    if (line === "/audit" || line.startsWith("/audit ")) {
      const tool = line.split(" ")[1]; // /audit search_files
      const records = audit.query({ limit: 15, tool });
      if (records.length === 0) {
        console.log("  （暂无审计记录）");
      } else {
        for (const r of records) {
          console.log(`  [${r.event}] ${r.name} ${r.reason ? `→ ${r.reason}` : ""} ${r.status ? `→ ${r.status}` : ""}`);
          if (r.args && r.event === "call") console.log(`      args: ${JSON.stringify(r.args).slice(0, 80)}`);
        }
      }
      continue;
    }
    if (line === "/audit-summary") {
      const s = audit.summary();
      console.log(Object.keys(s).length === 0 ? "  （暂无数据）" : Object.entries(s).map(([k, v]) => `  ${k}: 调用${v.calls} 错误${v.errors} 拦截${v.blocked}`).join("\n"));
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

  uninstallAudit(); // 插件卸载（可插拔验证）
  console.log("再见！");
  rl.close();
}

repl().catch((e) => {
  console.error(e);
  process.exit(1);
});
