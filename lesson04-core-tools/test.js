/**
 * lesson04 · 自测（node:test，零依赖）
 * 验证核心工具真实行为 + Agent 端到端集成
 * 跑法：node --test test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runShell } from "./tools/shell.js";
import { readFile_, writeFile_, listFiles } from "./tools/filesystem.js";
import { searchFiles } from "./tools/search.js";
import { fetchUrl } from "./tools/fetch.js";
import { buildCoreTools } from "./core_tools.js";
import { Agent } from "./agent.js";
import { TieredContextManager } from "./context_manager_v2.js";
import { PermissionManager } from "./permissions.js";

// ─── run_shell ─────────────────────────────────────────────────────

test("run_shell 执行正常命令", async () => {
  const r = await runShell("echo hello");
  assert.match(r.stdout, /hello/);
  assert.equal(r.exitCode, 0);
});

test("run_shell 拦截危险命令", async () => {
  const r = await runShell("rm -rf /");
  assert.equal(r.blocked, true);
  assert.ok(r.error.includes("危险操作"));
});

test("run_shell 超时返回 timeout 标记", async () => {
  const r = await runShell("sleep 2", { timeout: 200 });
  assert.equal(r.timeout, true);
  assert.ok(r.exitCode !== 0 || r.error); // 超时/被杀
});

// ─── filesystem ────────────────────────────────────────────────────

test("write_file + read_file 往返", async () => {
  const p = "/tmp/lesson04-test-write.txt";
  const w = await writeFile_(p, "hello lesson04");
  assert.equal(w.written, true);

  const r = await readFile_(p);
  assert.equal(r.content, "hello lesson04");
});

test("read_file 大文件只回 head + 分页提示", async () => {
  const p = "/tmp/lesson04-test-big.log";
  await writeFile_(p, "x".repeat(60000)); // 60KB，超过 50KB 阈值

  const r = await readFile_(p);
  assert.equal(r.truncated, true);
  assert.equal(r.size, 60000);
  assert.equal(r.head.length, 2000);
  assert.match(r.hint, /head/); // 提示模型改用 run_shell 分页读
});

test("read_file 不存在文件返回错误", async () => {
  const missing = await readFile_("/tmp/lesson04-not-exist-xyz");
  assert.ok(missing.error);
});

test("list_files 返回目录结构", async () => {
  const r = await listFiles("demo");
  const names = r.entries.map((e) => e.name);
  assert.ok(names.includes("app.js"));
  assert.ok(names.includes("utils.js"));
});

test("list_files 不传 dir_path 时默认当前目录", async () => {
  const r = buildCoreTools(() => true);
  const res = await r.execute("list_files", "{}");
  // schema 里 dir_path 非必填、fn 默认 "."，缺参不再被判 INVALID_PARAMS
  assert.equal(res.error, undefined);
  assert.ok(res.result.entries.length > 0);
});

// ─── search_files ──────────────────────────────────────────────────

test("search_files 搜索 demo 目录的 TODO 标记", async () => {
  // 用 "TODO:"（带冒号）只匹配真正的待办标记，排除注释里的"TODO 标记"字样
  const r = await searchFiles("TODO:", { dir: "demo" });
  assert.ok(r.count > 0);
  // app.js 有 3 个 TODO: 标记
  const appMatches = r.matches.filter((m) => m.file.includes("app.js"));
  assert.equal(appMatches.length, 3);
});

test("search_files 按文件名通配过滤", async () => {
  const r = await searchFiles("TODO", { dir: "demo", fileGlob: "*.js" });
  // 只匹配 js 文件，README.md 被过滤
  assert.ok(r.matches.every((m) => m.file.endsWith(".js")));
});

test("search_files 文件名通配支持 ? 单字符", async () => {
  const r = await searchFiles("init", { dir: "demo", fileGlob: "app.j?" });
  assert.ok(r.count > 0);
  assert.ok(r.matches.every((m) => m.file.endsWith("app.js")));
});

// ─── fetch_url（mock 网络）────────────────────────────────────────

test("fetch_url 返回内容（mock fetch）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    headers: new Map([["content-type", "text/plain"]]),
    text: async () => "hello from web",
  });
  try {
    const r = await fetchUrl("https://example.com");
    assert.equal(r.status, 200);
    assert.match(r.body, /hello from web/);
  } finally {
    globalThis.fetch = original;
  }
});

// ─── core_tools 注册 ───────────────────────────────────────────────

test("core_tools 注册 6 个工具", () => {
  const r = buildCoreTools(() => true);
  assert.equal(r.getSchemas().length, 6);
});

test("core_tools 权限分级：run_shell 是 danger", async () => {
  const denied = buildCoreTools(() => false); // confirm 全拒
  const res = await denied.execute("run_shell", '{"command":"echo hi"}');
  assert.equal(res.error.code, "PERMISSION_DENIED"); // danger 被拒

  const allowed = buildCoreTools(() => true);
  const ok = await allowed.execute("run_shell", '{"command":"echo hi"}');
  assert.match(ok.result.stdout, /hi/);
});

test("（负向）未声明等级的工具默认 read：本课刻意留的缺口", async () => {
  // permissions.js 第 51 行 `kinds.get(name) || Kind.READ` —— fail-open（教学宽容）
  // 生产要反过来 fail-closed；这条用例钉住缺口，后续课程改掉它就会红
  const pm = new PermissionManager(() => false); // 用户全部拒绝
  assert.equal(await pm.check("mystery_tool", {}), true);
});

// ─── Agent 端到端集成 ──────────────────────────────────────────────

test("Agent 用核心工具完成搜索+写报告任务", async () => {
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 4 });
  cm.setSystem([{ role: "system", content: "sys" }]);

  // 模拟模型：第一步 search_files，第二步收尾（不真实写文件，验证工具链路通）
  const calls = [];
  const fakeLlm = async (messages, tools) => {
    calls.push(tools);
    if (calls.length === 1) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "search_files", arguments: '{"pattern":"TODO","dir":"demo"}' },
          },
        ],
      };
    }
    return { role: "assistant", content: "搜索完成", tool_calls: null };
  };

  const registry = buildCoreTools(() => true);
  const agent = new Agent({ registry, cm, llm: fakeLlm, verbose: false });
  const answer = await agent.run("搜索 TODO");

  assert.ok(answer.includes("搜索完成"));
  assert.equal(calls.length, 2); // 一次工具 + 一次收尾
  // 第一次推理时 tools 是 6 个核心工具的 schema
  assert.equal(calls[0].length, 6);
});

// ─── 交互式：多轮上下文保持 ────────────────────────────────────────

test("交互式多轮：第二轮能看到第一轮上下文", async () => {
  // 同一个 cm 跨 run 复用（交互式 REPL 的核心机制）
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 100 });
  cm.setSystem([{ role: "system", content: "sys" }]);

  let lastMessages = null;
  const fakeLlm = async (messages) => {
    lastMessages = messages;
    return { role: "assistant", content: "好的", tool_calls: null };
  };

  const registry = buildCoreTools(() => true);
  const agent = new Agent({ registry, cm, llm: fakeLlm, verbose: false });

  await agent.run("第一轮：我叫小明");
  await agent.run("第二轮：我叫什么？");

  // 第二轮推理时，cm 里应包含第一轮的内容（"小明"）
  assert.ok(lastMessages.some((m) => String(m.content).includes("小明")));
});

// ─── 回归：压缩不拆散 tool_calls/tool 配对 ────────────────────────

test("compact 切点落在 tool 消息上也不拆散配对（回归 API 400）", async () => {
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 4 });
  cm.setSystem([{ role: "system", content: "sys" }]);

  // 构造 recent：让原始切点 split=2 恰好落在 tool 消息上
  cm.recent = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "结果" }, // ← split=2 原本落这里
    { role: "assistant", content: "回答1" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "回答2" },
  ];

  const fakeLlm = async () => ({ role: "assistant", content: "摘要" });
  await cm.compact(fakeLlm);

  const built = cm.build();
  // 验证：每条 tool 消息的前一条必须是带 tool_calls 的 assistant
  for (let i = 0; i < built.length; i++) {
    if (built[i].role === "tool") {
      assert.equal(built[i - 1]?.role, "assistant", "tool 消息前必须是 assistant");
      assert.ok(built[i - 1]?.tool_calls, "tool 消息前必须有 tool_calls");
    }
  }
});

// ─── 回归：Loop 检测不产生孤儿 tool_calls ─────────────────────────

test("Loop 检测触发时，同一响应里剩余 tool_calls 仍逐条回填", async () => {
  const cm = new TieredContextManager({ maxTokens: 100000, keepRecent: 100 });
  cm.setSystem([{ role: "system", content: "sys" }]);

  // 同签名重复调用：第 2 轮的第 1 条就是第 3 次（触发 LOOP_THRESHOLD），
  // 同一条响应里还有第 2 条 —— 若直接 break，它就没有配对的 tool 消息
  const dupe = (id) => ({
    id,
    type: "function",
    function: { name: "list_files", arguments: '{"dir_path":"demo"}' },
  });
  let turn = 0;
  const fakeLlm = async () => {
    turn += 1;
    if (turn <= 2) {
      return { role: "assistant", content: null, tool_calls: [dupe(`c${turn}a`), dupe(`c${turn}b`)] };
    }
    return { role: "assistant", content: "已放弃重复调用", tool_calls: null };
  };

  const registry = buildCoreTools(() => true);
  const agent = new Agent({ registry, cm, llm: fakeLlm, verbose: false });
  const answer = await agent.run("列目录");

  assert.ok(answer.includes("已放弃重复调用"));
  const built = cm.build();
  assert.ok(built.some((m) => String(m.content).includes("LOOP_DETECTED")));

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
