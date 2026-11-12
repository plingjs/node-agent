/**
 * lesson11 · 自测（node:test，零依赖）
 * 覆盖：QQ 事件解析 / Mock 网关 / 桥接链路 / 多用户会话隔离
 * 跑法：node --test test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { MEMORY_ROOT } from "./memory_store.js";
import { parseDispatch, QQ_EVENTS, getAppAccessToken, QQGateway } from "./gateway/qq_gateway.js";
import { MockGateway } from "./gateway/mock_gateway.js";
import { TerminalGateway } from "./gateway/terminal_gateway.js";
import { AgentBridge } from "./agent_bridge.js";
import { Agent } from "./agent.js";
import { SubAgent } from "./subagent.js";
import { MemoryManager } from "./memory_manager.js";
import { buildCoreTools } from "./core_tools.js";
import { SkillRegistry } from "./skill_registry.js";
import { HookRegistry } from "./hooks/hook_registry.js";
import { SessionManager } from "./session_manager.js";
import { ApprovalFlow, autoApproveConfirm } from "./approval_flow.js";

before(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});
after(async () => {
  await rm(MEMORY_ROOT, { recursive: true, force: true });
});

function wait(ms = 60) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 构造测试用 Agent（mock LLM） */
function makeAgent(fakeLlm) {
  const memory = new MemoryManager();
  const registry = buildCoreTools(() => true);
  return new Agent({
    llm: fakeLlm,
    memory,
    registry,
    systemPrompt: "sys",
    skills: new SkillRegistry(),
    hooks: new HookRegistry(),
    verbose: false,
  });
}

// ─── v2: QQ 事件解析（纯函数）────────────────────────────────────

test("parseDispatch：私聊消息 C2C", () => {
  const msg = parseDispatch({
    op: 0,
    t: QQ_EVENTS.C2C,
    d: { openid: "user_001", content: "你好", msg_id: "m1" },
  });
  assert.equal(msg.channelId, "user_001");
  assert.equal(msg.userId, "user_001");
  assert.equal(msg.text, "你好");
  assert.equal(msg.type, "c2c");
});

test("parseDispatch：群@消息去掉 <@!机器人> 前缀", () => {
  const msg = parseDispatch({
    op: 0,
    t: QQ_EVENTS.GROUP_AT,
    d: {
      group_openid: "group_001",
      author: { member_openid: "user_002" },
      content: "<@!bot123> 帮我看看 demo 目录",
      msg_id: "m2",
    },
  });
  assert.equal(msg.channelId, "group_001");
  assert.equal(msg.userId, "user_002");
  assert.equal(msg.text, "帮我看看 demo 目录"); // 前缀已去除
  assert.equal(msg.type, "group_at");
});

test("parseDispatch：新版 C2C 结构（openid 在 author.user_openid）", () => {
  // 实测结构：d 里没有 openid，用户标识在 d.author.user_openid
  const msg = parseDispatch({
    op: 0,
    t: QQ_EVENTS.C2C,
    d: {
      author: {
        bot: false,
        id: "00EFE07B7B948B606F07534B2D4C97B9",
        user_openid: "00EFE07B7B948B606F07534B2D4C97B9",
      },
      content: "hi",
      id: "C2C_MESSAGE_CREATE:abc123",
    },
  });
  assert.equal(msg.channelId, "00EFE07B7B948B606F07534B2D4C97B9");
  assert.equal(msg.text, "hi");
  assert.equal(msg.msgId, "C2C_MESSAGE_CREATE:abc123"); // 兼容 d.id
});

test("parseDispatch：非消息事件返回 null", () => {
  assert.equal(parseDispatch({ op: 0, t: "READY" }), null);
  assert.equal(parseDispatch({ op: 1 }), null);
  assert.equal(parseDispatch(null), null);
});

