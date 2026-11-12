#!/usr/bin/env node
/**
 * lesson09 · v1: mcp_server —— 模拟 MCP 外部工具服务器
 *
 * 真实 MCP 形态：server 是独立进程，通过 stdio 传输 JSON-RPC 消息。
 * 本文件以子进程方式运行（node mcp_server.js），模拟一个"外部系统"：
 *   stdin 读请求行 → 处理 → stdout 写响应行
 *
 * 协议（MCP 子集）：
 *   initialize   握手（协议版本/能力声明）
 *   tools/list   列出可用工具（动态发现）
 *   tools/call   调用工具
 *
 * 面试点：MCP 的本质是"协议标准化"——server 不关心客户端是谁，
 * 任何支持 MCP 的客户端（Qwen Code/Claude/我们的 Agent）都能调用。
 */

import { createInterface } from "node:readline";

/** 服务器暴露的工具（模拟"外部系统"的能力，如计算器服务） */
const TOOLS = [
  {
    name: "add",
    description: "两个整数相加，返回结果。",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "加数" },
        b: { type: "number", description: "被加数" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "echo",
    description: "原样回显一段文本。",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "get_time",
    description: "返回当前 Unix 时间戳（毫秒）。",
    inputSchema: { type: "object", properties: {} },
  },
];

/** 处理 JSON-RPC 请求 */
function handleRequest(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "calc-server", version: "1.0.0" },
      };
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const { name, arguments: args } = params;
      if (name === "add") {
        return { content: [{ type: "text", text: String(args.a + args.b) }] };
      }
      if (name === "echo") {
        return { content: [{ type: "text", text: String(args.text) }] };
      }
      if (name === "get_time") {
        return { content: [{ type: "text", text: String(Date.now()) }] };
      }
      return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
    }
    default:
      throw Object.assign(new Error(`未知方法: ${method}`), { code: -32601 });
  }
}

// ── stdio transport：读一行请求，回一行响应 ──
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message } }) + "\n");
    return;
  }

  // JSON-RPC 通知没有 id，也不需要响应。
  if (req.id === undefined) return;

  const response = { jsonrpc: "2.0", id: req.id };
  try {
    response.result = handleRequest(req.method, req.params || {});
  } catch (e) {
    response.error = { code: e.code || -32603, message: e.message };
  }
  process.stdout.write(JSON.stringify(response) + "\n");
});
