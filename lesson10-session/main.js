/**
 * lesson10 · 入口 —— 多会话 REPL
 *
 * 核心能力：多会话 + 保存恢复
 *   /sessions        列出所有会话（标题/时间/消息数）
 *   /new             新建会话（多会话并行）
 *   /use <id>        切换会话（自动保存旧的 + 恢复目标）
 *   /delete <id>     删除
 *   /rename <id> <新标题>
 *
 * 会话保存：每轮对话结束自动保存到 sessions/<id>.json（原子写），
 * 退出时保存。重开终端后会话仍在，可继续对话（跨进程恢复）。
 *
 * 继承能力：记忆/技能/委派/MCP/工具（第 5-9 课）
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { call_llm, getConfig } from "./llm.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { listMemories } from "./memory_entries.js";
import { buildCoreTools } from "./core_tools.js";
import { SkillRegistry } from "./skill_registry.js";
import { HookRegistry } from "./hooks/hook_registry.js";
import { SessionManager, autoTitle } from "./session_manager.js";
import { serializeContext, restoreContext } from "./session_state.js";

const rl = createInterface({ input: stdin, output: stdout });

async function cliConfirm(name, args) {
  console.log(`\n  ⚠️  需要确认: ${name}(${JSON.stringify(args)})`);
  const choice = (await rl.question("  批准? (y=一次 / a=始终允许 / n=拒绝): ")).trim().toLowerCase();
  if (choice === "a") return "always";
  return choice === "y";
}

const SYSTEM_PROMPT =
  "你是带记忆、委派、技能、外部系统接入的 Agent。回答简洁准确，优先使用工具探索再回答。";

async function repl() {
  // ── Agent 组装（第 1-9 课全部能力）──
  const registry = buildCoreTools(cliConfirm);
  const memory = new MemoryManager();
  const skills = new SkillRegistry();
  const hooks = new HookRegistry();

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

  // ── 会话管理 ──
  const sessions = new SessionManager();
  let activeId = null;

  /** 保存当前会话（自动保存：每轮结束后调用） */
  async function saveActiveSession() {
    if (!activeId) return;
    // 只持久化基础 system（注入内容每轮重建，不落盘）
    agent.cm.setSystem([{ role: "system", content: agent.systemPrompt }]);
    const current = await sessions.load(activeId).catch(() => ({ title: "新会话" }));
    const state = {
      ...current,
      ...serializeContext(agent.cm), // 只持久化基础 system + summary + recent
      message_count: agent.cm.recent.filter((m) => m.role === "user").length,
      updated_at: Date.now(),
    };
    await sessions.save(activeId, state).catch(() => {
      console.log("[warn] 会话保存失败（不影响对话）");
    });
  }

  /** 切换会话：保存旧的 + 恢复目标 */
  async function switchSession(id) {
    await saveActiveSession();
    const state = await sessions.load(id);
    activeId = id;
    restoreContext(agent.cm, state); // 恢复三层上下文
    agent.cm.setSystem([{ role: "system", content: SYSTEM_PROMPT }]);
    console.log(`已切换到会话: ${state.title} (${state.session_id})`);
  }

  async function listSessions() {
    const all = await sessions.list();
    if (all.length === 0) {
      console.log("  （无会话）");
      return;
    }
    for (const s of all) {
      const active = s.session_id === activeId ? " *" : "";
      console.log(
        `  ${s.session_id}${active} ${s.title} | ${new Date(s.updated_at).toLocaleString()} | ${s.message_count || 0} 条`,
      );
    }
  }

  // 启动：复用最近的会话（跨进程恢复），没有则新建
  const existing = await sessions.list();
  if (existing.length > 0) {
    await switchSession(existing[0].session_id);
    console.log("=== 多会话 Agent（lesson10）===");
    console.log("上次的会话已恢复，继续对话；/sessions 查看全部");
  } else {
    const meta = await sessions.create({ title: "会话1", model: getConfig().model });
    activeId = meta.session_id;
    console.log("=== 多会话 Agent（lesson10）===");
    console.log(`已创建新会话: ${activeId}`);
  }
  console.log("命令：/sessions /new /use <id> /delete <id> /rename <id> <标题> /exit");

  while (true) {
    const raw = await rl.question("\n你> ");
    const line = raw.trim();
    if (!line) continue;

    // ── 会话命令 ──
    if (["/exit", "/quit", "/q"].includes(line)) {
      await saveActiveSession();
      console.log("会话已保存，再见！");
      break;
    }
    if (line === "/sessions") {
      await listSessions();
      continue;
    }
    if (line === "/new") {
      await saveActiveSession();
      const meta = await sessions.create({
        title: `会话${(await sessions.list()).length + 1}`,
        model: getConfig().model,
      });
      activeId = meta.session_id;
      agent.reset();
      console.log(`已创建新会话: ${activeId}`);
      continue;
    }
    if (line.startsWith("/use ")) {
      const id = line.split(" ")[1].trim();
      try {
        await switchSession(id);
      } catch {
        console.log(`会话不存在: ${id}`);
      }
      continue;
    }
    if (line.startsWith("/delete ")) {
      const id = line.split(" ")[1].trim();
      console.log((await sessions.delete(id)) ? `已删除会话: ${id}` : `未找到: ${id}`);
      if (activeId === id) {
        agent.reset();
        activeId = null;
      }
      continue;
    }
    if (line.startsWith("/rename ")) {
      const [, id, ...rest] = line.split(" ");
      const title = rest.join(" ").trim();
      if (!title) {
        console.log("用法：/rename <id> <新标题>");
        continue;
      }
      try {
        await sessions.rename(id, title);
        console.log("已重命名");
      } catch {
        console.log(`会话不存在: ${id}`);
      }
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

    // ── 对话：首轮生成标题 + 每轮自动保存 ──
    if (!activeId) {
      const meta = await sessions.create({ title: autoTitle(line), model: getConfig().model });
      activeId = meta.session_id;
    }
    try {
      const answer = await agent.run(line, { memoryScope: activeId });
      console.log(`\nagent> ${answer}`);
      // 首轮自动生成标题（更可读）
      const current = await sessions.load(activeId);
      if (!current.title || current.title.startsWith("会话")) {
        await sessions.rename(activeId, autoTitle(line));
      }
      await saveActiveSession();
      console.log(`[已自动保存到会话 ${activeId}]`);
    } catch (e) {
      console.error(`\n[错误] ${e.message}`);
    }
  }

  rl.close();
}

repl().catch((e) => {
  console.error(e);
  process.exit(1);
});