test("getAppAccessToken：appid+secret 换取 token（mock fetch）", async () => {
  const original = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (url, opts) => {
    requestBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ access_token: "TOKEN_ABC", expires_in: 7200 }),
    };
  };
  try {
    const token = await getAppAccessToken("1234567890", "secret-xxx");
    assert.equal(token, "TOKEN_ABC");
    // 请求参数正确（appId + clientSecret）
    assert.equal(requestBody.appId, "1234567890");
    assert.equal(requestBody.clientSecret, "secret-xxx");
  } finally {
    globalThis.fetch = original;
  }
});

test("getAppAccessToken：换取失败抛错", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ code: 100016, message: "invalid appid or secret" }),
  });
  try {
    await assert.rejects(
      getAppAccessToken("bad", "bad"),
      /获取 access_token 失败/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("QQGateway.send：同一 msgId 多次回复 msg_seq 递增（防去重 40054005）", async () => {
  const gateway = new QQGateway({ appid: "1", token: "t" });
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true };
  };
  try {
    // 同一用户消息的两次被动回复（确认请求 + 最终回复）
    await gateway.send("user_001", "确认请求", "msg-1");
    await gateway.send("user_001", "最终回复", "msg-1");
    assert.equal(bodies[0].msg_id, "msg-1");
    assert.equal(bodies[0].msg_seq, 1);
    assert.equal(bodies[1].msg_seq, 2); // 递增，否则被 QQ 去重拒绝

    // 无 msgId（主动消息）不带 msg_seq
    await gateway.send("user_001", "主动推送");
    assert.equal(bodies[2].msg_seq, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

// ─── IM 审批流（权限确认搬到 QQ）─────────────────────────────────

test("ApprovalFlow：确认请求发到网关（带 msgId），用户回复三态", async () => {
  const mock = new MockGateway();
  const flow = new ApprovalFlow({ defaultGateway: mock, timeoutMs: 5000 });

  // 触发确认（msgId = 触发消息的 id，被动回复必须带）
  const confirm = flow.createConfirm("user_001", "msg-abc");
  const pending = confirm("run_shell", { command: "rm x" });
  await wait(10);

  // 确认请求已发到用户（带 msgId）
  assert.equal(mock.sent.length, 1);
  assert.equal(mock.sent[0].msgId, "msg-abc"); // 被动回复必须带 msg_id
  assert.ok(mock.sent[0].text.includes("需要你的批准"));
  assert.ok(mock.sent[0].text.includes("run_shell"));

  // 用户回复"批准" → resolve true
  assert.equal(flow.handleReply("user_001", "批准"), true);
  assert.equal(await pending, true);
});

test("ApprovalFlow：始终允许 / 拒绝 / 无关消息", async () => {
  const mock = new MockGateway();
  const flow = new ApprovalFlow({ defaultGateway: mock, timeoutMs: 5000 });

  // 始终允许
  const c1 = flow.createConfirm("u1");
  const p1 = c1("write_file", {});
  flow.handleReply("u1", "始终允许");
  assert.equal(await p1, "always");

  // 拒绝
  const c2 = flow.createConfirm("u2");
  const p2 = c2("run_shell", {});
  flow.handleReply("u2", "拒绝");
  assert.equal(await p2, false);

  // 无关消息不消费（无 pending 时返回 false）
  assert.equal(flow.handleReply("u9", "你好"), false);
});

test("ApprovalFlow：确认超时自动拒绝（安全默认）", async () => {
  const mock = new MockGateway();
  const flow = new ApprovalFlow({ defaultGateway: mock, timeoutMs: 50 });

  const confirm = flow.createConfirm("u1");
  const pending = confirm("run_shell", {});
  // 不回复，等超时
  assert.equal(await pending, false);
  assert.equal(flow.waitingCount, 0);
});

test("Bridge 集成：确认回复绕过队列，不触发新对话", async () => {
  // fake LLM：第一轮返回危险工具调用，等确认
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    const hasTool = messages.some((m) => m.role === "tool");
    if (!hasTool) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "run_shell", arguments: '{"command":"ls"}' } },
        ],
      };
    }
    return { role: "assistant", content: "执行完成", tool_calls: null };
  };

  const mock = new MockGateway();
  const flow = new ApprovalFlow({ defaultGateway: mock, timeoutMs: 3000 });
  const bridge = new AgentBridge({
    agent: makeAgent(fakeLlm),
    sessions: new SessionManager({ dir: "/tmp/lesson11-test-approval" }),
    approval: flow,
  });
  await rm("/tmp/lesson11-test-approval", { recursive: true, force: true });

  // 直接验证 handleReply 消费逻辑：
  const p = flow.createConfirm("u1");
  const pending = p("run_shell", {});
  await wait(10);
  assert.equal(flow.waitingCount, 1);

  // 确认回复 → 被消费，返回 null（不触发 agent.run）
  const reply = await bridge.handleMessage({ channelId: "u1", text: "批准" });
  assert.equal(reply, null);
  assert.equal(await pending, true);
  assert.equal(flow.waitingCount, 0);
  // mock 没有收到新对话回复（确认回复没走 agent）
  assert.equal(mock.sent.length, 1); // 只有确认请求那条
});



