/**
 * lesson06 · 自测（node:test，零依赖）
 * 覆盖：子 Agent / 委派工具 / 深度门控 / 上下文选择 / 并行 / 完整集成
 * 跑法：node --test test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { MEMORY_ROOT } from "./memory_store.js";
import { SubAgent, DEFAULT_SUBAGENT_PROMPT } from "./subagent.js";
import { createDelegateTool } from "./agent_tool.js";
import { canDelegate, shouldExposeDelegateTool } from "./depth_guard.js";
import { CONTEXT_MODE, buildInheritedContext } from "./context_select.js";
import { delegateParallel, mergeResults } from "./parallel.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { buildCoreTools } from "./core_tools.js";
import { saveMemory } from "./memory_entries.js";

/** 测试前后清空记忆库 */
before(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});
after(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});

function wait(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

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

// ─── v1: 子 Agent ──────────────────────────────────────────────────

test("SubAgent 独立运行：工具调用 → 返回结果", async () => {
  const registry = buildCoreTools(() => true);
  const fakeLlm = async (messages) => {
    const hasTool = messages.some((m) => m.role === "tool");
    if (!hasTool) {
      return toolCallMsg("search_files", { pattern: "TODO:", dir: "demo" });
    }
    return { role: "assistant", content: "找到 2 个 TODO", tool_calls: null };
  };

  const sub = new SubAgent({ llm: fakeLlm, registry, depth: 0, maxDepth: 2 });
  const result = await sub.run("搜索 demo 目录的 TODO");
  assert.ok(result.includes("TODO"));
});

test("上下文隔离：子 Agent 的对话不进入父的上下文", async () => {
  const registry = buildCoreTools(() => true);
  const subCalls = [];
  const fakeLlm = async (messages) => {
    subCalls.push(messages);
    return { role: "assistant", content: "子任务完成", tool_calls: null };
  };

  const sub = new SubAgent({ llm: fakeLlm, registry });
  await sub.run("子任务A");

  // 子 Agent 只看到自己的 system + task（无父历史）
  const subMessages = subCalls[0];
  assert.equal(subMessages[0].content, DEFAULT_SUBAGENT_PROMPT); // 用的是默认子 Agent 提示
  assert.equal(subMessages.length, 2); // system + task
});

test("隔离强化：independent 模式父历史不泄漏给子 Agent", async () => {
  const registry = buildCoreTools(() => true);
  let subReceived = null;
  const fakeLlm = async (messages) => {
    if (messages[0].content.includes("子 Agent")) {
      subReceived = messages;
      return { role: "assistant", content: "子完成", tool_calls: null };
    }
    return { role: "assistant", content: "父", tool_calls: null };
  };

  // 父 cm 已有历史（含机密），但 getParentContext 是 independent 模式 → 不注入
  const parentRecent = [
    { role: "user", content: "父的机密是 abc123" },
    { role: "assistant", content: "好的" },
  ];
  const delegate = createDelegateTool({
    llm: fakeLlm,
    registry,
    depth: 0,
    maxDepth: 2,
    getParentContext: () => parentRecent,
  });
  await delegate.fn({ task: "子任务", mode: "independent" });

  const allContent = subReceived.map((m) => JSON.stringify(m)).join("\n");
  assert.ok(!allContent.includes("abc123")); // 机密未泄漏
});

// ─── v3: 深度门控 ─────────────────────────────────────────────────

test("canDelegate / shouldExposeDelegateTool 边界", () => {
  assert.equal(canDelegate(0, 2), true);   // 父(0) 可委派
  assert.equal(canDelegate(1, 2), true);   // 子(1) 可委派
  assert.equal(canDelegate(2, 2), false);  // 孙(2) 不可委派

  assert.equal(shouldExposeDelegateTool(0, 2), true);  // 父暴露
  assert.equal(shouldExposeDelegateTool(1, 2), false); // 子不暴露（防孙层）
  // 注意这两个门限差一层：depth=1 时 canDelegate 仍为 true，但子 Agent 实际拿不到
  // delegate_task（物理隔离更严）→ 运行时兜底在子 Agent 路径上不可达。见 README 缺口表。
});

test("深度边界：子 Agent 的工具列表不含 delegate_task", () => {
  const registry = buildCoreTools(() => true);
  const sub = new SubAgent({ llm: async () => ({}), registry, depth: 1, maxDepth: 2 });
  const schemas = sub._schemas();
  assert.ok(!schemas.some((s) => s.function.name === "delegate_task"));
});

test("深度边界：越界委派返回错误而非崩溃", async () => {
  const registry = buildCoreTools(() => true);
  const tool = createDelegateTool({
    llm: async () => ({}),
    registry,
    depth: 2, // 已到边界
    maxDepth: 2,
  });
  const result = await tool.fn({ task: "任何任务" });
  assert.ok(result.error.includes("深度限制"));
});

// ─── v2: delegate_task 工具 ───────────────────────────────────────

test("delegate_task 工具执行：父委派 → 子完成 → 返回结果", async () => {
  const registry = buildCoreTools(() => true);
  const fakeLlm = async (messages, tools) => {
    // 子 Agent：第一轮搜索，第二轮收尾
    if (messages[0].content.includes("子 Agent")) {
      const hasTool = messages.some((m) => m.role === "tool");
      if (!hasTool) {
        return toolCallMsg("search_files", { pattern: "FIXME:", dir: "demo" });
      }
      return { role: "assistant", content: "FIXME 共 2 处", tool_calls: null };
    }
    return { role: "assistant", content: "父收尾", tool_calls: null };
  };

  const delegate = createDelegateTool({
    llm: fakeLlm,
    registry,
    depth: 0,
    maxDepth: 2,
  });
  const result = await delegate.fn({
    task: "搜索 demo 的 FIXME",
    tools: ["search_files"],
  });

  assert.equal(result.fromSubagent, true);
  assert.ok(result.result.includes("FIXME 共 2 处"));
});

// ─── v4: 上下文选择 ───────────────────────────────────────────────

test("buildInheritedContext：fork 注入最近窗口，independent 返回 null", () => {
  const recent = [
    { role: "user", content: "问题1" },
    { role: "assistant", content: "回答1" },
    { role: "user", content: "问题2" },
  ];
  const forked = buildInheritedContext(CONTEXT_MODE.FORK, recent, 2);
  assert.equal(forked.length, 2);
  assert.equal(forked[0].content, "回答1");

  assert.equal(buildInheritedContext(CONTEXT_MODE.INDEPENDENT, recent, 2), null);
});

test("fork 模式集成：delegate 工具 mode=fork 时子 Agent 收到父上下文（v2.1 修复）", async () => {
  const registry = buildCoreTools(() => true);
  let subReceived = null;
  const fakeLlm = async (messages) => {
    if (messages[0].content.includes("子 Agent")) {
      subReceived = messages;
      return { role: "assistant", content: "子完成", tool_calls: null };
    }
    return { role: "assistant", content: "父", tool_calls: null };
  };

  const parentRecent = [
    { role: "user", content: "背景A" },
    { role: "user", content: "背景B（最近的）" },
  ];
  const delegate = createDelegateTool({
    llm: fakeLlm,
    registry,
    depth: 0,
    maxDepth: 2,
    getParentContext: () => parentRecent,
  });
  await delegate.fn({ task: "子任务", mode: "fork" });

  const allContent = subReceived.map((m) => JSON.stringify(m)).join("\n");
  assert.ok(allContent.includes("背景B")); // 继承了父近期上下文
});

test("subagentPrompt 可定制子 Agent 系统提示（v2.1 修复）", async () => {
  const registry = buildCoreTools(() => true);
  let subSystem = "";
  const fakeLlm = async (messages) => {
    subSystem = messages[0].content;
    return { role: "assistant", content: "子完成", tool_calls: null };
  };
  const delegate = createDelegateTool({
    llm: fakeLlm,
    registry,
    depth: 0,
    maxDepth: 2,
    subagentPrompt: "你是专门的代码审查员",
  });
  await delegate.fn({ task: "审查代码" });

  assert.ok(subSystem.includes("代码审查员"));
});

// ─── v5: 并行委派 ─────────────────────────────────────────────────

test("delegateParallel：结果顺序与任务一致 + 并发上限", async () => {
  const registry = buildCoreTools(() => true);
  let active = 0;
  let maxActive = 0;

  const fakeLlm = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(30); // 模拟推理耗时
    active -= 1;
    return { role: "assistant", content: "子结果", tool_calls: null };
  };

  const tasks = [
    { task: "任务1" },
    { task: "任务2" },
    { task: "任务3" },
    { task: "任务4" },
  ];
  const results = await delegateParallel({
    llm: fakeLlm,
    registry,
    tasks,
    maxConcurrent: 2,
    depth: 0,
    maxDepth: 2,
  });

  assert.equal(results.length, 4);
  assert.ok(maxActive <= 2, `并发超过上限: ${maxActive}`); // 并发被限制
});

