/**
 * lesson03-context · 自测（node:test，零依赖）
 * 验证：完整工具系统 + 上下文管理 + 防失控 三套能力协同工作
 * 跑法：node --test test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { TieredContextManager } from "./context_manager_v2.js";
import { Agent } from "./agent.js";
import { NOTES, buildRegistry } from "./tools_demo.js";
import { ErrorCode, executionFailed } from "./errors.js";

/** 构造一个带 tool_calls 的模型响应 */
function toolCallMsg(name, args, callId = "c1") {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

// ─── 工具系统仍正常（来自 lesson02）───────────────────────────────

test("完整工具系统：权限分级仍生效", async () => {
  const r = buildRegistry(() => false); // confirm 全部拒绝
  NOTES.clear();
  const res = await r.execute("write_note", '{"title":"t","content":"c"}');
  assert.equal(res.error.code, ErrorCode.PERMISSION_DENIED);
  assert.equal(NOTES.size, 0);
});

test("完整工具系统：参数校验仍生效", async () => {
  const r = buildRegistry(() => true);
  const res = await r.execute("get_weather", "{}");
  assert.equal(res.error.code, ErrorCode.INVALID_PARAMS);
});

// ─── 合并版 Agent：工具系统 + 上下文管理协同 ──────────────────────

test("Agent 调用大结果工具时结果被截断", async () => {
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 4 });
  cm.setSystem([{ role: "system", content: "sys" }]);

  let toolContent = null;
  const fakeLlm = async (messages) => {
    const toolMsgs = messages.filter((m) => m.role === "tool");
    if (toolMsgs.length === 0) {
      return toolCallMsg("search_logs", { keyword: "timeout" });
    }
    toolContent = toolMsgs[toolMsgs.length - 1].content;
    return { role: "assistant", content: "查到了", tool_calls: null };
  };

  const registry = buildRegistry(() => true);
  const agent = new Agent({ registry, cm, llm: fakeLlm, verbose: false });
  await agent.run("搜索日志");

  // search_logs 返回几 MB，必须被截断
  assert.ok(toolContent.includes("已截断"));
});

test("Agent 多轮对话触发压缩仍能收尾", async () => {
  const cm = new TieredContextManager({
    maxTokens: 200,
    reserveForOutput: 50,
    compactRatio: 0.5,
    keepRecent: 2,
  });
  cm.setSystem([{ role: "system", content: "sys" }]);

  let compactionHappened = false;
  const fakeLlm = async (messages, tools) => {
    // summarize 调用（compact 内部）→ 传 tools=null，返回真实摘要文本
    if (tools === null) {
      return { role: "assistant", content: "摘要：之前已查询过天气" };
    }
    // 正常推理：检测到摘要消息 → 压缩已发生
    if (messages.some((m) => String(m.content).includes("[对话历史摘要]"))) {
      compactionHappened = true;
    }
    return toolCallMsg("get_weather", { city: "北京" });
  };

  const registry = buildRegistry(() => true);
  const agent = new Agent({ registry, cm, llm: fakeLlm, verbose: false });

  // 初始就塞一些消息，让压缩尽快触发
  for (let i = 0; i < 30; i++) {
    cm.append({ role: "user", content: `前置消息${i}`.repeat(5) });
  }
  await agent.run("查天气");
  assert.ok(compactionHappened); // 压缩被触发
});

// ─── 防失控仍生效（来自 lesson02）──────────────────────────────────

test("Agent Loop 检测仍生效", async () => {
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 4 });
  cm.setSystem([{ role: "system", content: "sys" }]);

  let lastToolContent = null;
  const fakeLlm = async (messages) => {
    const toolMsgs = messages.filter((m) => m.role === "tool");
    if (toolMsgs.length > 0) {
      lastToolContent = JSON.parse(toolMsgs[toolMsgs.length - 1].content);
    }
    return toolCallMsg("get_weather", { city: "北京" });
  };

  const registry = buildRegistry(() => true);
  const agent = new Agent({ registry, cm, llm: fakeLlm, verbose: false });
  await agent.run("循环测试");

  // 模型反复调同一工具 → LOOP_DETECTED 注入
  assert.equal(lastToolContent.error.code, "LOOP_DETECTED");
});

// ─── 补齐两条此前没有回归保护的边界 ───────────────────────────────

test("Loop 检测触发时，同一响应里剩余 tool_calls 仍逐条回填", async () => {
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 4 });
  cm.setSystem([{ role: "system", content: "sys" }]);

  const batch = (ids) => ({
    role: "assistant",
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"北京"}' },
    })),
  });

  let turn = 0;
  const fakeLlm = async () => {
    turn += 1;
    if (turn === 1) return batch(["a1"]);              // 该签名计数 1
    if (turn === 2) return batch(["b1", "b2", "b3"]);  // 计数 2、3（触发）、4
    return { role: "assistant", content: "已放弃该方案", tool_calls: null };
  };

  const agent = new Agent({ registry: buildRegistry(() => true), cm, llm: fakeLlm, verbose: false });
  await agent.run("循环测试");

  // 每个 tool_call id 都要有配对的 role="tool"，漏一个下一轮请求就是 API 400
  const orphans = [];
  cm.recent.forEach((m, i) => {
    for (const tc of m.tool_calls || []) {
      const matched = cm.recent.slice(i + 1).some(
        (x) => x.role === "tool" && x.tool_call_id === tc.id,
      );
      if (!matched) orphans.push(tc.id);
    }
  });
  assert.deepEqual(orphans, []);

  const contents = cm.recent
    .filter((m) => m.role === "tool")
    .map((m) => [m.tool_call_id, JSON.parse(m.content).error?.code]);
  assert.deepEqual(contents, [
    ["a1", undefined],            // 正常执行
    ["b1", undefined],
    ["b2", "LOOP_DETECTED"],      // 触发死循环的那条
    ["b3", "LOOP_DETECTED"],      // 同批未执行的，也要给模型一个明确回复
  ]);
});

test("retryable 错误累计到预算上限后注入 ERROR_BUDGET_EXHAUSTED", async () => {
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 4 });
  cm.setSystem([{ role: "system", content: "sys" }]);

  const registry = buildRegistry(() => true);
  registry.register(
    {
      name: "flaky",
      description: "总是网络超时的演示工具。",
      params: { type: "object", properties: { attempt: { type: "string" } } },
      fn: async () => {
        throw executionFailed("网络超时", true); // retryable = true，会被错误预算计数
      },
    },
    "read",
  );

  let n = 0;
  // 每次参数都不同，避免先撞上 Loop 检测（同工具 + 同参数重复 3 次）
  const fakeLlm = async () => toolCallMsg("flaky", { attempt: String(n) }, `c${n++}`);
  const agent = new Agent({ registry, cm, llm: fakeLlm, verbose: false });
  await agent.run("重试预算测试");

  const codes = cm.recent
    .filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content).error.code);
  // 前 3 次照实回传 EXECUTION_FAILED，第 4 次起预算耗尽
  assert.deepEqual(codes.slice(0, 3), ["EXECUTION_FAILED", "EXECUTION_FAILED", "EXECUTION_FAILED"]);
  assert.equal(codes[3], "ERROR_BUDGET_EXHAUSTED");
  assert.ok(codes.slice(3).every((c) => c === "ERROR_BUDGET_EXHAUSTED"));
});
