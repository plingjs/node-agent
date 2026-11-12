/**
 * lesson10 · 自测（node:test，零依赖）
 * 覆盖：会话序列化（三层状态 / 配对截断）+ 多会话管理（CRUD / 原子写 / 标题）
 *      + Loop 检测的配对回归（同一条响应多个 tool_calls）
 * 跑法：node --test test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, rename, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { MEMORY_ROOT, ensureStore } from "./memory_store.js";
import { TieredContextManager } from "./context_manager_v2.js";
import {
  serializeContext,
  restoreContext,
  truncateToCompletePairs,
} from "./session_state.js";
import { SessionManager, autoTitle } from "./session_manager.js";
import { Agent } from "./agent.js";
import { SubAgent } from "./subagent.js";
import { buildCoreTools } from "./core_tools.js";

/** 测试会话目录全部落系统临时目录，不碰本章的 sessions/ */
const tmpSessionDir = (name) => path.join(tmpdir(), name);
const SESSION_DIRS = [
  "lesson10-test-sessions",
  "lesson10-test-multi",
  "lesson10-test-atomic",
  "lesson10-test-broken",
];

/**
 * 记忆库隔离：memories/ 里可能有读者跑 main.js 后攒下的真实记忆，
 * 直接 rm(MEMORY_ROOT) 会把读者数据一起抹掉。做法与 lesson05 一致：
 * 先把整个目录 rename 到 .seed-backup，测试跑在空库上，结束再原样放回。
 */
const SEED_BACKUP = `${MEMORY_ROOT}.seed-backup`;

before(async () => {
  await rm(SEED_BACKUP, { recursive: true, force: true });
  try {
    await rename(MEMORY_ROOT, SEED_BACKUP); // 读者数据先挪走
  } catch {
    // 记忆库还不存在（首次运行）→ 无需暂存
  }
  await ensureStore();
  await Promise.all(SESSION_DIRS.map((d) => rm(tmpSessionDir(d), { recursive: true, force: true })));
});

after(async () => {
  await Promise.all(SESSION_DIRS.map((d) => rm(tmpSessionDir(d), { recursive: true, force: true })));
  await rm(MEMORY_ROOT, { recursive: true, force: true }); // 清掉测试期写的库
  try {
    await rename(SEED_BACKUP, MEMORY_ROOT); // 读者数据原样放回
  } catch {
    // 首次运行没有记忆库可还原，也不留空目录
  }
});

// ─── v1: 会话序列化 ────────────────────────────────────────────────

test("serialize/restore 往返：三层状态完整", () => {
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 4 });
  cm.setSystem([{ role: "system", content: "sys" }]);
  cm.summary = "旧摘要";
  cm.recent = [
    { role: "user", content: "问题1" },
    { role: "assistant", content: "回答1" },
  ];

  const state = serializeContext(cm);

  const cm2 = new TieredContextManager({ maxTokens: 100000, keepRecent: 4 });
  restoreContext(cm2, state);
  assert.equal(cm2.system[0].content, "sys");
  assert.equal(cm2.summary, "旧摘要");
  assert.equal(cm2.recent.length, 2);
  assert.equal(cm2.recent[1].content, "回答1");
});

test("serialize 只存基础 system（注入内容不持久化）", () => {
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 4 });
  // 模拟：system 里含每轮注入的记忆/技能（第 5/7 课的注入机制）
  cm.setSystem([
    { role: "system", content: "基础提示【已加载技能：code-review】" },
  ]);

  // 注入部分属于"运行时动态"，序列化应只保留基础 system——
  // 恢复后第一轮 run 会重新注入（测试断言：基础提示保留即可）
  const state = serializeContext(cm);
  assert.ok(state.system[0].content.includes("基础提示"));
});

