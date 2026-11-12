/**
 * lesson09 · 自测（node:test，零依赖）
 * 覆盖：MCP server/client 真实 IPC / 工具注册 / Hooks / Agent 集成 /
 *       Loop 检测配对回归（本章修复）
 * 跑法：node --test test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { MEMORY_ROOT } from "./memory_store.js";
import { McpClient } from "./mcp/mcp_client.js";
import { registerMcpTools } from "./mcp/mcp_tools.js";
import { HookRegistry, HookEvent } from "./hooks/hook_registry.js";
import { Agent } from "./agent.js";
import { SubAgent } from "./subagent.js";
import { MemoryManager } from "./memory_manager.js";
import { buildCoreTools } from "./core_tools.js";
import { SkillRegistry } from "./skill_registry.js";

before(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});
after(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});

function wait(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 断言每条 assistant(tool_calls) 里的 id 都有配对的 tool 消息（少一条下一轮 API 400） */
function assertAllToolCallsPaired(built) {
  for (let i = 0; i < built.length; i++) {
    const m = built[i];
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const paired = built
        .slice(i + 1)
        .some((x) => x.role === "tool" && x.tool_call_id === tc.id);
      assert.ok(paired, `tool_call ${tc.id} 没有配对的 tool 消息`);
    }
  }
}

// ─── v2: MCP 客户端（真实子进程 IPC）──────────────────────────────

test("MCP client：连接 → 发现工具 → 调用（真实 stdio 通信）", async () => {
  const client = new McpClient();
  await client.connect();

  // 发现工具
  const tools = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("add"));
  assert.ok(names.includes("echo"));

  // 调用工具
  const addResult = await client.callTool("add", { a: 123, b: 456 });
  assert.equal(addResult.text, "579");

  const echoResult = await client.callTool("echo", { text: "hello mcp" });
  assert.equal(echoResult.text, "hello mcp");

  // 未知工具返回错误（不抛异常，MCP 规范）
  const badResult = await client.callTool("nope", {});
  assert.ok(badResult.error);

  client.close();
});

// ─── v3: MCP 工具注册 ─────────────────────────────────────────────

test("registerMcpTools：mcp__ 前缀注册 + registry 执行", async () => {
  const client = new McpClient();
  await client.connect();

  const registry = buildCoreTools(() => true);
  const names = await registerMcpTools(registry, client, "calc");
  assert.ok(names.includes("add"));

  // 注册后与其他工具平等：走 registry.execute（权限/校验/错误分层）
  const res = await registry.execute("mcp__calc__add", '{"a": 10, "b": 32}');
  assert.equal(res.result.text, "42");

  client.close();
});

// ─── v4: Hooks ─────────────────────────────────────────────────────

test("HookRegistry：pre 钩子可拦截，post 钩子可改写", async () => {
  const hooks = new HookRegistry();

  // pre：拦截特定工具
  hooks.add(HookEvent.PRE_TOOL_USE, async ({ name }) => {
    if (name === "forbidden") return { blocked: true, reason: "禁止调用" };
  });

  const pre1 = await hooks.firePreToolUse({ name: "forbidden", args: {} });
  assert.equal(pre1.blocked, true);
  assert.match(pre1.reason, /禁止/);

  const pre2 = await hooks.firePreToolUse({ name: "ok_tool", args: {} });
  assert.equal(pre2.blocked, false);

  // post：改写结果
  hooks.add(HookEvent.POST_TOOL_USE, async ({ result }) => {
    result.postProcessed = true;
  });
  const payload = { result: { text: "x" } };
  await hooks.firePostToolUse(payload);
  assert.equal(payload.result.postProcessed, true);
});

test("HookRegistry：add 返回移除函数", async () => {
  const hooks = new HookRegistry();
  let fired = 0;
  const remove = hooks.add(HookEvent.PRE_TOOL_USE, async () => {
    fired += 1;
  });
  await hooks.firePreToolUse({ name: "x" });
  assert.equal(fired, 1);

  remove();
  await hooks.firePreToolUse({ name: "x" });
  assert.equal(fired, 1); // 移除后不再触发
});

// ─── v5: Agent 集成 ────────────────────────────────────────────────