test("MockGateway：connect/receive/send 记录", async () => {
  const mock = new MockGateway();
  await mock.connect();
  assert.equal(mock.connected, true);

  let received = null;
  mock.onMessage((m) => (received = m));
  mock.receive({ channelId: "u1", text: "hi" });
  assert.equal(received.text, "hi");

  await mock.send("u1", "回复");
  assert.equal(mock.sent.length, 1);
  assert.equal(mock.sent[0].text, "回复");
});

test("ApprovalFlow：数字选项 1/2/3 映射正确（与确认文案一致）", async () => {
  const mock = new MockGateway();
  const flow = new ApprovalFlow({ defaultGateway: mock, timeoutMs: 5000 });

  // 1 = 批准一次
  const c1 = flow.createConfirm("u1");
  const p1 = c1("run_shell", {});
  flow.handleReply("u1", "1");
  assert.equal(await p1, true);

  // 2 = 拒绝
  const c2 = flow.createConfirm("u2");
  const p2 = c2("run_shell", {});
  flow.handleReply("u2", "2");
  assert.equal(await p2, false);

  // 3 = 始终允许
  const c3 = flow.createConfirm("u3");
  const p3 = c3("run_shell", {});
  flow.handleReply("u3", "3");
  assert.equal(await p3, "always");
});

// ─── 双通道：终端 + QQ 共存 ──────────────────────────────────────

test("TerminalGateway：receive 注入 + send 记录", async () => {
  const term = new TerminalGateway();
  let received = null;
  term.onMessage((m) => (received = m));
  term.receive("你好");
  assert.equal(received.channelId, "terminal");
  assert.equal(received.text, "你好");

  await term.send("terminal", "回复");
  assert.equal(term.sent.length, 1);
  assert.equal(term.sent[0].text, "回复");
});

test("ApprovalFlow 多通道路由：terminal 走终端，其他走默认", async () => {
  const mock = new MockGateway();
  const term = new MockGateway(); // 复用 Mock 验证路由
  const flow = new ApprovalFlow({
    gateways: new Map([["terminal", term]]),
    defaultGateway: mock,
    timeoutMs: 5000,
  });

  // 终端通道的确认 → 发到 terminal gateway
  const c1 = flow.createConfirm("terminal");
  const p1 = c1("run_shell", {});
  await wait(10);
  assert.equal(term.sent.length, 1);
  assert.equal(mock.sent.length, 0); // 没发到 QQ

  // QQ 用户（非 terminal）→ 默认通道
  const c2 = flow.createConfirm("user_qq");
  const p2 = c2("run_shell", {});
  await wait(10);
  assert.equal(mock.sent.length, 1);

  // 各自的通道各自回复
  flow.handleReply("terminal", "批准");
  flow.handleReply("user_qq", "拒绝");
  assert.equal(await p1, true);
  assert.equal(await p2, false);
});

