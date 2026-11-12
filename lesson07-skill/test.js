/**
 * lesson07 · 自测（node:test，零依赖）
 * 覆盖：SKILL.md 解析 / 注册匹配 / skill 工具 / 自动触发 / Agent 集成
 * 跑法：node --test test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { MEMORY_ROOT } from "./memory_store.js";
import { parseSkill, serializeSkill, loadAllSkills } from "./skill_store.js";
import { SkillRegistry } from "./skill_registry.js";
import { createSkillTool, buildAvailableSkillsPrompt } from "./skill_tool.js";
import { matchSkillsForInput, buildSkillInjection } from "./skill_trigger.js";
import { Agent } from "./agent.js";
import { MemoryManager } from "./memory_manager.js";
import { buildCoreTools } from "./core_tools.js";

/** 测试前后清空记忆库（技能目录是课程自带的，不动） */
before(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});
after(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});

function wait(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── v1: SKILL.md 解析 ─────────────────────────────────────────────

test("parseSkill 解析 frontmatter + body", () => {
  const content = [
    "---",
    "name: code-review",
    "description: 审查代码变更",
    "when_to_use: 代码审查、review",
    "tools: [run_shell, read_file]",
    "---",
    "",
    "## 步骤",
    "1. 先看 diff",
  ].join("\n");

  const skill = parseSkill(content);
  assert.equal(skill.name, "code-review");
  assert.equal(skill.description, "审查代码变更");
  assert.deepEqual(skill.tools, ["run_shell", "read_file"]);
  assert.ok(skill.body.includes("先看 diff"));
});

test("serialize → parse 往返", () => {
  const skill = {
    name: "x",
    description: "d",
    when_to_use: "w",
    tools: ["a", "b"],
    body: "body",
  };
  const parsed = parseSkill(serializeSkill(skill));
  assert.deepEqual(parsed, skill);
});

test("loadAllSkills 加载 3 个示例技能", async () => {
  const all = await loadAllSkills();
  const names = all.map((s) => s.name).sort();
  assert.deepEqual(names, ["bug-hunt", "code-review", "report"]);
});

test("parseSkill 对非技能内容返回 null（坏技能不炸整库）", () => {
  assert.equal(parseSkill("## 没有 frontmatter 的普通文档"), null);
  assert.equal(parseSkill("---\ndescription: 缺 name\n---\nbody"), null);
});

// ─── v2: 注册与匹配 ────────────────────────────────────────────────

test("SkillRegistry load/list/get/match", async () => {
  const registry = new SkillRegistry();
  await registry.load();

  assert.equal(registry.list().length, 3);
  assert.ok(registry.get("code-review"));

  // 关键词匹配 when_to_use
  const matched = registry.match("帮我 review 一下代码");
  assert.ok(matched.length > 0);
  assert.equal(matched[0].name, "code-review"); // 最高分
});

// ─── v3: skill 工具 ────────────────────────────────────────────────

test("skill 工具：加载存在的技能", async () => {
  const registry = new SkillRegistry();
  await registry.load();
  const tool = createSkillTool(registry);

  const result = await tool.fn({ name: "bug-hunt" });
  assert.equal(result.skill.name, "bug-hunt");
  assert.ok(result.skill.content.includes("步骤"));
});

test("skill 工具：不存在的技能返回错误 + 可用清单", async () => {
  const registry = new SkillRegistry();
  await registry.load();
  const tool = createSkillTool(registry);

  const result = await tool.fn({ name: "不存在" });
  assert.ok(result.error.includes("不存在"));
  assert.ok(result.available.includes("code-review"));
});

test("buildAvailableSkillsPrompt 生成清单", async () => {
  const registry = new SkillRegistry();
  await registry.load();
  const prompt = buildAvailableSkillsPrompt(registry);
  assert.ok(prompt.includes("可用技能"));
  assert.ok(prompt.includes("code-review"));
});

test("skill 工具只回填知识，不改工具集（tools 字段暂无执行效力）", async () => {
  const registry = new SkillRegistry();
  await registry.load();
  const tool = createSkillTool(registry);

  const result = await tool.fn({ name: "code-review" });
  assert.deepEqual(Object.keys(result.skill), ["name", "description", "content"]);
  assert.ok(registry.get("code-review").tools.includes("run_shell")); // 白名单只声明在文件里
});

// ─── v4: 自动触发 ──────────────────────────────────────────────────

test("matchSkillsForInput 命中 when_to_use", async () => {
  const registry = new SkillRegistry();
  await registry.load();

  const hit = matchSkillsForInput("帮我排查一下这个报错", registry);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].name, "bug-hunt");
});

test("无匹配时不注入", async () => {
  const registry = new SkillRegistry();
  await registry.load();

  const hit = matchSkillsForInput("今天天气怎么样", registry);
  assert.equal(hit.length, 0);
});

test("多技能命中时只自动注入 Top 1（最小注入原则）", async () => {
  const registry = new SkillRegistry();
  await registry.load();

  // 这句话同时命中 bug-hunt 和 report
  const all = registry.match("写份报告，排查一下报错");
  assert.ok(all.length >= 2);

  const injected = matchSkillsForInput("写份报告，排查一下报错", registry);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].name, "bug-hunt"); // 分数更高的那个
});

test("buildSkillInjection 格式化注入文本", () => {
  const text = buildSkillInjection([
    { name: "report", description: "生成报告", body: "先写摘要" },
  ]);
  assert.ok(text.includes("已加载技能"));
  assert.ok(text.includes("report"));
  assert.ok(text.includes("先写摘要"));
  assert.equal(buildSkillInjection([]), "");
});

// ─── v5: Agent 集成 ────────────────────────────────────────────────

test("Agent 自动加载匹配技能进 system", async () => {
  let injectedSystem = "";
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" }; // extract
    injectedSystem = messages[0].content;
    return { role: "assistant", content: "好的", tool_calls: null };
  };

  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);
  const skills = new SkillRegistry();
  const agent = new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "基础提示",
    skills,
    verbose: false,
  });
  await agent.run("帮我 review 一下 demo 目录的代码");

  assert.ok(injectedSystem.includes("基础提示"));
  assert.ok(injectedSystem.includes("已加载技能"));   // 自动触发
  assert.ok(injectedSystem.includes("code-review")); // 命中的技能
  assert.ok(injectedSystem.includes("可用技能"));     // 技能清单（可显式调用）
});

test("Agent 可主动调用 skill 工具", async () => {
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    const hasTool = messages.some((m) => m.role === "tool");
    if (!hasTool) {
      // 第一轮主动加载技能
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "skill", arguments: '{"name":"report"}' },
          },
        ],
      };
    }
    return { role: "assistant", content: "已按 report 技能执行", tool_calls: null };
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
    verbose: false,
  });
  const answer = await agent.run("写份报告");
  await wait(60);

  assert.ok(answer.includes("report 技能")); // 技能内容已回填并被执行
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
    skills: new SkillRegistry(),
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
  const { SubAgent } = await import("./subagent.js"); // 动态引入，避免移动 test.js 里已被文档引用的行号
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
