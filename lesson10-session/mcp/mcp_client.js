/**
 * lesson10 · v2: mcp_client —— MCP 客户端（spawn + 请求响应匹配）
 *
 * 通过 child_process.spawn 启动 mcp_server.js 子进程，
 * stdin 写请求、stdout 读响应（真实 MCP stdio transport）。
 * 对应 Qwen Code 的 mcp-client.ts（Client + Transport 抽象）。
 *
 * 核心机制：JSON-RPC 请求-响应匹配 —— 每个请求带自增 id，
 * 响应按 id 路由到对应的 Promise（Map<pendingId, resolve>）。
 *
 * 生命周期：connect（initialize 握手）→ listTools → callTool → close
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "mcp_server.js",
);

export class McpClient {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.command] 启动命令，默认 node
   */
  constructor({ command = process.execPath } = {}) {
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    /** 等待中的请求：id → {resolve, reject, timer} */
    this.pending = new Map();
    this.connected = false;
    this.command = command;
  }

  /** 启动子进程并握手（initialize） */
  async connect({ timeoutMs = 5000 } = {}) {
    this.proc = spawn(this.command, [SERVER_SCRIPT], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.rl = createInterface({ input: this.proc.stdout });

    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch {
        // 忽略解析失败的行
      }
    });

    await this._request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "build-your-agent", version: "1.0.0" },
    }, { timeoutMs });
    this.proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0", method: "notifications/initialized",
    }) + "\n");
    this.connected = true;
  }

  /** 发 JSON-RPC 请求，返回响应（按 id 匹配 Promise） */
  _request(method, params, { timeoutMs = 5000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  /** 动态发现工具列表 */
  async listTools() {
    const res = await this._request("tools/list", {});
    return res.tools;
  }

  /** 调用工具 */
  async callTool(name, args) {
    const res = await this._request("tools/call", { name, arguments: args });
    // MCP 规范：错误在结果里（isError），不抛异常
    if (res.isError) {
      return { error: res.content?.[0]?.text || `工具 ${name} 调用失败` };
    }
    // 文本内容拼接返回
    const text = (res.content || [])
      .map((c) => c.text || "")
      .filter(Boolean)
      .join("\n");
    return { text };
  }

  /** 关闭子进程 */
  close() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.connected = false;
    }
  }
}
