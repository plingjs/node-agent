/**
 * lesson12 · 自测（node:test，零依赖）
 * 覆盖：cron 解析 / nextRun 精确计算 / 调度触发 / 定时任务集成
 * 跑法：node --test test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { MEMORY_ROOT } from "./memory_store.js";
import { parseCron, matches } from "./cron/cron_parser.js";
import { nextRun, CronScheduler } from "./cron/cron_scheduler.js";
import { AgentBridge } from "./agent_bridge.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { buildCoreTools } from "./core_tools.js";
import { SkillRegistry } from "./skill_registry.js";
import { HookRegistry } from "./hooks/hook_registry.js";
import { SessionManager } from "./session_manager.js";
import { MockGateway } from "./gateway/mock_gateway.js";
import { TerminalGateway } from "./gateway/terminal_gateway.js";
import { ApprovalFlow } from "./approval_flow.js";

before(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});
after(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});

function wait(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 构造测试用 Agent（mock LLM） */
function makeAgent(fakeLlm) {
  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);
  return new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "sys",
    skills: new SkillRegistry(),
    hooks: new HookRegistry(),
    verbose: false,
  });
}

// ─── v1: cron 表达式解析 ──────────────────────────────────────────

test("parseCron：基础字段展开", () => {
  const spec = parseCron("0 9 * * *");
  assert.deepEqual(spec.minute, [0]);
  assert.deepEqual(spec.hour, [9]);
  assert.equal(spec.day.length, 31); // * = 全部
  assert.equal(spec.month.length, 12);
  assert.equal(spec.weekday.length, 7);
});

test("parseCron：步进 / 列举 / 范围", () => {
  assert.deepEqual(parseCron("*/15 * * * *").minute, [0, 15, 30, 45]);
  assert.deepEqual(parseCron("0 9 1,15 * *").day, [1, 15]);
  assert.deepEqual(parseCron("0 9 * * 1-5").weekday, [1, 2, 3, 4, 5]);
});

test("parseCron：非法表达式抛错", () => {
  assert.throws(() => parseCron("0 9 * *"), /5 字段/); // 只有 4 字段
  assert.throws(() => parseCron(""), /5 字段/);
});

// ─── v2: nextRun 精确计算 ─────────────────────────────────────────

test("nextRun：当天未到 → 当天触发", () => {
  const spec = parseCron("30 14 * * *");
  const from = new Date(2026, 7, 25, 10, 0); // 2026-08-25 10:00
  const next = nextRun(spec, from);
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 7);
  assert.equal(next.getDate(), 25);
  assert.equal(next.getHours(), 14);
  assert.equal(next.getMinutes(), 30);
});

test("nextRun：当天已过 → 次日触发", () => {
  const spec = parseCron("0 9 * * *");
  const from = new Date(2026, 7, 25, 10, 0); // 10:00 > 9:00
  const next = nextRun(spec, from);
  assert.equal(next.getDate(), 26); // 次日
  assert.equal(next.getHours(), 9);
});

test("nextRun：跨月进位（每月1日）", () => {
  const spec = parseCron("0 9 1 * *");
  const from = new Date(2026, 7, 25, 10, 0); // 8/25
  const next = nextRun(spec, from);
  assert.equal(next.getMonth(), 8); // 9 月（0 基）
  assert.equal(next.getDate(), 1);
});

test("nextRun：步进分钟对齐", () => {
  const spec = parseCron("*/15 * * * *");
  const from = new Date(2026, 7, 25, 10, 7); // 10:07
  const next = nextRun(spec, from);
  assert.equal(next.getMinutes(), 15); // 下一个 15 的倍数
});

test("nextRun：结果必须匹配 spec（matches 校验）", () => {
  const spec = parseCron("30 9 * * 1-5"); // 工作日 9:30
  const from = new Date(2026, 7, 25, 0, 0); // 周二
  const next = nextRun(spec, from);
  assert.ok(matches(spec, next));
  // 且 next > from
  assert.ok(next.getTime() > from.getTime());
});

