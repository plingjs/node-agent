/**
 * lesson12 · 入口 —— 定时任务 + QQ + 终端 三通道
 *
 * 新增能力（相对 lesson11）：CronScheduler 定时任务
 *   定时触发 → bridge.handleSystemMessage（系统消息，不误入审批消费）
 *   → Agent 在目标会话上下文执行 → 结果推送到目标通道
 *
 * 定时任务示例：
 *   "每 10 秒" 播报（演示触发链路，秒级可见）
 *   "0 9 * * *" 日报（演示 cron 表达式，真实触发等不到——可改成当前时间附近验证）
 *
 * 元命令：/cron 查看定时任务列表 /sessions /exit
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { call_llm, getConfig } from "./llm.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { buildCoreTools } from "./core_tools.js";
import { SkillRegistry } from "./skill_registry.js";
import { HookRegistry } from "./hooks/hook_registry.js";
import { SessionManager } from "./session_manager.js";
import { AgentBridge } from "./agent_bridge.js";
import { QQGateway, getAppAccessToken } from "./gateway/qq_gateway.js";
import { TerminalGateway, TERMINAL_CHANNEL } from "./gateway/terminal_gateway.js";
import { ApprovalFlow } from "./approval_flow.js";
import { CronScheduler } from "./cron/cron_scheduler.js";
import { createCronJobTool, createListCronJobsTool } from "./cron/cron_tool.js";

function loadQQConfig() {
  const envPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "env.json",
  );
  try {
    const cfg = JSON.parse(readFileSync(envPath, "utf8"));
    return {
      appid: cfg.QQ_APPID || "",
      token: cfg.QQ_TOKEN || "",
      secret: cfg.QQ_SECRET || "",
    };
  } catch {
    return { appid: "", token: "", secret: "" };
  }
}

const SYSTEM_PROMPT =
  "你是通过 IM 提供服务的 AI 助手，拥有记忆、工具、委派、技能、定时任务等完整能力。" +
  "回答简洁准确，能用工具就用工具，优先参考记忆中的用户偏好。";

// ── 全局兜底：任何未捕获错误都只记录、不退出（服务进程保活）──
process.on("unhandledRejection", (err) => {
  console.error("[fatal] 未捕获的异步错误（进程继续运行）:", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] 未捕获异常（进程继续运行）:", err?.message || err);
});

async function main() {
  // ── Agent 组装（1-11 课全部能力）──
  const confirmHolder = { fn: async () => true };
  const registry = buildCoreTools((name, args) => confirmHolder.fn(name, args));
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
    verbose: false,
  });
  await skills.load();

  // ── 通道：QQ（有凭证启用）+ 终端（始终）──
  const qq = loadQQConfig();
  let qqGateway = null;
  if (qq.appid && (qq.token || qq.secret)) {
    let token = qq.token;
    if (!token && qq.secret) {
      console.log("[gateway] 使用 appid+secret 换取 access_token...");
      token = await getAppAccessToken(qq.appid, qq.secret);
    }
    qqGateway = new QQGateway({ appid: qq.appid, token }, { log: console.log });
    await qqGateway.connect();
    console.log(`[gateway] QQ 机器人已上线（appid: ${qq.appid}）`);
  }
  const terminal = new TerminalGateway();

  // ── 审批流（按 channel 路由）──
  const approval = new ApprovalFlow({
    gateways: new Map([[TERMINAL_CHANNEL, terminal]]),
    defaultGateway: qqGateway,
  });
  confirmHolder.fn = (name, args) =>
    approval.createConfirm(bridge.currentChannel, bridge.currentMsgId)(name, args);

  // ── 桥接 ──
  const bridge = new AgentBridge({ agent, sessions: new SessionManager(), approval });
  for (const g of [qqGateway, terminal].filter(Boolean)) bridge.attach(g);

  // ── 定时任务（lesson12 核心：用户通过语言设置，不预注册）──
  const cron = new CronScheduler();

  // 把"设置定时任务"做成 Agent 可调用的工具：
  // 用户说"每天早上9点生成日报" → 模型调用 create_cron_job → 注册生效
  registry.register(
    createCronJobTool({
      scheduler: cron,
      bridge,
      gatewayFor: (ch) => approval._gatewayFor(ch),
    }),
    "write", // 修改系统状态 → 走审批流确认
  );
  registry.register(createListCronJobsTool({ scheduler: cron }), "read");

  console.log("[cron] 定时任务由对话设置——试试说：'每天早上9点帮我生成日报'（或 '每5分钟提醒我喝水'）");
  console.log("[cron] 查看已设任务：'现在有哪些定时任务？'");

  // ── 终端会话管理命令（继承 lesson10 能力）──
  terminal.onCommand("/sessions", async () => {
    const all = await bridge.listSessions();
    if (all.length === 0) return console.log("（暂无会话）");
    console.log("会话列表（id 前缀 / 标题 / 消息数 / 更新时间）:");
    for (const s of all) {
      console.log(
        `  ${s.session_id.slice(0, 8)}  ${s.title}  (${s.message_count ?? 0} 条, ${new Date(s.updated_at || Date.now()).toLocaleTimeString()})`,
      );
    }
  });
  terminal.onCommand("/new", async () => {
    const meta = await bridge.sessions.create({ title: "新会话" });
    bridge.channelToSession.set(TERMINAL_CHANNEL, meta.session_id);
    bridge.agent.reset();
    console.log(`已新建并切换到会话 ${meta.session_id.slice(0, 8)}`);
  });
  terminal.onCommand("/use", async (arg) => {
    const id = arg.trim();
    const all = await bridge.listSessions();
    const target = all.find((s) => s.session_id.startsWith(id));
    if (!target) return console.log(`找不到会话 ${id}（/sessions 查看）`);
    await bridge.switchSession(TERMINAL_CHANNEL, target.session_id);
    console.log(`已切换到会话 ${target.session_id.slice(0, 8)}（${target.title}）`);
  });
  terminal.onCommand("/delete", async (arg) => {
    const id = arg.trim();
    const all = await bridge.listSessions();
    const target = all.find((s) => s.session_id.startsWith(id));
    if (!target) return console.log(`找不到会话 ${id}（/sessions 查看）`);
    await bridge.deleteSession(TERMINAL_CHANNEL, target.session_id);
    console.log(`已删除会话 ${target.session_id.slice(0, 8)}`);
  });
  terminal.onCommand("/help", async () => {
    console.log("命令: /sessions（列会话） /new（新建） /use <id>（切换） /delete <id>（删除） /exit");
  });

  console.log("[session] 终端会话命令：/sessions /new /use <id> /delete <id>");
  console.log(`[bridge] 通道已接入（LLM: ${getConfig().model}）`);
  await terminal.connect();
  console.log("终端直接输入对话；QQ 消息同样处理；定时任务由你通过对话设置，互不影响。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
