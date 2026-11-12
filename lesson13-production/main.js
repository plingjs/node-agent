/**
 * lesson13 · 入口 —— 生产级 Agent（重试/熔断 + 流式 + 观测 + 评测）
 *
 * 相比 lesson12 新增（生产化四件套）：
 *   ① LLM 可靠性：withRetry（错误分类/指数退避）+ CircuitBreaker（三态熔断）
 *   ② 流式输出：SSE 逐 token，终端打字机效果（QQ 不流式）
 *   ③ 观测：Telemetry 记录每次 LLM/工具调用（token/成本/耗时/错误率），/stats 查看
 *   ④ 评测：/eval 跑内置评测集（对话/工具/拒绝危险），输出通过率
 *
 * 调用链（装饰器层层包装，agent 零改动）：
 *   traced( withRetry( streamingBase ) )
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConfig } from "./llm.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { buildCoreTools } from "./core_tools.js";
import { SkillRegistry } from "./skill_registry.js";
import { HookRegistry, HookEvent } from "./hooks/hook_registry.js";
import { SessionManager } from "./session_manager.js";
import { AgentBridge } from "./agent_bridge.js";
import { QQGateway, getAppAccessToken } from "./gateway/qq_gateway.js";
import { TerminalGateway, TERMINAL_CHANNEL } from "./gateway/terminal_gateway.js";
import { ApprovalFlow } from "./approval_flow.js";
import { CronScheduler } from "./cron/cron_scheduler.js";
import { createCronJobTool, createListCronJobsTool } from "./cron/cron_tool.js";
import { createStreamingLlm } from "./streaming.js";
import { Telemetry } from "./telemetry.js";
import { runEvaluation, EVAL_CASES } from "./evaluate.js";
import { createLlmChain } from "./llm_chain.js";

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
  // ── 观测（先建，LLM 链要用）──
  const telemetry = new Telemetry();
  const cfg = getConfig();
  let bridge = null; // 打字机需要判断当前通道（闭包引用，运行时已赋值）

  // ── 打字机：逐字输出队列 ──
  // 服务端 SSE chunk 可能一次推一大段——直接写会"一段段卡顿"；
  // 拆成单字 + 定时器均匀输出（~60 字/秒），节奏稳定
  // 注意：必须按 code point 切字（Array.from），emoji 是代理对，
  // 用 slice(1) 会把 emoji 切成两半 → 乱码 ��
  let typeQueue = "";
  let typing = false;
  function typeText(text) {
    typeQueue += text;
    if (typing) return;
    typing = true;
    const tick = setInterval(() => {
      if (typeQueue.length === 0) {
        clearInterval(tick);
        typing = false;
        terminal.markTypingDone(); // 打字机输出完 → 通知 _loop 显示"你>"
        return;
      }
      const chars = Array.from(typeQueue); // 按 code point 切（emoji 安全）
      process.stdout.write(chars[0]);
      typeQueue = chars.slice(1).join("");
    }, 16);
  }

  // ── 生产级 LLM 调用链 ──
  // ① 流式 base：终端通道逐字打字机；QQ 不流式（无 delta 打印）
  const streamingBase = createStreamingLlm(cfg, (delta) => {
    if (bridge && bridge.currentChannel === TERMINAL_CHANNEL) {
      typeText(delta);
      terminal.markStreaming(); // 本次回复已流式输出 → send 不再重复打印
    }
  });
  // ② traced + retry + breaker 包装（agent 零改动）
  const { llm, breaker } = createLlmChain({ base: streamingBase, model: cfg.model, telemetry });

  // ── Agent 组装（1-12 课全部能力）──
  const confirmHolder = { fn: async () => true };
  const registry = buildCoreTools((name, args) => confirmHolder.fn(name, args));
  const memory = new MemoryManager();
  const skills = new SkillRegistry();
  const hooks = new HookRegistry();
  const agent = new Agent({
    llm,
    memory,
    registry,
    systemPrompt: SYSTEM_PROMPT,
    maxDepth: 2,
    skills,
    hooks,
    verbose: false,
  });
  await skills.load();

  // ── 工具观测：hooks 记录每次工具调用（耗时/状态）──
  const toolTimes = new Map();
  hooks.add(HookEvent.PRE_TOOL_USE, ({ name }) => {
    toolTimes.set(name, Date.now());
  });
  hooks.add(HookEvent.POST_TOOL_USE, ({ name, result }) => {
    const t0 = toolTimes.get(name) || Date.now();
    telemetry.toolCall({
      name,
      status: result?.error ? "error" : "ok",
      durationMs: Date.now() - t0,
    });
  });

  // ── 通道：QQ（有凭证启用）+ 终端（始终）──
  const qq = loadQQConfig();
  let qqGateway = null;
  if (qq.appid && (qq.token || qq.secret)) {
    // QQ 是可选通道：凭证失效/网关不可达不能拖死终端入口
    // （换 access_token 失败会抛错，不兜住的话 main() 直接 exit 1）
    try {
      let token = qq.token;
      if (!token && qq.secret) {
        console.log("[gateway] 使用 appid+secret 换取 access_token...");
        token = await getAppAccessToken(qq.appid, qq.secret);
      }
      qqGateway = new QQGateway({ appid: qq.appid, token }, { log: console.log });
      await qqGateway.connect();
      console.log(`[gateway] QQ 机器人已上线（appid: ${qq.appid}）`);
    } catch (e) {
      console.error(`[gateway] QQ 接入失败，仅启用终端通道：${e.message}`);
      qqGateway = null;
    }
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
  bridge = new AgentBridge({ agent, sessions: new SessionManager(), approval });
  for (const g of [qqGateway, terminal].filter(Boolean)) bridge.attach(g);

  // ── 定时任务（对话设置）──
  const cron = new CronScheduler();
  registry.register(
    createCronJobTool({
      scheduler: cron,
      bridge,
      gatewayFor: (ch) => approval._gatewayFor(ch),
    }),
    "write",
  );
  registry.register(createListCronJobsTool({ scheduler: cron }), "read");

  // ── 生产命令：/stats 观测汇总、/eval 评测 ──
  terminal.onCommand("/stats", () => {
    const s = telemetry.summary();
    console.log("── 观测汇总（当前进程）──");
    console.log(`  LLM 调用 ${s.llmCalls} 次 | 工具调用 ${s.toolCalls} 次`);
    console.log(`  tokens: ${s.promptTokens} in / ${s.completionTokens} out（共 ${s.totalTokens}）`);
    console.log(`  估算成本 ¥${s.estimatedCostYuan} | 平均耗时 ${s.avgLlmDurationMs}ms`);
    console.log(`  错误率 ${s.llmErrorRate} | 熔断: ${breaker.status.state}（连续失败 ${breaker.status.failures}）`);
  });
  terminal.onCommand("/eval", async () => {
    console.log(`── 评测（${EVAL_CASES.length} 个用例，真实调用 LLM）──`);
    const result = await runEvaluation({ agent, verbose: true });
    console.log(`通过 ${result.passed}/${result.total}，通过率 ${result.passRate * 100}%`);
  });

  // ── 终端会话管理命令（继承 lesson10）──
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
    console.log(
      "命令: /stats（观测） /eval（评测） /sessions /new /use <id> /delete <id> /exit",
    );
  });

  console.log("[prod] LLM 调用链：流式 + 重试(3) + 熔断 + 观测");
  console.log("[prod] /stats 查看观测 | /eval 跑评测 | 终端回复打字机效果");
  console.log(`[bridge] 通道已接入（LLM: ${cfg.model}）`);
  await terminal.connect();
  console.log("终端直接输入对话（回复逐字输出）；QQ 消息同样处理；定时任务由对话设置。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
