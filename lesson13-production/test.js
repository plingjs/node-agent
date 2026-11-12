/**
 * lesson13 · 自测（node:test，零依赖）
 * 覆盖：错误分类/重试/熔断 / SSE 流式 / 观测统计 / 评测 / 调用链集成
 * 跑法：node --test --test-force-exit test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { MEMORY_ROOT } from "./memory_store.js";
import { LlmError, isRetryable, errorFromStatus, withRetry, CircuitBreaker } from "./llm_retry.js";
import { createStreamingLlm } from "./streaming.js";
import { Telemetry } from "./telemetry.js";
import { runEvaluation, EVAL_CASES } from "./evaluate.js";
import { createLlmChain } from "./llm_chain.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { buildCoreTools } from "./core_tools.js";
import { SkillRegistry } from "./skill_registry.js";
import { HookRegistry } from "./hooks/hook_registry.js";
import { SessionManager } from "./session_manager.js";
import { AgentBridge } from "./agent_bridge.js";
import { MockGateway } from "./gateway/mock_gateway.js";
import { TerminalGateway } from "./gateway/terminal_gateway.js";
import { SubAgent } from "./subagent.js";
import { CronScheduler } from "./cron/cron_scheduler.js";

before(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});
after(async () => {
  // 等后台记忆提取（agent.run 末尾 scheduleExtract）跑完再删目录——
  // 否则提取任务与 teardown 的 rm 竞态，刷出一行与断言无关的 ENOENT 噪音
  await wait(150);
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});

function wait(ms = 30) {
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

// ─── v1+v2: 错误分类 / 重试 / 熔断 ────────────────────────────────

test("isRetryable：错误分类", () => {
  assert.equal(isRetryable(new LlmError("429", { status: 429, retryable: true })), true);
  assert.equal(isRetryable(new LlmError("400", { status: 400, retryable: false })), false);
  assert.equal(isRetryable(new TypeError("fetch failed")), true); // 网络错误
  assert.equal(isRetryable(new Error("普通错误")), false);
});

test("errorFromStatus：HTTP 状态码 → 可重试性", () => {
  assert.equal(errorFromStatus(500, "x").retryable, true);
  assert.equal(errorFromStatus(429, "x").retryable, true);
  assert.equal(errorFromStatus(400, "x").retryable, false);
  assert.equal(errorFromStatus(401, "x").retryable, false);
});

test("withRetry：可重试错误指数退避后成功", async () => {
  let calls = 0;
  const base = async () => {
    calls += 1;
    if (calls < 3) throw new LlmError("500", { status: 500, retryable: true });
    return "成功";
  };
  const retries = [];
  const wrapped = withRetry(base, {
    maxRetries: 3,
    baseDelayMs: 1,
    onRetry: (info) => retries.push(info.attempt),
  });

  const result = await wrapped();
  assert.equal(result, "成功");
  assert.equal(calls, 3); // 失败 2 次 + 成功 1 次
  assert.deepEqual(retries, [0, 1]); // 重试 2 次
});

test("withRetry：不可重试错误立即抛（不重试）", async () => {
  let calls = 0;
  const base = async () => {
    calls += 1;
    throw new LlmError("400", { status: 400, retryable: false });
  };
  const retries = [];
  const wrapped = withRetry(base, {
    maxRetries: 3,
    baseDelayMs: 1,
    onRetry: () => retries.push(1),
  });

  await assert.rejects(wrapped(), /400/);
  assert.equal(calls, 1); // 只调一次
  assert.equal(retries.length, 0);
});

test("CircuitBreaker：连续失败短路，冷却后半开试探", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 100, now: () => t });
  let t = 0;

  // 失败 3 次 → open
  cb.onFailure();
  cb.onFailure();
  cb.onFailure();
  assert.equal(cb.status.state, "open");
  assert.equal(cb.beforeCall(), false); // 短路拒绝

  // 冷却期结束 → half_open 试探
  t = 101;
  assert.equal(cb.beforeCall(), true);
  assert.equal(cb.status.state, "half_open");

  // 试探成功 → closed
  cb.onSuccess();
  assert.equal(cb.status.state, "closed");
  assert.equal(cb.beforeCall(), true);
});

test("withRetry + breaker：熔断后拒绝调用", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60000 });
  const base = async () => {
    throw new LlmError("500", { status: 500, retryable: true });
  };
  const wrapped = withRetry(base, { maxRetries: 1, baseDelayMs: 1, breaker: cb });

  await assert.rejects(wrapped(), /500/); // 第一次：重试后仍 500（触发熔断，2 次失败=阈值）
  // 已 open → 下一次直接拒绝（不发请求）
  await assert.rejects(wrapped(), /熔断器已短路/);
});

// ─── v3: SSE 流式 ────────────────────────────────────────────────

function sseStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
}

test("createStreamingLlm：SSE 逐 token 回调 + 完整内容", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    body: sseStream([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  });
  try {
    const deltas = [];
    const llm = createStreamingLlm(
      { baseUrl: "https://x/v1", apiKey: "k", model: "m" },
      (d) => deltas.push(d),
    );
    const result = await llm([{ role: "user", content: "hi" }], null);
    assert.equal(result.content, "你好");
    assert.deepEqual(deltas, ["你", "好"]); // 逐 token
  } finally {
    globalThis.fetch = original;
  }
});

test("createStreamingLlm：流式超时抛可重试错误", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (url, opts) =>
    new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("Aborted")));
    });
  try {
    const llm = createStreamingLlm(
      { baseUrl: "https://x/v1", apiKey: "k", model: "m" },
      null,
      { timeoutMs: 50 },
    );
    const err = await llm([], null).catch((e) => e);
    assert.ok(err.message.includes("超时"));
    assert.equal(err.retryable, true); // 超时可重试
  } finally {
    globalThis.fetch = original;
  }
});

// ─── v4: 观测统计 ────────────────────────────────────────────────

test("Telemetry：summary 统计（token/成本/耗时/错误率）", () => {
  const telemetry = new Telemetry({
    now: () => 1000,
    priceTable: { "glm-4-flash": { input: 1, output: 2 } }, // 1 元/百万 in，2 元/百万 out
  });

  telemetry.llmCall({ model: "glm-4-flash", promptTokens: 1000, completionTokens: 500, durationMs: 200 });
  telemetry.llmCall({ model: "glm-4-flash", promptTokens: 1000, completionTokens: 500, durationMs: 300, ok: false });
  telemetry.toolCall({ name: "run_shell", status: "ok", durationMs: 50 });

  const s = telemetry.summary();
  assert.equal(s.llmCalls, 2);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.totalTokens, 3000);
  assert.equal(s.estimatedCostYuan, 0.004); // (2000/1M)*1 + (1000/1M)*2 = 0.004
  assert.equal(s.avgLlmDurationMs, 250);
  assert.equal(s.llmErrorRate, 0.5);
});

// ─── 调用链集成（traced + retry + streaming）─────────────────────

test("createLlmChain：重试 + 观测记录（agent 零改动）", async () => {
  const telemetry = new Telemetry();
  let calls = 0;
  const base = async () => {
    calls += 1;
    if (calls < 3) throw new LlmError("500", { status: 500, retryable: true });
    return { role: "assistant", content: "最终回答", tool_calls: null };
  };

  const { llm, breaker } = createLlmChain({
    base,
    model: "glm-4-flash",
    telemetry,
    maxRetries: 3,
    baseDelayMs: 1,
  });

  const result = await llm([{ role: "user", content: "hi" }], null);
  assert.equal(result.content, "最终回答");
  assert.equal(calls, 3); // 内部重试了

  const s = telemetry.summary();
  assert.equal(s.llmCalls, 1); // 观测只记一次（最终成功）
  assert.ok(s.totalTokens > 0); // token 已估算
  // 重试事件也被观测
  const retryEvents = telemetry.events.filter((e) => e.type === "retry");
  assert.equal(retryEvents.length, 2);
  assert.equal(breaker.status.state, "closed");
});

// ─── 终端体验（打字机/等待 prompt/不重复）─────────────────────────

test("TerminalGateway：流式输出后 send 不重复打印，markTypingDone 才收尾", async () => {
  const term = new TerminalGateway();
  term.markStreaming();
  await term.send("terminal", "重复内容");
  assert.equal(term._streaming, true); // send 不消费标志（等打字机完成）
  assert.equal(term.sent.length, 1); // 记录仍完整

  // 打字机完成 → 收尾 + 通知
  const waiting = term.waitReplyDone(5000);
  term.markTypingDone();
  assert.equal(term._streaming, false);
  await waiting; // markTypingDone 后 resolve
});

test("TerminalGateway：waitReplyDone 由非流式 send 通知（不等超时）", async () => {
  const term = new TerminalGateway();
  const waiting = term.waitReplyDone(5000);
  await term.send("terminal", "回复"); // 非流式（未 markStreaming）→ send 即通知
  await waiting;
});

test("bridge attach：处理完成后调 onMessageDone（无回复也通知）", async () => {
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    return { role: "assistant", content: "ok", tool_calls: null };
  };
  const mock = new MockGateway();
  let doneCount = 0;
  mock.onMessageDone = () => {
    doneCount += 1;
  };
  const bridge = new AgentBridge({
    agent: makeAgent(fakeLlm),
    sessions: new SessionManager({ dir: "/tmp/lesson13-test-done" }),
  });
  await rm("/tmp/lesson13-test-done", { recursive: true, force: true });
  bridge.attach(mock);

  mock.receive({ channelId: "u1", text: "你好" });
  await wait(80);
  assert.equal(doneCount, 1); // 处理完成信号（prompt 显示时机）
  assert.equal(mock.sent.length, 1);
});


test("runEvaluation：评测集通过率（mock LLM）", async () => {
  // fake LLM：按输入返回工具调用或直接回答
  const fakeLlm = async (messages, tools) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    if (lastUser.includes("搜索")) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "search_files", arguments: "{}" } }],
      };
    }
    if (lastUser.includes("读一下")) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      };
    }
    if (lastUser.includes("rm -rf")) {
      return { role: "assistant", content: "我拒绝执行危险操作", tool_calls: null };
    }
    return { role: "assistant", content: "答案是 2", tool_calls: null };
  };

  const agent = new Agent({
    llm: fakeLlm,
    memory: new MemoryManager(),
    registry: buildCoreTools(() => true),
    systemPrompt: "sys",
    skills: new SkillRegistry(),
    hooks: new HookRegistry(),
    verbose: false,
  });

  const result = await runEvaluation({ agent });
  assert.equal(result.total, EVAL_CASES.length);
  assert.equal(result.passed, result.total); // 全部通过
  assert.equal(result.passRate, 1);
});

// ─── 防失控：Loop 判定不得留下孤儿 tool 消息（lesson02/03/04 同族修复）─────

test("Loop 判定后同轮剩余 tool_calls 仍逐条回填（无孤儿 tool 消息）", async () => {
  // 每轮都返回两个同签名 tool_calls：第 2 轮起触发 Loop 检测
  let round = 0;
  const fakeLlm = async () => {
    round += 1;
    const call = (id) => ({
      id,
      type: "function",
      function: { name: "read_file", arguments: '{"file_path":"/nonexistent-xyz"}' },
    });
    return { role: "assistant", content: null, tool_calls: [call(`r${round}a`), call(`r${round}b`)] };
  };
  const agent = makeAgent(fakeLlm);
  await agent.run("循环测试");

  const called = [];
  for (const m of agent.cm.recent) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) called.push(tc.id);
    }
  }
  const answered = agent.cm.recent
    .filter((m) => m.role === "tool")
    .map((m) => m.tool_call_id);

  assert.ok(called.length >= 4, `应转多轮（实际 ${called.length} 个 tool_call）`);
  // 每个 tool_call 都必须有且只有一条 tool 消息应答——少一条，下一轮请求被服务端 400
  assert.deepEqual([...answered].sort(), [...called].sort());
  assert.ok(
    agent.cm.recent.some(
      (m) => m.role === "tool" && String(m.content).includes("LOOP_DETECTED"),
    ),
    "应回填 LOOP_DETECTED 错误",
  );
});

test("子 Agent：Loop 判定后同轮剩余 tool_calls 也逐条回填", async () => {
  let round = 0;
  const fakeLlm = async () => {
    round += 1;
    const call = (id) => ({
      id,
      type: "function",
      function: { name: "read_file", arguments: '{"file_path":"/nonexistent-xyz"}' },
    });
    return { role: "assistant", content: null, tool_calls: [call(`s${round}a`), call(`s${round}b`)] };
  };
  const sub = new SubAgent({ llm: fakeLlm, registry: buildCoreTools(() => true) });
  await sub.run("循环测试");

  const called = [];
  for (const m of sub.cm.recent) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) called.push(tc.id);
    }
  }
  const answered = sub.cm.recent
    .filter((m) => m.role === "tool")
    .map((m) => m.tool_call_id);
  assert.ok(called.length >= 4, `子 Agent 应转多轮（实际 ${called.length} 个 tool_call）`);
  assert.deepEqual([...answered].sort(), [...called].sort());
});

// ─── 定时任务：同名覆盖不得留下够不到的 timer ─────────────────────

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