// ─── v3: 调度器触发 ───────────────────────────────────────────────

test("CronScheduler：scheduleInterval 自动触发", async () => {
  const cron = new CronScheduler({ log: () => {} });
  let fired = 0;
  cron.scheduleInterval(20, async () => {
    fired += 1;
  });
  await wait(60);
  assert.ok(fired >= 1); // 20ms 间隔，60ms 内至少触发 1 次
  cron.remove("interval-20");
});

test("CronScheduler：fire 手动触发 + list + remove", async () => {
  const cron = new CronScheduler({ log: () => {} });
  let fired = 0;
  const job = cron.scheduleInterval(60000, async () => {
    fired += 1;
  });
  await cron.fire(job);
  assert.equal(fired, 1);

  const list = cron.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].runs, 1);
  assert.ok(list[0].lastRunAt);

  cron.remove(job.name);
  assert.equal(cron.list().length, 0);
});

test("年度任务：setTimeout 24.8 天溢出 → 分段 sleep 不立即触发", async () => {
  // "0 0 1 1 *" = 每年 1 月 1 日 00:00。当前距下一个触发点 > 24.8 天，
  // 修复前 setTimeout 溢出会立即触发（runs=1）；修复后分段等待（runs=0）
  const cron = new CronScheduler({ log: () => {} });
  let fired = 0;
  cron.schedule(
    "0 0 1 1 *",
    async () => {
      fired += 1;
    },
    { name: "年度任务" },
  );
  await wait(50);
  assert.equal(fired, 0); // 未立即触发（溢出 bug 会让它立刻执行）
  cron.stopAll();
});

test("ApprovalFlow：数字选项 1/2/3 映射正确（与确认文案一致）", async () => {
  const mock = new MockGateway();
  const flow = new ApprovalFlow({ defaultGateway: mock, timeoutMs: 5000 });

  // 1 = 批准一次
  const c1 = flow.createConfirm("u1");
  const p1 = c1("run_shell", {});
  flow.handleReply("u1", "1");
  assert.equal(await p1, true);

  // 2 = 拒绝
  const c2 = flow.createConfirm("u2");
  const p2 = c2("run_shell", {});
  flow.handleReply("u2", "2");
  assert.equal(await p2, false);

  // 3 = 始终允许
  const c3 = flow.createConfirm("u3");
  const p3 = c3("run_shell", {});
  flow.handleReply("u3", "3");
  assert.equal(await p3, "always");
});

// ─── 语言设置定时任务（cron 工具）────────────────────────────────

import { createCronJobTool, createListCronJobsTool } from "./cron/cron_tool.js";

test("create_cron_job 工具：注册定时任务", async () => {
  const cron = new CronScheduler({ log: () => {} });
  const fakeLlm = async () => ({ role: "assistant", content: "ok", tool_calls: null });
  const agent = new Agent({
    llm: fakeLlm,
    memory: new MemoryManager(),
    registry: buildCoreTools(() => true),
    systemPrompt: "sys",
    skills: new SkillRegistry(),
    hooks: new HookRegistry(),
    verbose: false,
  });
  const bridge = new AgentBridge({
    agent,
    sessions: new SessionManager({ dir: "/tmp/lesson12-test-crontool" }),
  });
  await rm("/tmp/lesson12-test-crontool", { recursive: true, force: true });
  const mock = new MockGateway();

  const tool = createCronJobTool({ scheduler: cron, bridge, gatewayFor: () => mock });
  const result = await tool.fn({ cron: "0 9 * * *", task: "生成日报" });

  assert.equal(result.created, true);
  assert.ok(result.nextRun); // 返回了下一次触发时间
  assert.equal(cron.list().length, 1);
  assert.ok(cron.list()[0].desc.includes("0 9 * * *"));
  cron.stopAll(); // 清理 pending timer（否则 runner 等 14 小时后才退出）
});

