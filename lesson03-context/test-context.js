/**
 * lesson03-context · 上下文演进用例（v1~v5，node:test，零依赖）
 *
 * 与 test.js 分工：
 *   test.js          → 三套能力协同回归（工具系统 × 上下文 × 防失控，5 例）
 *   test-context.js  → 上下文机制自身的演进用例（token/滑动窗口/截断/摘要/三层，13 例）
 *
 * 来源：旧版独立第 3 课的用例集，随课程合并归档后恢复为常态回归
 * （归档包 _archive/lesson03-context-standalone-20260912-1549.zip）。
 * 跑法：npm test（两个文件一起跑）或 node --test test-context.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { estimateTokens, countTokens } from "./token_counter.js";
import { slidingWindow, isSystemPreserved } from "./sliding_window.js";
import { ContextManager } from "./context_manager.js";
import { summarize, compact } from "./summary_compactor.js";
import {
  TieredContextManager,
  truncateToolResult,
} from "./context_manager_v2.js";
import { Agent } from "./agent.js";
import { buildRegistry } from "./tools_demo.js";

// ─── v1: token 估算 ────────────────────────────────────────────────

test("CJK 每字 1 token，英文每 4 字符 1 token", () => {
  assert.equal(estimateTokens("你好"), 2); // 2 个汉字
  assert.equal(estimateTokens("hello world"), 3); // 11 字符 / 4 = 2.75 → 3
});

test("countTokens 累计所有消息", () => {
  const msgs = [
    { role: "system", content: "你是助手" },
    { role: "user", content: "hello" },
  ];
  assert.ok(countTokens(msgs) > 0);
});

// ─── v2: 滑动窗口 ──────────────────────────────────────────────────

test("滑动窗口超预算丢弃旧消息", () => {
  const msgs = [
    { role: "system", content: "你是一个很长的系统提示词".repeat(50) }, // 大
    { role: "user", content: "问题1" },
    { role: "assistant", content: "回答1" },
    { role: "user", content: "问题2" },
  ];
  const trimmed = slidingWindow(msgs, 30);
  assert.ok(trimmed.length < msgs.length);
  assert.equal(trimmed[trimmed.length - 1].content, "问题2"); // 最新的保留
});

test("滑动窗口会丢 system（缺陷演示）", () => {
  const msgs = [
    { role: "system", content: "x".repeat(200) }, // 200 字符 ≈ 50 token
    { role: "user", content: "hi" },
  ];
  const trimmed = slidingWindow(msgs, 20); // 预算只够 user
  assert.equal(isSystemPreserved(msgs, trimmed), false); // system 被丢
});

// ─── v3: 分层截断 ──────────────────────────────────────────────────

test("ContextManager 永远保留 system 和最后 user", () => {
  const cm = new ContextManager({ maxTokens: 100 });
  const msgs = [
    { role: "system", content: "你是助手" },
    { role: "user", content: "问题1" },
    { role: "assistant", content: "回答1" },
    { role: "user", content: "问题2（当前）" },
  ];
  const trimmed = cm.trim(msgs);
  assert.equal(trimmed[0].role, "system"); // system 在
  assert.equal(trimmed[trimmed.length - 1].content, "问题2（当前）"); // 最后 user 在
});

test("ContextManager 中间历史从旧到新丢弃", () => {
  const cm = new ContextManager({ maxTokens: 40 });
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "旧问题1" },
    { role: "assistant", content: "旧回答1" },
    { role: "user", content: "新问题" },
  ];
  const trimmed = cm.trim(msgs);
  // 预算紧张时，中间最旧的 user 可能被丢，但 system 和最后 user 一定在
  assert.equal(trimmed[0].role, "system");
  assert.equal(trimmed[trimmed.length - 1].content, "新问题");
});

// ─── v4: 摘要压缩 ──────────────────────────────────────────────────

test("summarize 调用 LLM 返回摘要", async () => {
  const fakeLlm = async (messages) => ({
    role: "assistant",
    content: "摘要：用户要查天气",
  });
  const summary = await summarize(fakeLlm, [
    { role: "user", content: "查北京天气" },
  ]);
  assert.equal(summary, "摘要：用户要查天气");
});

test("compact 保留最近 keepRecent 条，其余压成摘要", async () => {
  const fakeLlm = async () => ({ role: "assistant", content: "压缩结果" });
  const msgs = [
    { role: "user", content: "m1" },
    { role: "assistant", content: "m2" },
    { role: "user", content: "m3" },
    { role: "assistant", content: "m4" },
  ];
  const { summaryMessage, remaining } = await compact(fakeLlm, msgs, 2);
  assert.ok(summaryMessage.content.includes("压缩结果"));
  assert.equal(remaining.length, 2); // 保留最后 2 条
});

// ─── v5: 三层上下文 + 预算 ─────────────────────────────────────────

test("truncateToolResult 截断超大结果", () => {
  const big = "a".repeat(10000);
  const truncated = truncateToolResult(big, 100);
  assert.ok(truncated.length < big.length);
  assert.ok(truncated.includes("已截断"));
});

test("TieredContextManager build 三层结构", () => {
  const cm = new TieredContextManager({ maxTokens: 1000 });
  cm.setSystem([{ role: "system", content: "sys" }]);
  cm.append({ role: "user", content: "hi" });
  const built = cm.build();
  assert.equal(built[0].role, "system");
  assert.equal(built[built.length - 1].content, "hi");
});

test("TieredContextManager compact 触发条件", async () => {
  const cm = new TieredContextManager({
    maxTokens: 500,
    reserveForOutput: 100,
    compactRatio: 0.5,
    keepRecent: 2,
  });
  cm.setSystem([{ role: "system", content: "sys" }]);
  // 塞入大量消息，使 recent 超过阈值
  for (let i = 0; i < 20; i++) {
    cm.append({ role: "user", content: `消息${i}`.repeat(10) });
  }
  assert.ok(cm.needsCompaction());

  const fakeLlm = async () => ({ role: "assistant", content: "合并摘要" });
  await cm.compact(fakeLlm);

  assert.ok(cm.summary.includes("合并摘要"));
  assert.equal(cm.recent.length, 2); // 只保留最近 2 条
});

test("budget 报告各层 token", () => {
  const cm = new TieredContextManager({ maxTokens: 1000, reserveForOutput: 100 });
  cm.setSystem([{ role: "system", content: "sys" }]);
  cm.append({ role: "user", content: "hi" });
  const b = cm.budget();
  assert.equal(b.maxTokens, 1000);
  assert.equal(b.reservedForOutput, 100);
  assert.ok(b.used.total > 0);
});

// ─── v6: Agent 集成 ────────────────────────────────────────────────

test("Agent 集成：两次工具调用后返回最终答案", async () => {
  const cm = new TieredContextManager({
    maxTokens: 300,
    reserveForOutput: 50,
    compactRatio: 0.5,
    keepRecent: 2,
  });
  cm.setSystem([{ role: "system", content: "你是助手" }]);

  const calls = [];
  const fakeLlm = async (messages, tools) => {
    calls.push(messages.length);
    // 前两轮调工具，第三轮给答案
    if (calls.length <= 2) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `c${calls.length}`,
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"北京"}' },
          },
        ],
      };
    }
    return { role: "assistant", content: "北京晴，已完成", tool_calls: null };
  };

  const agent = new Agent({ registry: buildRegistry(() => true), llm: fakeLlm, cm, verbose: false });
  const answer = await agent.run("查北京天气");
  assert.ok(answer.includes("北京"));
  assert.ok(calls.length >= 3); // 至少三轮（两次工具 + 一次收尾）
});
