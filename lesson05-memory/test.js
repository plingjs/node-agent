/**
 * lesson05 · 自测（node:test，零依赖）
 * 覆盖：存储/CRUD/提取/召回/异步调度/Agent 集成/跨会话
 * 跑法：node --test test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, rename } from "node:fs/promises";

import {
  MEMORY_ROOT,
  parseMemory,
  serializeMemory,
  ensureStore,
  readAllMemories,
} from "./memory_store.js";
import { saveMemory, listMemories, deleteMemory } from "./memory_entries.js";
import { extractMemories, parseExtractOutput } from "./extract.js";
import { tokenize, recallByKeywords, rerankByLLM } from "./recall.js";
import { MemoryManager, EXTRACT_MIN_NEW_MESSAGES } from "./memory_manager.js";
import { Agent } from "./agent.js";
import { buildCoreTools } from "./core_tools.js";

/**
 * 测试跑在独立的空记忆库上，跑完把本章自带的演示记忆库原样放回。
 *
 * 不能直接 rm(MEMORY_ROOT)：memories/ 里放的是本章的演示数据
 * （user/用户颜色偏好.md 那几条颜色偏好，用来讲"冲突记忆"），
 * 直接删会把演示数据一起抹掉，读者跑一次测试就丢了示例。
 * 做法：整个目录先 rename 到 .seed-backup，测试结束再 rename 回来。
 */
const SEED_BACKUP = `${MEMORY_ROOT}.seed-backup`;

before(async () => {
  await rm(SEED_BACKUP, { recursive: true, force: true });
  try {
    await rename(MEMORY_ROOT, SEED_BACKUP); // 演示记忆库挪走
  } catch {
    // 记忆库还不存在（首次运行）→ 跳过暂存
  }
  await ensureStore();
});
after(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
  try {
    await rename(SEED_BACKUP, MEMORY_ROOT); // 演示记忆库放回
  } catch {
    await ensureStore();
  }
});

/** 等待后台任务完成 */
function wait(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── v1: 存储层 ────────────────────────────────────────────────────

test("序列化/解析往返", () => {
  const entry = {
    name: "缩进偏好",
    description: "用户喜欢 4 空格缩进",
    type: "user",
    body: "写代码用 4 空格缩进\nWhy: 可读性好",
  };
  const content = serializeMemory(entry);
  const parsed = parseMemory(content);
  assert.deepEqual(parsed, entry);
});

test("parseMemory 容忍手写 frontmatter（分隔符后不空行）", () => {
  // 课程自带的 memories/user/用户喜欢的颜色是白色.md 就是这个写法
  const handwritten = "---\nname: 手写记忆\ndescription: d\ntype: user\n---\n正文直接跟在分隔符后面\n";
  const parsed = parseMemory(handwritten);
  assert.equal(parsed.name, "手写记忆");
  assert.equal(parsed.body, "正文直接跟在分隔符后面");
});

// ─── v2: CRUD + 去重 ───────────────────────────────────────────────

test("saveMemory 新记忆 created=true", async () => {
  const { created, deduped } = await saveMemory({
    name: "测试记忆1",
    description: "用于测试",
    type: "user",
    body: "内容",
  });
  assert.equal(created, true);
  assert.equal(deduped, false);
});

test("saveMemory 同内容去重 deduped=true", async () => {
  await saveMemory({ name: "测试记忆2", description: "d", type: "user", body: "b" });
  const { deduped, created } = await saveMemory({
    name: "测试记忆2",
    description: "d",
    type: "user",
    body: "b",
  });
  assert.equal(deduped, true);
  assert.equal(created, false);
});

test("deleteMemory 删除并更新索引", async () => {
  await saveMemory({ name: "待删除", description: "d", type: "user", body: "b" });
  assert.equal(await deleteMemory("待删除"), true);
  assert.equal(await deleteMemory("不存在"), false);
  const all = await listMemories();
  assert.ok(!all.some((m) => m.name === "待删除"));
});

test("saveMemory 改 type 不留旧目录副本", async () => {
  await saveMemory({ name: "换类型", description: "d", type: "user", body: "b" });
  await saveMemory({ name: "换类型", description: "d", type: "project", body: "b" });
  const all = (await listMemories()).filter((m) => m.name === "换类型");
  // 修复前这里会拿到 2 条（user/ 和 project/ 各一份），召回时重复注入
  assert.equal(all.length, 1);
  assert.equal(all[0].type, "project");
});

// ─── v3: 提取 ──────────────────────────────────────────────────────

test("parseExtractOutput 容错：纯 JSON", () => {
  const out = parseExtractOutput(
    '[{"name":"a","description":"d","type":"user","body":"b"}]',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "a");
});

test("parseExtractOutput 容错：```json 代码块包裹", () => {
  const out = parseExtractOutput(
    '```json\n[{"name":"a","description":"d","type":"user","body":"b"}]\n```',
  );
  assert.equal(out.length, 1);
});

test("parseExtractOutput 容错：非法输入返回空数组", () => {
  assert.deepEqual(parseExtractOutput("抱歉，我无法生成"), []);
  assert.deepEqual(parseExtractOutput(""), []);
});

test("extractMemories 调用 LLM 并解析", async () => {
  const fakeLlm = async () => ({
    role: "assistant",
    content:
      '[{"name":"用户用4空格","description":"缩进偏好","type":"user","body":"写代码用4空格缩进"}]',
  });
  const extracted = await extractMemories(fakeLlm, [{ role: "user", content: "我喜欢4空格" }], []);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].name, "用户用4空格");
});