test("create_cron_job：非法表达式返回错误（模型可见）", async () => {
  const cron = new CronScheduler({ log: () => {} });
  const bridge = new AgentBridge({ agent: makeAgent(async () => ({})), sessions: new SessionManager({ dir: "/tmp/lesson12-test-badcron" }) });
  await rm("/tmp/lesson12-test-badcron", { recursive: true, force: true });
  const tool = createCronJobTool({ scheduler: cron, bridge, gatewayFor: () => null });

  await assert.rejects(tool.fn({ cron: "not-a-cron", task: "x" }), /5 字段/);
  assert.equal(cron.list().length, 0); // 未注册
  cron.stopAll();
});

test("list_cron_jobs 工具：查看已注册任务", async () => {
  const cron = new CronScheduler({ log: () => {} });
  const bridge = new AgentBridge({ agent: makeAgent(async () => ({})), sessions: new SessionManager({ dir: "/tmp/lesson12-test-listcron" }) });
  await rm("/tmp/lesson12-test-listcron", { recursive: true, force: true });
  const mock = new MockGateway();

  const createTool = createCronJobTool({ scheduler: cron, bridge, gatewayFor: () => mock });
  await createTool.fn({ cron: "0 9 * * *", task: "日报" });

  const listTool = createListCronJobsTool({ scheduler: cron });
  const result = await listTool.fn({});
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].name, "日报");
  assert.equal(result.jobs[0].runs, 0);
  cron.stopAll();
});

// ─── 终端命令机制 + prompt 刷新 + 会话管理 ───────────────────────

test("TerminalGateway：命令分发（/ 开头不当作普通消息）", async () => {
  const term = new TerminalGateway();
  let cmdRan = "";
  term.onCommand("/sessions", async () => {
    cmdRan = "/sessions";
  });

  let emitted = null;
  term.onMessage((m) => (emitted = m));

  // 命令输入 → 命中 handler，不 emit
  assert.equal(await term._handleLine("/sessions"), true);
  assert.equal(cmdRan, "/sessions");
  assert.equal(emitted, null);

  // 普通消息 → emit，返回 false
  assert.equal(await term._handleLine("你好"), false);
  assert.equal(emitted.text, "你好");

  // 未知命令 → 不崩，返回 true
  assert.equal(await term._handleLine("/unknown"), true);

  // 空行 → 消费
  assert.equal(await term._handleLine("  "), true);
});

test("TerminalGateway：send 后刷新输入提示（readline prompt）", async () => {
  const term = new TerminalGateway();
  let prompted = 0;
  term.rl = {
    setPrompt: () => {},
    prompt: () => {
      prompted += 1;
    },
  }; // 模拟 connect 后

  await term.send("terminal", "回复");
  assert.equal(prompted, 1); // 回复后重新显示"你>"

  // 无 rl（未 connect）不崩
  const term2 = new TerminalGateway();
  await term2.send("terminal", "回复");
  assert.equal(term2.sent.length, 1);
});

test("Bridge 会话管理：list/switch/delete（继承 lesson10）", async () => {
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    return { role: "assistant", content: "ok", tool_calls: null };
  };
  const bridge = new AgentBridge({
    agent: makeAgent(fakeLlm),
    sessions: new SessionManager({ dir: "/tmp/lesson12-test-sessmgr" }),
  });
  await rm("/tmp/lesson12-test-sessmgr", { recursive: true, force: true });

  // 先通过消息创建两个会话（terminal + user_a）
  await bridge.handleMessage({ channelId: "terminal", text: "你好" });
  await bridge.handleMessage({ channelId: "user_a", text: "hi" });

  const all = await bridge.listSessions();
  assert.equal(all.length, 2);

  // switch：terminal 切到 user_a 的会话（不新建）
  const target = all.find((s) => s.title.includes("hi"));
  await bridge.switchSession("terminal", target.session_id);
  assert.equal((await bridge.listSessions()).length, 2);

  // delete：删除后映射清除
  await bridge.deleteSession("terminal", target.session_id);
  assert.equal((await bridge.listSessions()).length, 1);
});

// ─── LLM 失败不退出（生产保活）───────────────────────────────────

import { call_llm } from "./llm.js";