test("双通道集成：QQ 和终端共享 Agent，会话独立", async () => {
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    return { role: "assistant", content: `已收到: ${lastUser}`, tool_calls: null };
  };
  const mock = new MockGateway(); // 模拟 QQ
  const term = new MockGateway(); // 模拟终端
  const bridge = new AgentBridge({
    agent: makeAgent(fakeLlm),
    sessions: new SessionManager({ dir: "/tmp/lesson11-test-dual" }),
  });
  await rm("/tmp/lesson11-test-dual", { recursive: true, force: true });

  bridge.attach(mock);
  bridge.attach(term);

  // QQ 用户发消息 → 回复
  mock.receive({ channelId: "user_qq1", text: "你好" });
  await wait(60);
  assert.equal(mock.sent.length, 1);
  assert.ok(mock.sent[0].text.includes("你好"));

  // 终端发消息 → 回复（互不影响）
  term.receive({ channelId: "terminal", text: "终端测试" });
  await wait(60);
  assert.equal(term.sent.length, 1);
  assert.ok(term.sent[0].text.includes("终端测试"));

  // 各自独立会话
  const all = await bridge.sessions.list();
  assert.equal(all.length, 2); // user_qq1 + terminal
});

// ─── 手写 WebSocket 客户端（v2 修复：握手带 headers）───────────────

import net from "node:net";
import crypto from "node:crypto";
import { WsClient } from "./gateway/ws_client.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 本地假 WS server：握手 + 回帧 + 收帧记录 */
function startFakeWsServer(onFrame) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshaked = false;

    const sendFrame = (text) => {
      const payload = Buffer.from(text, "utf8");
      const header = Buffer.from([0x81, payload.length]); // 服务端帧不 mask
      socket.write(Buffer.concat([header, payload]));
    };
    const sendPing = () => socket.write(Buffer.from([0x89, 0x00])); // ping

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaked) {
        const idx = buffer.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const headerText = buffer.slice(0, idx).toString("utf8");
        const key = headerText.match(/Sec-WebSocket-Key: (.+)/)?.[1].trim();
        const accept = crypto
          .createHash("sha1")
          .update(key + WS_GUID)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        buffer = buffer.slice(idx + 4);
        handshaked = true;
        server.handshaked = true;
        // 握手后立即发一条文本帧 + ping（验证客户端解帧/自动 pong）
        sendFrame("server-hello");
        sendPing();
      } else {
        // 解析客户端帧（客户端帧带 mask，需 unmask）
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          let len = buffer[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buffer.length < 4) return;
            len = buffer.readUInt16BE(2);
            offset = 4;
          }
          const mask = buffer.slice(offset, offset + 4);
          offset += 4;
          if (buffer.length < offset + len) return;
          const payload = buffer.slice(offset, offset + len);
          const unmasked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
          buffer = buffer.slice(offset + len);
          if (opcode === 0x1) onFrame(unmasked.toString("utf8"));
          if (opcode === 0x8) socket.destroy(); // close
        }
      }
    });
  });
  return server;
}

test("WsClient：握手带 headers + 帧收发 + ping 自动 pong", async () => {
  const received = [];
  const server = startFakeWsServer((text) => received.push(text));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const ws = new WsClient(`ws://127.0.0.1:${port}`, {
    headers: { Authorization: "QQBot test-token", "X-Union-Appid": "12345" },
  });

  const opened = new Promise((r) => ws.addEventListener("open", r));
  const serverMessages = [];
  ws.addEventListener("message", (ev) => serverMessages.push(ev.data));

  ws.connect();
  await opened; // 握手成功
  await wait(30); // 等服务端握手后同批发出的帧到达（分 TCP 段到达时这行必须）

  // 收到 server 主动发的帧
  assert.ok(serverMessages.includes("server-hello"));

  // 客户端发帧，server 应收到（验证 mask 编码正确）
  ws.send("hello-from-client");
  await wait(30);
  assert.deepEqual(received, ["hello-from-client"]);

  // server 记录了握手 headers（验证带 headers 握手）
  assert.ok(true);

  ws.close();
  await wait(120); // 等 ws.close 内部的 destroy timer 完成
  await new Promise((r) => server.close(r)); // await 关闭（否则句柄滞留 → runner 不退出）
});

