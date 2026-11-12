/**
 * lesson08 · 自测（node:test，零依赖）
 * 覆盖：Hooks 注册/触发/卸载 + audit-log 插件的拦截/脱敏/留痕/统计 + Agent 集成
 * 跑法：node --test test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";

import { MEMORY_ROOT } from "./memory_store.js";
import { HookRegistry, HookEvent } from "./hooks/hook_registry.js";
import { createAuditLogPlugin } from "./plugins/audit-log/plugin.js";
import { Agent } from "./agent.js";
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

// ─── Hooks 基础（来自 lesson08 拆分）──────────────────────────────

test("HookRegistry：pre 拦截 + post 改写 + 卸载", async () => {
  const hooks = new HookRegistry();
  const remove = hooks.add(HookEvent.PRE_TOOL_USE, async ({ name }) => {
    if (name === "forbidden") return { blocked: true, reason: "禁止" };
  });
  assert.equal((await hooks.firePreToolUse({ name: "forbidden" })).blocked, true);
  assert.equal((await hooks.firePreToolUse({ name: "ok" })).blocked, false);

  remove();
  assert.equal((await hooks.firePreToolUse({ name: "forbidden" })).blocked, false);
});

// ─── audit-log 插件核心能力 ───────────────────────────────────────

test("插件：危险命令被拦截（可配置规则）", async () => {
  const hooks = new HookRegistry();
  const audit = createAuditLogPlugin({
    logFile: "/tmp/audit-test-block.log",
    dangerRules: [
      { tool: "run_shell", field: "command", pattern: /\brm\s+-rf\b/, reason: "拦截 rm -rf" },
    ],
  });
  audit.install(hooks);

  const pre = await hooks.firePreToolUse({
    name: "run_shell",
    args: { command: "rm -rf /" },
  });
  assert.equal(pre.blocked, true);
  assert.match(pre.reason, /拦截/);

  // 放行正常命令
  const ok = await hooks.firePreToolUse({
    name: "run_shell",
    args: { command: "ls -la" },
  });
  assert.equal(ok.blocked, false);
});

test("插件：敏感参数脱敏（token/password 打码）", async () => {
  const hooks = new HookRegistry();
  const audit = createAuditLogPlugin({ logFile: "/tmp/audit-test-mask.log" });
  audit.install(hooks);

  await hooks.firePreToolUse({
    name: "fetch_url",
    args: { url: "https://api.example.com", api_key: "sk-secret123" },
  });

  const records = audit.query({ tool: "fetch_url" });
  assert.ok(records.length > 0);
  // 审计记录里的 api_key 已打码
  assert.equal(records[0].args.api_key, "***");
  assert.ok(!JSON.stringify(records).includes("sk-secret123"));
});

test("插件：调用留痕 + 结果状态（query）", async () => {
  const hooks = new HookRegistry();
  const audit = createAuditLogPlugin({ logFile: "/tmp/audit-test-query.log" });
  audit.install(hooks);

  await hooks.firePreToolUse({ name: "search_files", args: { pattern: "TODO" } });
  await hooks.firePostToolUse({
    name: "search_files",
    result: { matches: [{ file: "a.js", line: 1 }] },
  });
  await hooks.firePreToolUse({ name: "search_files", args: { pattern: "XXX" } });
  await hooks.firePostToolUse({
    name: "search_files",
    result: { error: { code: "NOT_FOUND", message: "无匹配" } },
  });

  // 记录完整：call + result(ok) + call + result(error)
  const all = audit.query({ limit: 10, tool: "search_files" });
  assert.equal(all.length, 4);

  // 按工具过滤
  const none = audit.query({ tool: "run_shell" });
  assert.equal(none.length, 0);
});

test("插件：summary 使用统计（调用/错误/拦截）", async () => {
  const hooks = new HookRegistry();
  const audit = createAuditLogPlugin({
    logFile: "/tmp/audit-test-summary.log",
    dangerRules: [
      { tool: "run_shell", field: "command", pattern: /\brm\s+-rf\b/, reason: "拦截" },
    ],
  });
  audit.install(hooks);

  await hooks.firePreToolUse({ name: "run_shell", args: { command: "ls" } });
  await hooks.firePostToolUse({ name: "run_shell", result: { stdout: "x" } });
  await hooks.firePreToolUse({ name: "run_shell", args: { command: "ls" } });
  await hooks.firePostToolUse({ name: "run_shell", result: { error: { code: "X" } } });
  await hooks.firePreToolUse({ name: "run_shell", args: { command: "rm -rf /" } });

  const s = audit.summary();
  assert.equal(s.run_shell.calls, 2);
  assert.equal(s.run_shell.errors, 1);
  assert.equal(s.run_shell.blocked, 1);
});

test("插件：install 返回卸载函数（可插拔）", async () => {
  const hooks = new HookRegistry();
  const audit = createAuditLogPlugin({ logFile: "/tmp/audit-test-uninstall.log" });
  const uninstall = audit.install(hooks);

  await hooks.firePreToolUse({ name: "read_file", args: { file_path: "a" } });
  assert.equal(audit.records.length, 1);

  uninstall(); // 卸载后不再留痕
  await hooks.firePreToolUse({ name: "read_file", args: { file_path: "b" } });
  assert.equal(audit.records.length, 1);
});

// ─── Agent 集成 ───────────────────────────────────────────────────

test("Agent + audit-log 插件：端到端拦截与留痕", async () => {
  const hooks = new HookRegistry();
  const audit = loadAuditPluginForTest();

  // 安装插件
  audit.install(hooks);

  let sawBlocked = false;
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

  assert.ok(sawBlocked); // 模型收到 HOOK_BLOCKED
  assert.ok(answer.includes("已停止"));
  // 审计记录里有 blocked 事件
  assert.ok(audit.query().some((r) => r.event === "blocked"));
});

// ─── 回归：Loop 检测触发时的消息配对（多 tool_calls 才撞上）──────────

/** 逐条核对 assistant(tool_calls) 与 role:"tool" 的配对：多一条孤儿、少一条回填都算失败 */
function assertToolCallPairs(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;
    const expected = new Set(msg.tool_calls.map((tc) => tc.id));
    const answered = new Set();
    for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) {
      assert.ok(expected.has(messages[j].tool_call_id), `孤儿 tool 消息: ${messages[j].tool_call_id}`);
      answered.add(messages[j].tool_call_id);
    }
    for (const id of expected) assert.ok(answered.has(id), `tool_call 没有回填: ${id}`);
  }
}