test("truncateToCompletePairs：孤立 tool 被截断，完整序列保留", () => {
  const messages = [
    { role: "user", content: "q" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c1", content: "结果" },
    { role: "user", content: "追问" },
    { role: "tool", tool_call_id: "c99", content: "孤立的tool" }, // 前面无 tool_calls
  ];
  const cut = truncateToCompletePairs(messages);
  assert.equal(cut.length, 4); // 完整序列保留
  assert.ok(!cut.some((m) => m.tool_call_id === "c99")); // 孤立 tool 被丢
  assert.equal(cut[3].content, "追问");
});

test("restore 防御：恢复时同样截断到完整配对", () => {
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 4 });
  restoreContext(cm, {
    system: [{ role: "system", content: "sys" }],
    recent: [{ role: "tool", tool_call_id: "x", content: "孤立" }],
  });
  assert.equal(cm.recent.length, 0); // 孤立的 tool 被截断
});

// ─── 回归：Loop 检测不产生孤儿 tool_calls（同一条响应多个 tool_calls）──

test("Loop 检测触发时，同一响应里剩余 tool_calls 仍逐条回填", async () => {
  const dupe = (id) => ({
    id,
    type: "function",
    function: { name: "probe", arguments: "{}" },
  });
  let turn = 0;
  const fakeLlm = async () => {
    turn += 1;
    // 前两轮各带 2 条同签名调用：第 3 次触发 LOOP_THRESHOLD，
    // 此时同一条响应里还有第 2 条 —— 若直接 break，它就没有配对的 tool 消息
    if (turn <= 2) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [dupe(`c${turn}a`), dupe(`c${turn}b`)],
      };
    }
    return { role: "assistant", content: "已放弃重复调用", tool_calls: null };
  };

  const registry = buildCoreTools(() => true);
  registry.register(
    {
      name: "probe",
      description: "无副作用的测试探针",
      params: { type: "object", properties: {}, required: [] },
      fn: async () => ({ ok: true }),
    },
    "read",
  );
  const memory = {
    recall: async () => [],
    formatRecall: () => "",
    scheduleExtract: () => {},
  };
  const agent = new Agent({ llm: fakeLlm, memory, registry, systemPrompt: "sys" });

  const answer = await agent.run("反复调同一个工具");
  assert.ok(answer.includes("已放弃重复调用"));

  const built = agent.cm.build();
  assert.ok(built.some((m) => String(m.content).includes("LOOP_DETECTED")));
  assert.ok(built.some((m) => String(m.content).includes("跳过执行")));

  // 每个 tool_call 都必须有一条 tool 消息配对（缺一条下一轮 API 400）
  for (let i = 0; i < built.length; i++) {
    if (built[i].role === "assistant" && built[i].tool_calls) {
      for (const tc of built[i].tool_calls) {
        const paired = built.slice(i + 1).some(
          (m) => m.role === "tool" && m.tool_call_id === tc.id,
        );
        assert.ok(paired, `tool_call ${tc.id} 缺少配对的 tool 消息`);
      }
    }
  }
});