test("delegateParallel 深度越界直接拒绝（v2.1 修复）", async () => {
  const registry = buildCoreTools(() => true);
  let llmCalls = 0;
  const fakeLlm = async () => {
    llmCalls += 1;
    return { role: "assistant", content: "x", tool_calls: null };
  };
  const results = await delegateParallel({
    llm: fakeLlm,
    registry,
    tasks: [{ task: "A" }, { task: "B" }],
    depth: 2, // 已到边界
    maxDepth: 2,
  });

  assert.equal(llmCalls, 0); // 未创建子 Agent
  assert.ok(results.every((r) => r.includes("委派被拒绝")));
});

test("mergeResults 汇聚格式", () => {
  const merged = mergeResults(
    [{ task: "A" }, { task: "B" }],
    ["结果A", "结果B"],
  );
  assert.ok(merged.includes("子任务 1"));
  assert.ok(merged.includes("结果B"));
});

// ─── v6: 完整集成 ─────────────────────────────────────────────────

test("主 Agent 通过 LLM 自动委派子任务", async () => {
  await saveMemory({
    name: "目录偏好",
    description: "用户常在 demo 目录工作",
    type: "user",
    body: "用户主要在 demo 目录工作",
  });

  let delegated = false;
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" }; // extract
    if (messages[0].content.includes("子 Agent")) {
      // 子 Agent：直接收尾
      return { role: "assistant", content: "子结果：demo 有 TODO", tool_calls: null };
    }
    // 父 Agent：第一轮委派，之后收尾
    const hasToolResult = messages.some((m) => m.role === "tool");
    if (!hasToolResult) {
      delegated = true;
      return toolCallMsg("delegate_task", { task: "搜索 demo 的 TODO" });
    }
    return { role: "assistant", content: "委派完成，详见子结果", tool_calls: null };
  };

  const registry = buildCoreTools(() => true);
  const memory = new MemoryManager();
  const agent = new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "你是主 Agent，复杂任务用 delegate_task 委派",
    maxDepth: 2,
    verbose: false,
  });

  const answer = await agent.run("分析 demo 目录的 TODO");
  await wait(60);

  assert.ok(delegated); // 父 Agent 委派了
  assert.ok(answer.includes("委派完成"));
});