test("Agent：Hook 拦截危险命令（rm -rf）并回填错误给模型", async () => {
  let sawBlocked = false;
  const hooks = new HookRegistry();
  hooks.add(HookEvent.PRE_TOOL_USE, async ({ name, args }) => {
    if (name === "run_shell" && String(args.command || "").includes("rm -rf")) {
      return { blocked: true, reason: "审计钩子拦截 rm -rf" };
    }
  });

  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    const hasTool = messages.some((m) => m.role === "tool");
    if (!hasTool) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "run_shell", arguments: '{"command":"rm -rf /"}' },
          },
        ],
      };
    }
    // 第二轮：模型应看到 HOOK_BLOCKED 错误
    const lastTool = JSON.parse(messages.filter((m) => m.role === "tool").at(-1).content);
    sawBlocked = lastTool.error?.code === "HOOK_BLOCKED";
    return { role: "assistant", content: "已停止", tool_calls: null };
  };

  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);
  const skills = new SkillRegistry();
  const agent = new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "sys",
    skills,
    hooks,
    verbose: false,
  });

  const answer = await agent.run("执行 rm -rf /");
  await wait(60);

  assert.ok(sawBlocked); // 模型收到了 HOOK_BLOCKED
  assert.ok(answer.includes("已停止"));
});

test("Agent：MCP 工具 + 记忆 + 技能共存（完整能力面）", async () => {
  const client = new McpClient();
  await client.connect();

  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);
  await registerMcpTools(registry, client, "calc");

  const skills = new SkillRegistry();
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    const hasTool = messages.some((m) => m.role === "tool");
    if (!hasTool) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "mcp__calc__add", arguments: '{"a": 1, "b": 2}' },
          },
        ],
      };
    }
    return { role: "assistant", content: "计算完成", tool_calls: null };
  };

  const agent = new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "sys",
    skills,
    verbose: false,
  });
  const answer = await agent.run("用计算器算 1+2");
  await wait(60);

  assert.ok(answer.includes("计算完成"));
  client.close();
});

// ─── 回归：Loop 检测不产生孤儿 tool_calls（本章修复）─────────────

test("Agent：Loop 检测触发时，同一响应里剩余 tool_calls 仍逐条回填", async () => {
  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);

  // 同签名重复调用：第 2 轮的第 1 条就是第 3 次（触发 LOOP_THRESHOLD），
  // 同一条响应里还有第 2 条 —— 若直接 break，它就没有配对的 tool 消息
  const dupe = (id) => ({
    id,
    type: "function",
    function: { name: "list_files", arguments: '{"dir_path":"."}' },
  });
  let turn = 0;
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    turn += 1;
    if (turn <= 2) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [dupe(`c${turn}a`), dupe(`c${turn}b`)],
      };
    }
    return { role: "assistant", content: "已放弃重复调用", tool_calls: null };
  };

  const agent = new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "sys",
    skills: new SkillRegistry(),
    verbose: false,
  });
  const answer = await agent.run("列目录");
  await wait(60);

  assert.ok(answer.includes("已放弃重复调用"));
  const built = agent.cm.build();
  assert.ok(built.some((m) => String(m.content).includes("LOOP_DETECTED")));
  assertAllToolCallsPaired(built);
});

test("子 Agent：Loop 检测触发时同样逐条回填，不留孤儿 tool_calls", async () => {
  const registry = buildCoreTools(() => true);
  const dupe = (id) => ({
    id,
    type: "function",
    function: { name: "list_files", arguments: '{"dir_path":"."}' },
  });
  let turn = 0;
  const fakeLlm = async () => {
    turn += 1;
    if (turn <= 2) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [dupe(`s${turn}a`), dupe(`s${turn}b`)],
      };
    }
    return { role: "assistant", content: "已停止重复调用", tool_calls: null };
  };

  const sub = new SubAgent({ llm: fakeLlm, registry, verbose: false });
  const answer = await sub.run("列目录");

  assert.ok(answer.includes("已停止重复调用"));
  const built = sub.cm.build();
  assert.ok(built.some((m) => String(m.content).includes("LOOP_DETECTED")));
  assertAllToolCallsPaired(built);
});