test("call_llm：超时抛可识别错误（不无限挂起）", async () => {
  const original = globalThis.fetch;
  // 模拟 LLM API 永不响应；abort 时拒绝（真实 fetch 行为）
  globalThis.fetch = (url, opts) =>
    new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("Aborted")));
    });
  try {
    await assert.rejects(call_llm([], null, { timeoutMs: 50 }), /超时/);
  } finally {
    globalThis.fetch = original;
  }
});

test("LLM 失败不退出：attach 捕获错误并通知用户", async () => {
  // fakeLlm 抛错（模拟 LLM 超时/API 失败）
  const fakeLlm = async () => {
    throw new Error("LLM 调用超时（60000ms）");
  };
  const mock = new MockGateway();
  const bridge = new AgentBridge({
    agent: makeAgent(fakeLlm),
    sessions: new SessionManager({ dir: "/tmp/lesson12-test-llmfail" }),
  });
  await rm("/tmp/lesson12-test-llmfail", { recursive: true, force: true });
  bridge.attach(mock);

  // 触发消息处理（错误被 attach 的 catch 捕获，进程不退出）
  mock.receive({ channelId: "user_x", text: "你好" });
  await wait(80);

  // 用户收到错误提示（不是静默崩溃）
  const last = mock.sent[mock.sent.length - 1];
  assert.ok(last, "应发送错误提示");
  assert.ok(last.text.includes("处理失败"));
  assert.ok(last.text.includes("请稍后重试"));
});

// ─── v4: 定时任务集成 ─────────────────────────────────────────────

test("集成：cron 触发 → 系统消息 → Agent 执行 → 推送", async () => {
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    return { role: "assistant", content: "定时任务已执行", tool_calls: null };
  };
  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);
  const agent = new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "sys",
    skills: new SkillRegistry(),
    hooks: new HookRegistry(),
    verbose: false,
  });
  const mock = new MockGateway();
  const bridge = new AgentBridge({
    agent,
    sessions: new SessionManager({ dir: "/tmp/lesson12-test-cron" }),
  });
  await rm("/tmp/lesson12-test-cron", { recursive: true, force: true });
  bridge.attach(mock);

  // 模拟 cron 任务：定时触发 → 系统消息 → 结果推送
  let fired = 0;
  const cron = new CronScheduler({ log: () => {} });
  cron.scheduleInterval(20, async () => {
    fired += 1;
    const reply = await bridge.handleSystemMessage({
      channelId: "terminal",
      text: "【定时任务】汇报状态",
    });
    if (reply) await mock.send("terminal", `[定时] ${reply}`);
  });

  await wait(60);
  cron.remove("interval-20");

  assert.ok(fired >= 1);
  // Agent 回复被推送到目标通道
  assert.ok(mock.sent.some((s) => s.text.includes("定时任务已执行")));
});

test("集成：系统消息不被误判为审批回复", async () => {
  // 场景：某 channel 有 pending 确认，系统消息（定时任务）应照常执行，
  // 不能被 handleReply 消费掉
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    return { role: "assistant", content: "系统任务完成", tool_calls: null };
  };
  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);
  const agent = new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "sys",
    skills: new SkillRegistry(),
    hooks: new HookRegistry(),
    verbose: false,
  });
  const mock = new MockGateway();
  const { ApprovalFlow } = await import("./approval_flow.js");
  const flow = new ApprovalFlow({ defaultGateway: mock, timeoutMs: 5000 });
  const bridge = new AgentBridge({
    agent,
    sessions: new SessionManager({ dir: "/tmp/lesson12-test-approval" }),
    approval: flow,
  });
  await rm("/tmp/lesson12-test-approval", { recursive: true, force: true });

  // 先挂一个 pending 确认（模拟用户操作触发确认，还没回复）
  const p = flow.createConfirm("terminal");
  const pending = p("run_shell", {});
  await wait(10);
  assert.equal(flow.waitingCount, 1);

  // 系统消息来了 → 走 handleSystemMessage，不消费 pending
  const reply = await bridge.handleSystemMessage({
    channelId: "terminal",
    text: "【定时任务】巡检",
  });
  assert.equal(reply, "系统任务完成");
  assert.equal(flow.waitingCount, 1); // pending 还在（没被误消费）

  // 用户真正回复"批准" → 消费
  assert.equal(flow.handleReply("terminal", "批准"), true);
  assert.equal(await pending, true);
});