// ─── 子 Agent 防失控（v2.1 补）────────────────────────────────────

test("子 Agent Loop 检测：死磕同一工具被注入 LOOP_DETECTED", async () => {
  const registry = buildCoreTools(() => true);
  let lastTool = null;
  const fakeLlm = async (messages) => {
    const toolMsgs = messages.filter((m) => m.role === "tool");
    if (toolMsgs.length > 0) {
      lastTool = JSON.parse(toolMsgs[toolMsgs.length - 1].content);
    }
    return toolCallMsg("get_weather", { city: "北京" }); // 永远调同一工具
  };

  const sub = new SubAgent({ llm: fakeLlm, registry, depth: 0, maxDepth: 2, verbose: false });
  await sub.run("测试死循环");

  assert.equal(lastTool.error.code, "LOOP_DETECTED");
});

// ─── 错误隔离（本课能力边界，含 1 个负向用例）──────────────────────

test("子 Agent 抛错经 registry 隔离：父拿到结构化错误，父循环不受影响", async () => {
  const registry = buildCoreTools(() => true);
  let parentToolMessage = null;
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" }; // extract 调用
    if (messages[0].content.includes("子 Agent")) {
      throw new Error("子 Agent 的 LLM 挂了"); // 子 Agent 侧故障
    }
    if (!messages.some((m) => m.role === "tool")) {
      return toolCallMsg("delegate_task", { task: "注定失败的任务" });
    }
    parentToolMessage = messages.find((m) => m.role === "tool");
    return { role: "assistant", content: "委派失败已兜底", tool_calls: null };
  };

  const agent = new Agent({
    llm: fakeLlm,
    memory: new MemoryManager(),
    registry,
    systemPrompt: "你是主 Agent",
    maxDepth: 2,
  });
  const answer = await agent.run("让子 Agent 干个活");
  await wait(60);

  // 子 Agent 的异常被 registry.execute 的 catch 转成结构化错误，回填给父
  assert.ok(parentToolMessage.content.includes("EXECUTION_FAILED"));
  assert.equal(answer, "委派失败已兜底"); // 父循环继续跑到收尾
});