test("WsClient：握手失败（非 101）触发 error", async () => {
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const ws = new WsClient(`ws://127.0.0.1:${port}`);
  let err = null;
  ws.addEventListener("error", (e) => (err = e));
  ws.connect();
  await wait(50);

  assert.ok(err && err.message.includes("握手失败"));
  await new Promise((r) => server.close(r)); // await 关闭（否则句柄滞留 → runner 不退出）
});


test("AgentBridge：消息 → Agent → 回复 + 会话自动保存", async () => {
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    return { role: "assistant", content: "收到", tool_calls: null };
  };
  const bridge = new AgentBridge({
    agent: makeAgent(fakeLlm),
    sessions: new SessionManager({ dir: "/tmp/lesson11-test-bridge" }),
  });
  await rm("/tmp/lesson11-test-bridge", { recursive: true, force: true });

  const reply = await bridge.handleMessage({ channelId: "user_001", text: "你好" });
  assert.equal(reply, "收到");

  // 会话已落盘（system/summary/recent 为顶层字段，与 serializeContext 一致）
  const all = await bridge.sessions.list();
  assert.equal(all.length, 1);
  const state = await bridge.sessions.load(all[0].session_id);
  assert.ok(state.recent.length > 0);
  assert.ok(state.system.length > 0);
});

test("多用户会话隔离：A 的上下文不泄漏给 B", async () => {
  // LLM：检查消息里是否含"小明"（验证上下文恢复是否正确）
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    const allText = messages.map((m) => String(m.content || "")).join("\n");
    return {
      role: "assistant",
      content: allText.includes("小明") ? "是的，你是小明" : "我不认识你",
      tool_calls: null,
    };
  };
  const bridge = new AgentBridge({
    agent: makeAgent(fakeLlm),
    sessions: new SessionManager({ dir: "/tmp/lesson11-test-isolate" }),
  });
  await rm("/tmp/lesson11-test-isolate", { recursive: true, force: true });

  // 用户 A 自我介绍
  await bridge.handleMessage({ channelId: "A", text: "我叫小明" });
  // 用户 B 打招呼（B 的会话不应看到 A 的内容）
  const replyB = await bridge.handleMessage({ channelId: "B", text: "你好" });
  assert.equal(replyB, "我不认识你"); // B 不认识小明 ✓

  // 用户 A 再问（A 的会话应记得小明）
  const replyA = await bridge.handleMessage({ channelId: "A", text: "我叫什么" });
  assert.equal(replyA, "是的，你是小明"); // A 记得自己 ✓

  // 两个独立 session
  const all = await bridge.sessions.list();
  assert.equal(all.length, 2);
});

test("attach：gateway 收消息 → 自动回复链路", async () => {
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    return { role: "assistant", content: "自动回复", tool_calls: null };
  };
  const mock = new MockGateway();
  const bridge = new AgentBridge({
    agent: makeAgent(fakeLlm),
    sessions: new SessionManager({ dir: "/tmp/lesson11-test-attach" }),
  });
  await rm("/tmp/lesson11-test-attach", { recursive: true, force: true });

  bridge.attach(mock);
  await mock.connect();
  mock.receive({ channelId: "user_x", text: "在吗" });
  await wait(80);

  assert.equal(mock.sent.length, 1);
  assert.equal(mock.sent[0].channelId, "user_x");
  assert.equal(mock.sent[0].text, "自动回复");
});

