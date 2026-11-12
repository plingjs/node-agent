/**
 * 第2课 · 自测（node:test，零依赖）
 * 跑法：node --test test.js   或   npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRegistry } from "./registry.js";
import { validateParams } from "./validation.js";
import { ErrorCode, ToolError, executionFailed, invalidParams, toolNotFound } from "./errors.js";
import { Kind, PermissionManager } from "./permissions.js";
import { createFullRegistry } from "./registry_full.js";
import { Agent, ERROR_BUDGET, LOOP_THRESHOLD, MAX_TURNS } from "./agent.js";
import { NOTES, buildRegistry } from "./tools_demo.js";

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

// ─── v1: schema 生成 ───────────────────────────────────────────────

test("schema 从工具定义对象生成", () => {
  const r = createRegistry();
  r.register({
    name: "greet",
    description: "向用户打招呼。",
    params: {
      type: "object",
      properties: { name: { type: "string" }, times: { type: "integer" } },
      required: ["name"],
    },
    fn: async ({ name, times = 1 }) => name.repeat(times),
  });

  const schema = r.getSchemas()[0];
  assert.equal(schema.function.name, "greet");
  assert.equal(schema.function.description, "向用户打招呼。");
  assert.deepEqual(schema.function.parameters.required, ["name"]);
});

// ─── v2: 参数校验 ──────────────────────────────────────────────────

const strIntParams = {
  type: "object",
  properties: { x: { type: "integer" } },
  required: ["x"],
};

test("缺必填参数报错", () => {
  assert.throws(() => validateParams(strIntParams, {}), (e) => {
    assert.ok(e instanceof ToolError);
    assert.equal(e.code, ErrorCode.INVALID_PARAMS);
    assert.match(e.message, /缺少必填参数 `x`/);
    return true;
  });
});

test("整数宽容转换只接受无损转换", () => {
  assert.equal(validateParams(strIntParams, { x: 3.0 }).x, 3);
  assert.equal(validateParams(strIntParams, { x: "3" }).x, 3);
  assert.throws(() => validateParams(strIntParams, { x: 3.7 })); // 小数不能静默截断
  assert.throws(() => validateParams(strIntParams, { x: "abc" }));
});

test("未知参数拒绝", () => {
  assert.throws(() => validateParams(strIntParams, { x: 1, extra: 2 }), /未知参数/);
});

// ─── v3: 结构化错误 ────────────────────────────────────────────────

test("错误码与 retryable 语义", () => {
  assert.equal(invalidParams("x").code, ErrorCode.INVALID_PARAMS);
  assert.equal(toolNotFound("x").code, ErrorCode.TOOL_NOT_FOUND);
  assert.equal(invalidParams("x").retryable, false);
  const retryable = new ToolError(ErrorCode.EXECUTION_FAILED, "网络超时", true);
  assert.equal(retryable.retryable, true);
});

test("toResult 结构", () => {
  const r = toolNotFound("nope").toResult();
  assert.equal(r.error.code, "TOOL_NOT_FOUND");
  assert.match(r.error.message, /不存在/);
});

// ─── v4: 权限分级 ──────────────────────────────────────────────────

test("read 自动放行", async () => {
  const pm = new PermissionManager(() => true);
  pm.setKind("get_weather", Kind.READ);
  assert.equal(await pm.check("get_weather", {}), true);
});

test("write 需要确认", async () => {
  const calls = [];
  const pm = new PermissionManager((name) => (calls.push(name), true));
  pm.setKind("write_note", Kind.WRITE);
  assert.equal(await pm.check("write_note", {}), true);
  assert.deepEqual(calls, ["write_note"]);
});

test("always 记住后不再询问", async () => {
  const calls = [];
  const pm = new PermissionManager((name) => (calls.push(name), "always"));
  pm.setKind("write_note", Kind.WRITE);
  assert.equal(await pm.check("write_note", {}), true); // 第一次：always
  assert.equal(await pm.check("write_note", {}), true); // 第二次：直接放行
  assert.equal(calls.length, 1);
});

test("权限状态实例隔离（会话 A 不影响会话 B）", async () => {
  const pmA = new PermissionManager(() => "always");
  pmA.setKind("write_note", Kind.WRITE);
  await pmA.check("write_note", {}); // A 批准并记住

  const pmB = new PermissionManager(() => false);
  pmB.setKind("write_note", Kind.WRITE);
  await assert.rejects(() => pmB.check("write_note", {})); // B 仍需确认且被拒
});

test("拒绝抛权限错误", async () => {
  const pm = new PermissionManager(() => false);
  pm.setKind("delete_note", Kind.DANGER);
  await assert.rejects(
    () => pm.check("delete_note", {}),
    (e) => {
      assert.equal(e.code, ErrorCode.PERMISSION_DENIED);
      return true;
    },
  );
});

// ─── v2 完整流水线 ─────────────────────────────────────────────────

test("流水线成功路径", async () => {
  const r = buildRegistry(() => true);
  const res = await r.execute("get_weather", '{"city": "北京"}');
  assert.equal(res.result.weather, "晴 25°C");
});

test("工具不存在", async () => {
  const r = buildRegistry(() => true);
  const res = await r.execute("hack_tool", "{}");
  assert.equal(res.error.code, ErrorCode.TOOL_NOT_FOUND);
});

test("非法 JSON 参数", async () => {
  const r = buildRegistry(() => true);
  const res = await r.execute("get_weather", "{bad json");
  assert.equal(res.error.code, ErrorCode.INVALID_PARAMS);
});

test("缺参返回结构化错误", async () => {
  const r = buildRegistry(() => true);
  const res = await r.execute("get_weather", "{}");
  assert.equal(res.error.code, ErrorCode.INVALID_PARAMS);
  assert.match(res.error.message, /city/);
});

test("权限拒绝不落库", async () => {
  const r = buildRegistry(() => false);
  NOTES.clear();
  const res = await r.execute("write_note", '{"title": "t", "content": "c"}');
  assert.equal(res.error.code, ErrorCode.PERMISSION_DENIED);
  assert.equal(NOTES.size, 0);
});

// ─── v5: 主循环防失控 ──────────────────────────────────────────────

test("Loop 检测注入 LOOP_DETECTED", async () => {
  const registry = buildRegistry(() => true);

  // 连续 LOOP_THRESHOLD 次调用同一工具同参数
  const responses = [];
  for (let i = 0; i < LOOP_THRESHOLD; i++) {
    responses.push(toolCallMsg("get_weather", { city: "北京" }, `c${i}`));
  }

  let lastToolContent = null;
  const fakeLlm = async (messages) => {
    const toolMsgs = messages.filter((m) => m.role === "tool");
    if (toolMsgs.length > 0) {
      lastToolContent = JSON.parse(toolMsgs[toolMsgs.length - 1].content);
    }
    return responses.length > 0
      ? responses.shift()
      : { role: "assistant", content: "完成", tool_calls: null };
  };

  const agent = new Agent(registry, { llm: fakeLlm, verbose: false });
  await agent.run("测试");
  assert.equal(lastToolContent.error.code, "LOOP_DETECTED");
});

test("write 工具经 Agent 落库", async () => {
  NOTES.clear();
  const registry = buildRegistry(() => true);
  const fakeLlm = async () => toolCallMsg("write_note", { title: "t", content: "c" });
  const agent = new Agent(registry, { llm: fakeLlm, verbose: false });

  await agent.run("写笔记");
  assert.equal(NOTES.get("t"), "c");
});

// ─── 边界补齐：错误预算 / 轮数兜底 / 权限边界 / 刻意缺口 ─────────────

/** 造一个只读探针工具：参数唯一，方便把"重复调用"从测试里排除 */
function buildProbeRegistry(fn) {
  const r = createFullRegistry(() => true);
  r.register({
    name: "probe",
    description: "测试探针。",
    params: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
    fn: fn || (async ({ q }) => `ok:${q}`),
  });
  return r;
}