test("缺口（负向）：delegateParallel 无单任务错误隔离，一个子 Agent 抛错拖垮整批", async () => {
  const registry = buildCoreTools(() => true);
  let calls = 0;
  const flakyLlm = async () => {
    calls += 1;
    if (calls === 2) throw new Error("LLM 调用超时"); // 第 2 个子 Agent 故障
    return { role: "assistant", content: "子结果", tool_calls: null };
  };

  // 本课刻意没做 per-task 隔离：Promise.all 一挂全挂（第 13 课补兜底）
  await assert.rejects(
    delegateParallel({
      llm: flakyLlm,
      registry,
      tasks: [{ task: "任务A" }, { task: "任务B" }],
      maxConcurrent: 1, // 串行，确定是第 2 个任务抛错
      depth: 0,
      maxDepth: 2,
    }),
    /LLM 调用超时/,
  );
});

// ─── 回归：Loop 判定不得留下孤儿 tool 消息（同族修复）──────────────

/** 逐条核对 assistant(tool_calls) 与 role:"tool" 的配对：孤儿、漏回填都算失败 */
function assertToolCallPairs(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;
    const expected = new Set(msg.tool_calls.map((tc) => tc.id));
    const answered = new Set();
    for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) {
      assert.ok(
        expected.has(messages[j].tool_call_id),
        `孤儿 tool 消息: ${messages[j].tool_call_id}`,
      );
      answered.add(messages[j].tool_call_id);
    }
    for (const id of expected) assert.ok(answered.has(id), `tool_call 没有回填: ${id}`);
  }
}

test("Agent：Loop 判定后同轮剩余 tool_calls 仍逐条回填", async () => {
  // 每轮都返回两个同签名 tool_calls：第 2 轮第 1 条就撞上 LOOP_THRESHOLD
  let round = 0;
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" }; // 摘要/提取调用
    round += 1;
    const call = (id) => ({
      id,
      type: "function",
      function: { name: "list_files", arguments: '{"dir_path":"."}' },
    });
    return {
      role: "assistant",
      content: null,
      tool_calls: [call(`r${round}a`), call(`r${round}b`)],
    };
  };

  const agent = new Agent({
    llm: fakeLlm,
    memory: new MemoryManager(),
    registry: buildCoreTools(() => true),
    systemPrompt: "sys",
    maxDepth: 2,
    verbose: false,
  });
  await agent.run("循环测试");
  await wait(60);

  assertToolCallPairs(agent.cm.recent); // 没有孤儿 tool 消息、也没有漏回填
  const loopBackfills = agent.cm.recent.filter(
    (m) => m.role === "tool" && String(m.content).includes("LOOP_DETECTED"),
  );
  assert.ok(loopBackfills.length >= 2, `Loop 判定应逐条回填，实际 ${loopBackfills.length} 条`);
});

test("子 Agent：Loop 判定后同轮剩余 tool_calls 也逐条回填", async () => {
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
  assert.ok(
    sub.cm.recent.filter(
      (m) => m.role === "tool" && String(m.content).includes("LOOP_DETECTED"),
    ).length >= 2,
    "子 Agent 应逐条回填 LOOP_DETECTED",
  );
});