// ─── 回归：孤儿 tool 消息 / 过期 timer / nextRun 兜底 ─────────────

test("nextRun：永不匹配（2月30日）→ 返回 null，不空转", () => {
  const spec = parseCron("0 0 30 2 *"); // 2 月没有 30 日
  const next = nextRun(spec, new Date(2026, 0, 1, 0, 0));
  assert.equal(next, null); // 扫描 5 年上限后放弃
});

test("死循环判定后：同批 tool_call 全部回填，不留孤儿", async () => {
  const registry = buildCoreTools(() => true);
  let executed = 0;
  registry.register(
    {
      name: "tick",
      description: "计数用假工具",
      params: { type: "object", properties: {}, required: [] },
      fn: async () => {
        executed += 1;
        return { ok: true };
      },
    },
    "read",
  );

  // 第一轮一次抛出 5 个同签名 tool_call（第 3 个触发 LOOP_THRESHOLD）
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    if (messages.some((m) => m.role === "tool")) {
      return { role: "assistant", content: "收尾", tool_calls: null };
    }
    return {
      role: "assistant",
      content: null,
      tool_calls: Array.from({ length: 5 }, (_, i) => ({
        id: `t${i + 1}`,
        type: "function",
        function: { name: "tick", arguments: "{}" },
      })),
    };
  };

  const agent = new Agent({
    llm: fakeLlm,
    // 记忆用空壳：本用例只关心配对，避免后台提取写盘与 after 清理竞态
    memory: { recall: async () => [], formatRecall: () => "", scheduleExtract: () => {} },
    registry,
    systemPrompt: "sys",
    skills: new SkillRegistry(),
    hooks: new HookRegistry(),
    verbose: false,
  });

  const answer = await agent.run("批量调用");
  assert.equal(answer, "收尾");

  const assistantWithCalls = agent.cm.recent.find(
    (m) => m.role === "assistant" && m.tool_calls?.length === 5,
  );
  assert.ok(assistantWithCalls, "应有一轮带 5 个 tool_calls 的 assistant 消息");

  // 每个 tool_call_id 都必须有配对的 role:tool 消息（否则下一轮请求 400）
  const toolMsgs = agent.cm.recent.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 5);
  const pairedIds = new Set(toolMsgs.map((m) => m.tool_call_id));
  for (const tc of assistantWithCalls.tool_calls) {
    assert.ok(pairedIds.has(tc.id), `孤儿 tool_call：${tc.id} 没有回填`);
  }

  // 触发判定后不再真的执行：5 条调用只有前 2 条落地
  assert.equal(executed, 2);
  const loopMsgs = toolMsgs.filter((m) =>
    String(m.content).includes("LOOP_DETECTED"),
  );
  assert.equal(loopMsgs.length, 3); // 第 3、4、5 条都是判定结果
});

test("同名任务覆盖：旧 timer 被清理（否则 stopAll 漏掉它）", () => {
  const cron = new CronScheduler({ log: () => {} });
  const original = globalThis.clearTimeout;
  const cleared = [];
  globalThis.clearTimeout = (t) => {
    cleared.push(t);
    return original(t);
  };
  try {
    const j1 = cron.scheduleInterval(60000, () => {}, { name: "同名" });
    const j2 = cron.scheduleInterval(60000, () => {}, { name: "同名" });
    assert.equal(cron.jobs.size, 1); // Map 按 name 覆盖
    assert.equal(cron.jobs.get("同名").timer, j2.timer);
    assert.ok(cleared.includes(j1.timer), "旧任务的 timer 应被 clearTimeout");
  } finally {
    globalThis.clearTimeout = original;
    cron.stopAll();
  }
});
