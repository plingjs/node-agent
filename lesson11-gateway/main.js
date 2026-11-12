/**
 * lesson11 · 入口 —— 多渠道 Agent（QQ + 终端同时可用，互不影响）
 *
 * 通道：
 *   QQ 网关（配了 QQ_SECRET 时启用）：每 QQ 用户一个独立会话
 *   终端通道（始终启用）：固定会话 "terminal"
 *
 * 双通道原理：两个 Gateway 都 attach 到同一个 AgentBridge，
 * 串行队列保证同一时刻只处理一条消息；审批流按 channelId 路由
 * 确认请求（QQ 用户 → QQ 消息，终端 → 终端打印）。
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

/** 读 QQ 配置（env.json，与 LLM 配置同文件）：
 *  新版 union 机器人：QQ_APPID + QQ_SECRET（appsecret，需要换取 access_token）
 *  老版机器人：QQ_APPID + QQ_TOKEN（直接 token） */
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
  "你是通过 IM 提供服务的 AI 助手，拥有记忆、工具、委派、技能等完整能力。" +
  "回答简洁准确，能用工具就用工具，优先参考记忆中的用户偏好。";

// ── 全局兜底：任何未捕获错误都只记录、不退出（服务进程保活）──
process.on("unhandledRejection", (err) => {
  console.error("[fatal] 未捕获的异步错误（进程继续运行）:", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] 未捕获异常（进程继续运行）:", err?.message || err);
});

async function main() {
  // ── Agent 组装（1-10 课全部能力）──
  // confirm 用 holder 包装：运行时可在 自动批准/IM审批流 间切换
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

  // ── 通道 1：QQ（有凭证才启用）──
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
  } else {
    console.log("[gateway] 未配置 QQ_SECRET，仅启用终端通道（配好可接入 QQ）");
  }

  // ── 通道 2：终端（始终启用）──
  const terminal = new TerminalGateway();

  // ── 审批流：按 channel 路由确认请求（QQ 用户→QQ 消息，终端→终端打印）──
  const approval = new ApprovalFlow({
    gateways: new Map([[TERMINAL_CHANNEL, terminal]]),
    defaultGateway: qqGateway, // QQ 用户走默认通道
  });
  confirmHolder.fn = (name, args) =>
    approval.createConfirm(bridge.currentChannel, bridge.currentMsgId)(name, args);
  console.log("[approval] 权限确认在对应通道交互（QQ 消息 / 终端输入；超时 60s 自动拒绝）");

  // ── 桥接：所有通道 → 同一 Agent（串行队列互不影响）──
  const bridge = new AgentBridge({
    agent,
    sessions: new SessionManager(),
    approval,
  });
  const channels = [qqGateway, terminal].filter(Boolean);
  for (const g of channels) {
    bridge.attach(g);
  }
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

  // 终端通道启动（readline 异步循环，不阻塞 QQ 事件）
  await terminal.connect();
  console.log("在终端直接输入即可对话；QQ 用户消息同样处理，互不影响。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