// ─── v4: 召回 ──────────────────────────────────────────────────────

test("tokenize 中英文混合", () => {
  const tokens = tokenize("我用 4 空格缩进");
  assert.ok(tokens.includes("空格"));
  assert.ok(tokens.includes("缩进"));
  // 英文/数字词要求 ≥2 字符（"4" 单字符被过滤，防噪音）
  assert.ok(!tokens.includes("4"));
});

test("recallByKeywords 按相关度排序", () => {
  const memories = [
    { name: "无关记忆", description: "今天天气不错", type: "user", body: "x" },
    { name: "缩进偏好", description: "用户喜欢 4 空格缩进", type: "user", body: "用4空格" },
  ];
  const result = recallByKeywords("我用什么缩进", memories);
  assert.ok(result.length > 0);
  assert.equal(result[0].name, "缩进偏好"); // 相关度高的排前面
});

test("rerankByLLM 按 LLM 判断过滤", async () => {
  const candidates = [
    { name: "a", description: "关于缩进的记忆" },
    { name: "b", description: "关于咖啡的记忆" },
  ];
  const fakeLlm = async () => ({
    role: "assistant",
    content: '{"relevant": [0]}',
  });
  const result = await rerankByLLM(fakeLlm, "缩进", candidates);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "a");
});

// ─── v5: 异步提取调度 ──────────────────────────────────────────────

test("scheduleExtract 提取并落库（含游标）", async () => {
  const manager = new MemoryManager();
  const fakeLlm = async () => ({
    role: "assistant",
    content:
      '[{"name":"异步提取测试","description":"d","type":"user","body":"b"}]',
  });

  const messages = [
    { role: "user", content: "记住我喜欢蓝色" },
    { role: "assistant", content: "好的" },
  ];
  manager.scheduleExtract(fakeLlm, messages);
  await wait(80); // 等后台任务完成

  const all = await listMemories();
  assert.ok(all.some((m) => m.name === "异步提取测试"));

  // 游标已推进：再次 scheduleExtract 同批消息 → 不重复提取（无新消息）
  const before = all.length;
  manager.scheduleExtract(fakeLlm, messages);
  await wait(80);
  assert.equal((await listMemories()).length, before);
});

test("scheduleExtract 频率阈值：新增消息不足跳过", async () => {
  const manager = new MemoryManager();
  let llmCalls = 0;
  const fakeLlm = async () => {
    llmCalls += 1;
    return { role: "assistant", content: "[]" };
  };

  // 只有 1 条新消息（< EXTRACT_MIN_NEW_MESSAGES=2）→ 不触发
  manager.scheduleExtract(fakeLlm, [{ role: "user", content: "hi" }]);
  await wait(80);
  assert.equal(llmCalls, 0);
});

// ─── v6: Agent 集成 ────────────────────────────────────────────────