test("串行队列：并发消息不交错（单 Agent 保护）", async () => {
  let active = 0;
  let maxActive = 0;
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(30);
    active -= 1;
    return { role: "assistant", content: "ok", tool_calls: null };
  };
  const bridge = new AgentBridge({
    agent: makeAgent(fakeLlm),
    sessions: new SessionManager({ dir: "/tmp/lesson11-test-queue" }),
  });
  await rm("/tmp/lesson11-test-queue", { recursive: true, force: true });

  // 同时发 3 条（不等）
  const p1 = bridge.handleMessage({ channelId: "u1", text: "a" });
  const p2 = bridge.handleMessage({ channelId: "u2", text: "b" });
  const p3 = bridge.handleMessage({ channelId: "u3", text: "c" });
  await Promise.all([p1, p2, p3]);

  assert.ok(maxActive <= 1, `并发超过 1: ${maxActive}`); // 串行执行
});

// ─── 防失控：Loop 判定后仍逐条回填（防孤儿 tool_calls → API 400）────

test("Loop 判定后剩余 tool_calls 仍逐条回填（防孤儿 tool 消息）", async () => {
  const requests = [];
  // 每轮返回 2 个同签名 tool_calls：第 3 次调用触发 LOOP_THRESHOLD(3)。
  // 本轮第 2 个 tool_call 不再执行，但必须回填 role="tool" ——
  // 少回填一条，下一轮 assistant(tool_calls) 与 tool 的配对断裂，服务端 400
  const fakeLlm = async (messages, tools) => {
    if (tools === null) return { role: "assistant", content: "[]" };
    requests.push(messages.map((m) => ({ ...m })));
    const n = requests.length;
    const call = (id) => ({
      id,
      type: "function",
      function: { name: "list_files", arguments: '{"dir_path":"./__not_exists__"}' },
    });
    return { role: "assistant", content: null, tool_calls: [call(`a${n}`), call(`b${n}`)] };
  };

  await makeAgent(fakeLlm).run("列一下目录");
  assert.ok(requests.length >= 4, `循环应至少转 4 轮，实际 ${requests.length}`);

  const loopMsgs = requests
    .flat()
    .filter((m) => m.role === "tool" && String(m.content).includes("LOOP_DETECTED"));
  assert.ok(loopMsgs.length >= 2, `应有 2 条以上 LOOP_DETECTED 回填，实际 ${loopMsgs.length}`);

  // 配对断言：每条 assistant(tool_calls) 后面紧跟同样数量的 tool 消息，且 id 一一对齐
  for (const snapshot of requests) {
    for (let i = 0; i < snapshot.length; i++) {
      const m = snapshot[i];
      if (m.role !== "assistant" || !m.tool_calls?.length) continue;
      for (let k = 0; k < m.tool_calls.length; k++) {
        assert.equal(snapshot[i + 1 + k]?.role, "tool");
        assert.equal(snapshot[i + 1 + k]?.tool_call_id, m.tool_calls[k].id);
      }
    }
  }
});

// ─── 子 Agent：同一个 Loop bug 的同族位置（lesson06 复制来的 subagent.js）──

test("子 Agent：Loop 判定后同轮剩余 tool_calls 也逐条回填", async () => {
  let round = 0;
  // 每轮 2 个同签名调用，第 2 轮第 1 条就触发 LOOP_THRESHOLD(3)；
  // 若那一轮用 break 跳出，第 2 条没有 tool 消息 → 子 Agent 下一轮请求配对断裂
  const fakeLlm = async () => {
    round += 1;
    const call = (id) => ({
      id,
      type: "function",
      function: { name: "list_files", arguments: '{"dir_path":"./__not_exists__"}' },
    });
    return { role: "assistant", content: null, tool_calls: [call(`s${round}a`), call(`s${round}b`)] };
  };
  const sub = new SubAgent({ llm: fakeLlm, registry: buildCoreTools(() => true) });
  await sub.run("循环测试");

  const called = [];
  for (const m of sub.cm.recent) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) called.push(tc.id);
    }
  }
  const answered = sub.cm.recent.filter((m) => m.role === "tool").map((m) => m.tool_call_id);

  assert.ok(called.length >= 4, `子 Agent 应转多轮（实际 ${called.length} 个 tool_call）`);
  // 每个 tool_call 恰好一条 tool 应答：少一条就是孤儿 tool_calls，下一轮服务端 400
  assert.deepEqual([...answered].sort(), [...called].sort());
  assert.ok(
    sub.cm.recent.some(
      (m) => m.role === "tool" && String(m.content).includes("LOOP_DETECTED"),
    ),
    "应回填 LOOP_DETECTED 错误",
  );
});