test("错误预算耗尽注入 ERROR_BUDGET_EXHAUSTED", async () => {
  // 工具永远返回 retryable 错误（模拟依赖持续超时）；参数每次不同，避免触发 Loop 检测
  const registry = buildProbeRegistry(async () => {
    throw executionFailed("依赖超时", true);
  });

  let turn = 0;
  let lastTool = null;
  const fakeLlm = async (messages) => {
    const toolMsgs = messages.filter((m) => m.role === "tool");
    if (toolMsgs.length > 0) lastTool = JSON.parse(toolMsgs[toolMsgs.length - 1].content);
    if (toolMsgs.length >= ERROR_BUDGET) {
      return { role: "assistant", content: "放弃这个方案", tool_calls: null };
    }
    turn += 1;
    return toolCallMsg("probe", { q: String(turn) }, `b${turn}`);
  };

  const agent = new Agent(registry, { llm: fakeLlm, verbose: false });
  const answer = await agent.run("反复重试");

  assert.equal(lastTool.error.code, ErrorCode.ERROR_BUDGET_EXHAUSTED);
  assert.equal(answer, "放弃这个方案");
  assert.equal(turn, ERROR_BUDGET); // 正好烧满预算就收手，不无限重试
});

test("每轮都调工具时 MAX_TURNS 兜底结束", async () => {
  const registry = buildProbeRegistry();
  let calls = 0;
  const fakeLlm = async () => {
    calls += 1;
    return toolCallMsg("probe", { q: String(calls) }, `m${calls}`);
  };

  const agent = new Agent(registry, { llm: fakeLlm, verbose: false });
  const answer = await agent.run("模型永远不收尾");

  assert.match(answer, /达到最大轮数/);
  assert.equal(calls, MAX_TURNS); // 精确停在第 MAX_TURNS 轮
});