test("Agent 注入相关记忆进 system prompt", async () => {
  await saveMemory({
    name: "缩进偏好",
    description: "用户喜欢 4 空格缩进",
    type: "user",
    body: "写代码用4空格",
  });

  let injectedSystem = "";
  const fakeLlm = async (messages) => {
    injectedSystem = messages[0].content;
    return { role: "assistant", content: "好的", tool_calls: null };
  };

  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);
  const agent = new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "基础系统提示",
    verbose: false,
  });
  await agent.run("我写代码用什么缩进？");

  assert.ok(injectedSystem.includes("基础系统提示"));
  assert.ok(injectedSystem.includes("相关记忆"));
  assert.ok(injectedSystem.includes("缩进偏好"));
});

test("Agent run 结束后自动提取记忆", async () => {
  // 提取的 LLM 返回一条记忆，主对话的 LLM 正常回答
  let isExtractCall = false;
  const fakeLlm = async (messages, tools) => {
    if (tools === null) {
      // extract 调用（不带工具）
      isExtractCall = true;
      return {
        role: "assistant",
        content:
          '[{"name":"自动提取","description":"d","type":"user","body":"b"}]',
      };
    }
    return { role: "assistant", content: "明白", tool_calls: null };
  };

  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);
  const agent = new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "sys",
    verbose: false,
  });
  await agent.run("记住，我喜欢喝美式咖啡");
  await wait(80);

  assert.equal(isExtractCall, true);
  const all = await listMemories();
  assert.ok(all.some((m) => m.name === "自动提取"));
});

// ─── 协同：工具 + 记忆同时工作（继承 lesson04 的验证）────────────

test("带工具的 Agent：工具执行 + 记忆注入共存", async () => {
  await saveMemory({
    name: "目录偏好",
    description: "用户喜欢在 demo 目录工作",
    type: "user",
    body: "用户主要在 demo 目录工作",
  });

  let injectedHasMemory = false;
  const fakeLlm = async (messages, tools) => {
    if (tools === null) {
      // extract 调用
      return { role: "assistant", content: "[]" };
    }
    if (messages[0].content.includes("相关记忆")) {
      injectedHasMemory = true;
    }
    // 已有工具结果 → 收尾回答；否则第一轮先调工具
    const hasToolResult = messages.some((m) => m.role === "tool");
    if (hasToolResult) {
      return { role: "assistant", content: "已完成", tool_calls: null };
    }
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "list_files", arguments: '{"dir_path":"memories"}' },
        },
      ],
    };
  };

  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);
  const agent = new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "sys",
    verbose: false,
  });
  const answer = await agent.run("看看 demo 目录里有什么");
  await wait(60);

  assert.ok(injectedHasMemory);          // 记忆注入生效（lesson05）
  assert.ok(answer.includes("已完成"));    // 工具执行正常（lesson04）
});

// ─── 跨会话：文件系统持久化 ───────────────────────────────────────

test("跨会话：新 MemoryManager 能 recall 旧会话存的记忆", async () => {
  // 模拟"会话1"：存一条记忆（用独立的 manager 实例）
  const session1 = new MemoryManager();
  await session1.save({
    name: "跨会话记忆",
    description: "验证持久化：用户喜欢用 Vim 编辑器",
    type: "user",
    body: "用户喜欢用 Vim 编辑器",
  });

  // 模拟"会话2"（新实例 = 新进程）：从文件系统加载，能召回
  // 注：query 与记忆必须有关键词交集（2-gram 匹配），
  // 表述不同则召回不到 —— 这正是生产用向量检索的动机（见 README 缺口表）
  const session2 = new MemoryManager();
  const recalled = await session2.recall("我用什么编辑器");
  assert.ok(recalled.some((m) => m.name === "跨会话记忆"));
});

// ─── 防失控：Loop 判定不得留下孤儿 tool 消息（同族修复）─────────────

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

test("Loop 判定后同轮剩余 tool_calls 仍逐条回填（无孤儿 tool 消息）", async () => {
  // 每轮都返回两个同签名 tool_calls：第 2 轮第 1 条就撞上 LOOP_THRESHOLD，
  // 同一条响应里还有第 2 条 —— 若直接 break，它就没有配对的 tool 消息
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