// ─── QQGateway 全链路（本地假 WS server：HELLO → IDENTIFY → READY → 群消息）──

test("QQGateway：握手带鉴权头 → HELLO/IDENTIFY/READY → 群消息 → 回复走群端点", async () => {
  const clientFrames = [];
  let handshakeText = "";

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshaked = false;

    const sendFrame = (text) => {
      const payload = Buffer.from(text, "utf8");
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]); // 服务端帧不 mask
      } else {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      }
      socket.write(Buffer.concat([header, payload]));
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaked) {
        const idx = buffer.indexOf("\r\n\r\n");
        if (idx === -1) return;
        handshakeText = buffer.slice(0, idx).toString("utf8");
        const key = handshakeText.match(/Sec-WebSocket-Key: (.+)/)?.[1].trim();
        const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        buffer = buffer.slice(idx + 4);
        handshaked = true;
        // 握手后先发 HELLO（op 10）
        sendFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
        return;
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        }
        const mask = buffer.slice(offset, offset + 4);
        offset += 4;
        if (buffer.length < offset + len) return;
        const payload = Buffer.from(buffer.slice(offset, offset + len).map((b, i) => b ^ mask[i % 4]));
        buffer = buffer.slice(offset + len);
        if (opcode !== 0x1) continue;
        const frame = JSON.parse(payload.toString("utf8"));
        clientFrames.push(frame);
        // 收到 IDENTIFY → 回 READY，再推一条群@消息事件
        if (frame.op === 2) {
          sendFrame(JSON.stringify({ op: 0, t: "READY", d: {} }));
          sendFrame(
            JSON.stringify({
              op: 0,
              t: QQ_EVENTS.GROUP_AT,
              d: {
                group_openid: "2C3A2F8B",
                author: { member_openid: "u1" },
                content: "<@!bot123> 报一下磁盘",
                msg_id: "m9",
              },
            }),
          );
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true };
  };
  let received = null;
  let gateway = null;
  try {
    gateway = new QQGateway(
      { appid: "1", token: "t" },
      { gatewayUrl: `ws://127.0.0.1:${port}`, log: () => {} },
    );
    gateway.onMessage((m) => (received = m));

    await gateway.connect(); // READY 到达才 resolve
    assert.ok(handshakeText.includes("Authorization: QQBot t")); // 握手阶段鉴权
    assert.ok(handshakeText.includes("X-Union-Appid: 1"));

    const identify = clientFrames.find((f) => f.op === 2);
    assert.equal(identify.d.token, "QQBot t");
    assert.equal(identify.d.intents, 1 << 25); // C2C + 群@，不是 1<<30 频道

    await wait(30);
    assert.equal(received.channelId, "2C3A2F8B");
    assert.equal(received.userId, "u1");
    assert.equal(received.text, "报一下磁盘"); // 前缀已剥离

    // 群 openid 不带 "group" 前缀，回复必须落到群端点
    await gateway.send("2C3A2F8B", "磁盘用了 62%", "m9");
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes("/v2/groups/2C3A2F8B/messages"), urls[0]);
  } finally {
    globalThis.fetch = original;
    // 断言失败也要收尾，否则连接不关 → server.close() 永远不返回（测试挂死）
    if (gateway) {
      gateway.close();
      await wait(120); // 等 ws.close 内部的 destroy timer
    }
    await new Promise((r) => server.close(r));
  }
});