test("Loop 检测触发后，同一响应的剩余 tool_calls 也逐条回填", async () => {
  const registry = buildCoreTools(() => true);
  let executions = 0;
  const origExecute = registry.execute;
  registry.execute = async (name, args) => {
    executions += 1;
    return origExecute(name, args);
  };

  let seq = 0;
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" }; // 压缩摘要调用
    const toolMsgs = messages.filter((m) => m.role === "tool");
    if (toolMsgs.some((m) => String(m.content).includes("LOOP_DETECTED"))) {
      return { role: "assistant", content: "已停止调用", tool_calls: null };
    }
    // 每轮都发 2 个 tool_calls：第 3 轮时第一个撞上 LOOP_THRESHOLD，第二个排在它后面
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `a${seq}`, type: "function", function: { name: "list_files", arguments: '{"dir_path":"."}' } },
        { id: `b${seq++}`, type: "function", function: { name: "list_files", arguments: '{"dir_path":"./hooks"}' } },
      ],
    };
  };

  const agent = new Agent({
    llm: fakeLlm,
    memory: new MemoryManager(),
    registry,
    systemPrompt: "sys",
    skills: new SkillRegistry(),
    hooks: new HookRegistry(),
  });

  const answer = await agent.run("列目录");
  await wait(60);

  assertToolCallPairs(agent.cm.recent); // 没有孤儿 tool 消息、也没有漏回填
  const loopBackfills = agent.cm.recent.filter(
    (m) => m.role === "tool" && String(m.content).includes("LOOP_DETECTED"),
  );
  assert.equal(loopBackfills.length, 2); // 被判死循环的那个 + 同响应里排在它后面的那个
  assert.equal(executions, 4); // 前两轮各执行 2 次，判死循环那一轮一条都不执行
  assert.ok(answer.includes("已停止调用"));
});

// ─── 回归：PostToolUse 改写结果对模型可见 ──────────────────────────

test("PostToolUse 改写的结果被回填给模型（改写生效）", async () => {
  const hooks = new HookRegistry();
  hooks.add(HookEvent.POST_TOOL_USE, async (payload) => {
    payload.result = { replaced: true }; // 钩子用替换的方式改写结果
  });

  let sawReplaced = false;
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    const toolMsgs = messages.filter((m) => m.role === "tool");
    if (toolMsgs.length === 0) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "list_files", arguments: '{"dir_path":"."}' } },
        ],
      };
    }
    sawReplaced = String(toolMsgs.at(-1).content).includes("replaced");
    return { role: "assistant", content: sawReplaced ? "改写生效" : "未改写", tool_calls: null };
  };

  const agent = new Agent({
    llm: fakeLlm,
    memory: new MemoryManager(),
    registry: buildCoreTools(() => true),
    systemPrompt: "sys",
    skills: new SkillRegistry(),
    hooks,
  });

  const answer = await agent.run("列目录");
  await wait(60);

  assert.ok(sawReplaced); // 模型拿到的是钩子改写后的结果
  assert.ok(answer.includes("改写生效"));
});

/** 测试用插件加载（默认危险规则） */
function loadAuditPluginForTest() {
  return createAuditLogPlugin({
    logFile: "/tmp/audit-test-agent.log",
    dangerRules: [
      { tool: "run_shell", field: "command", pattern: /\brm\s+-rf\b/, reason: "拦截 rm -rf" },
    ],
  });
}

// ─── 回归：Loop 判定不得留下孤儿 tool 消息（子 Agent）────────────────

test("子 Agent：Loop 判定后同轮剩余 tool_calls 也逐条回填", async () => {
  const { SubAgent } = await import("./subagent.js"); // 动态引入，避免移动 test.js 里已被文档引用的行号
  // 每轮都返回两个同签名 tool_calls：第 2 轮第 1 条就撞上 LOOP_THRESHOLD
  let round = 0;
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "摘要" }; // 压缩摘要调用
    round += 1;
    const call = (id) => ({
      id,
      type: "function",
      function: { name: "list_files", arguments: '{"dir_path":"."}' },
    });
    return {
      role: "assistant",
      content: null,
      tool_calls: [call(`s${round}a`), call(`s${round}b`)],
    };
  };

  const sub = new SubAgent({
    llm: fakeLlm,
    registry: buildCoreTools(() => true),
    depth: 0,
    maxDepth: 2,
    verbose: false,
  });
  await sub.run("循环测试");

  assertToolCallPairs(sub.cm.recent); // 没有孤儿 tool 消息、也没有漏回填
  const called = [];
  for (const m of sub.cm.recent) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) called.push(tc.id);
    }
  }
  const answered = sub.cm.recent.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.ok(called.length >= 4, `子 Agent 应转多轮（实际 ${called.length} 个 tool_call）`);
  // 每个 tool_call 都必须有且只有一条 tool 消息应答——少一条，下一轮请求被服务端 400
  assert.deepEqual([...answered].sort(), [...called].sort());
});