test('danger 工具选了"始终允许"也每次必问', async () => {
  const asked = [];
  const pm = new PermissionManager((name) => (asked.push(name), "always"));
  pm.setKind("delete_note", Kind.DANGER);

  assert.equal(await pm.check("delete_note", {}), true);
  assert.equal(await pm.check("delete_note", {}), true);
  // "always" 只进了 alwaysAllow 集合，但集合只对 WRITE 生效 → 第二次仍然问
  assert.equal(asked.length, 2);
});

test("无确认通道时 fail-closed 拒绝 write", async () => {
  const pm = new PermissionManager(null);
  pm.setKind("write_note", Kind.WRITE);

  await assert.rejects(
    () => pm.check("write_note", {}),
    (e) => e.code === ErrorCode.PERMISSION_DENIED,
  );
});

test("工具业务错误转结构化结果（EXECUTION_FAILED）", async () => {
  const r = buildRegistry(() => true);
  const res = await r.execute("get_weather", '{"city": "杭州"}');

  assert.equal(res.error.code, ErrorCode.EXECUTION_FAILED);
  assert.equal(res.error.retryable, false); // 查无此城市是业务语义，重试没意义
});

test("注册工具时必须声明安全等级", () => {
  const r = createFullRegistry(null);
  assert.throws(() => r.register({
    name: "purge_all",
    description: "清空所有数据。",
    params: { type: "object", properties: {} },
    fn: async () => "已清空",
  }), /必须声明有效的安全等级/);
});

test("一轮内判定死循环后，剩余 tool_call 仍按 id 回填", async () => {
  const registry = buildProbeRegistry();
  let secondRequest = null;
  let calls = 0;

  const fakeLlm = async (messages) => {
    calls += 1;
    if (calls === 1) {
      // 一轮里 4 个同签名调用：第 3 个触发 Loop 检测，第 4 个必须仍被回填
      return {
        role: "assistant",
        content: null,
        tool_calls: [0, 1, 2, 3].map((i) => ({
          id: `k${i}`,
          type: "function",
          function: { name: "probe", arguments: JSON.stringify({ q: "same" }) },
        })),
      };
    }
    secondRequest = messages;
    return { role: "assistant", content: "完成", tool_calls: null };
  };

  const agent = new Agent(registry, { llm: fakeLlm, verbose: false });
  await agent.run("同签名连发");

  const toolMsgs = secondRequest.filter((m) => m.role === "tool");
  assert.deepEqual(
    toolMsgs.map((m) => m.tool_call_id),
    ["k0", "k1", "k2", "k3"],
  );
  assert.equal(JSON.parse(toolMsgs[0].content).result, "ok:same");
  assert.equal(JSON.parse(toolMsgs[2].content).error.code, ErrorCode.LOOP_DETECTED);
  assert.equal(JSON.parse(toolMsgs[3].content).error.code, ErrorCode.LOOP_DETECTED);
});