test("子 Agent 同样处理：Loop 判定后剩余 tool_calls 逐条回填", async () => {
  const dupe = (id) => ({
    id,
    type: "function",
    function: { name: "probe", arguments: "{}" },
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
    return { role: "assistant", content: "子任务已放弃重复调用", tool_calls: null };
  };

  const registry = buildCoreTools(() => true);
  registry.register(
    {
      name: "probe",
      description: "无副作用的测试探针",
      params: { type: "object", properties: {}, required: [] },
      fn: async () => ({ ok: true }),
    },
    "read",
  );
  const sub = new SubAgent({ llm: fakeLlm, registry, depth: 1, maxDepth: 2 });

  const out = await sub.run("反复调同一个工具");
  assert.ok(out.includes("子任务已放弃重复调用"));

  const built = sub.cm.build();
  for (let i = 0; i < built.length; i++) {
    if (built[i].role === "assistant" && built[i].tool_calls) {
      for (const tc of built[i].tool_calls) {
        const paired = built.slice(i + 1).some(
          (m) => m.role === "tool" && m.tool_call_id === tc.id,
        );
        assert.ok(paired, `子 Agent 的 tool_call ${tc.id} 缺少配对的 tool 消息`);
      }
    }
  }
});

// ─── v2: 多会话管理 ────────────────────────────────────────────────

test("SessionManager：create/list/load/save/rename/delete", async () => {
  const dir = tmpSessionDir("lesson10-test-sessions");
  const sm = new SessionManager({ dir });
  await rm(dir, { recursive: true, force: true });

  const meta = await sm.create({ title: "测试会话", model: "m1" });
  assert.ok(meta.session_id);

  // save 完整状态
  await sm.save(meta.session_id, {
    ...meta,
    context: { recent: [{ role: "user", content: "hi" }] },
  });

  // load 往返
  const loaded = await sm.load(meta.session_id);
  assert.equal(loaded.context.recent[0].content, "hi");

  // list
  const all = await sm.list();
  assert.equal(all.length, 1);

  // rename
  await sm.rename(meta.session_id, "新标题");
  assert.equal((await sm.load(meta.session_id)).title, "新标题");

  // delete
  assert.equal(await sm.delete(meta.session_id), true);
  assert.equal(await sm.delete(meta.session_id), false);
});

test("SessionManager：多会话并行互不干扰", async () => {
  const dir = tmpSessionDir("lesson10-test-multi");
  const sm = new SessionManager({ dir });
  await rm(dir, { recursive: true, force: true });

  const s1 = await sm.create({ title: "会话A", model: "m" });
  const s2 = await sm.create({ title: "会话B", model: "m" });

  await sm.save(s1.session_id, { ...s1, context: { recent: [{ role: "user", content: "A 的内容" }] } });
  await sm.save(s2.session_id, { ...s2, context: { recent: [{ role: "user", content: "B 的内容" }] } });

  const a = await sm.load(s1.session_id);
  const b = await sm.load(s2.session_id);
  assert.equal(a.context.recent[0].content, "A 的内容");
  assert.equal(b.context.recent[0].content, "B 的内容");
  assert.notEqual(a, b); // 互不干扰
});

test("SessionManager：list 跳过损坏的会话文件", async () => {
  const dir = tmpSessionDir("lesson10-test-broken");
  const sm = new SessionManager({ dir });
  await rm(dir, { recursive: true, force: true });

  const good = await sm.create({ title: "好会话", model: "m" });
  await writeFile(path.join(dir, "broken.json"), "{ 这不是 JSON", "utf8");

  const all = await sm.list();
  assert.equal(all.length, 1); // 损坏文件被跳过，列表不崩
  assert.equal(all[0].session_id, good.session_id);
});

test("SessionManager：touch 只更新元数据，context 不动", async () => {
  const dir = tmpSessionDir("lesson10-test-sessions");
  const sm = new SessionManager({ dir });
  await rm(dir, { recursive: true, force: true });

  const meta = await sm.create({ title: "旧标题", model: "m1" });
  await sm.save(meta.session_id, {
    ...meta,
    context: { summary: "摘要", recent: [{ role: "user", content: "hi" }] },
  });

  const touched = await sm.touch(meta.session_id, { title: "新标题", message_count: 3 });
  assert.equal(touched.title, "新标题");
  assert.equal(touched.message_count, 3);
  assert.equal(touched.context.summary, "摘要"); // 上下文原样保留
  assert.ok(touched.updated_at >= meta.updated_at);
});

test("原子写：save 后无 .tmp 残留", async () => {
  const dir = tmpSessionDir("lesson10-test-atomic");
  const sm = new SessionManager({ dir });
  await rm(dir, { recursive: true, force: true });

  const meta = await sm.create({ title: "t", model: "m" });
  await sm.save(meta.session_id, { ...meta, context: {} });

  const files = await readdir(dir);
  assert.ok(!files.some((f) => f.endsWith(".tmp"))); // 原子写完成，临时文件已 rename
});

test("autoTitle 截取前 N 字", () => {
  assert.equal(autoTitle("  帮我看看这段代码有什么问题  ", 6), "帮我看看这段…");
  assert.equal(autoTitle("短标题"), "短标题");
  assert.equal(autoTitle(""), "新会话"); // 空输入兜底
});
