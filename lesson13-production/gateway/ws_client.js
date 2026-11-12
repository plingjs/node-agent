/**
 * lesson11 · ws_client —— 零依赖 WebSocket 客户端
 *
 * 为什么手写：Node 22 内置的全局 WebSocket 是浏览器 API 形态，
 * 不支持自定义握手 headers（Authorization/X-Union-Appid），
 * 而 QQ 官方网关要求在握手阶段鉴权 → 内置 WebSocket 无法接入。
 *
 * 实现（WebSocket 协议，RFC 6455 最小子集）：
 *   1. TLS 连接（node:tls，wss://）
 *   2. HTTP Upgrade 握手：Sec-WebSocket-Key → 校验 Sec-WebSocket-Accept
 *   3. 帧解析：FIN/opcode/长度（7bit/16bit/64bit）/掩码/payload
 *   4. 帧发送：客户端帧必须掩码（mask 位 + XOR）
 *   5. 控制帧：ping→pong、close 回执
 *
 * API 兼容浏览器 WebSocket 核心（addEventListener/send/close/readyState），
 * 多一个 headers 构造参数。
 */

import tls from "node:tls";
import net from "node:net";
import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export class WsClient {
  /**
   * @param {string} url wss://host/path
   * @param {Object} [opts] {headers: {...}, debug: bool}
   */
  constructor(url, { headers = {}, debug = false } = {}) {
    this.url = url;
    this.headers = headers;
    this.debug = debug;
    this.readyState = 0; // 0=connecting 1=open 2=closing 3=closed
    this._listeners = { open: [], message: [], close: [], error: [] };
    this._socket = null;
    this._buffer = Buffer.alloc(0);
    this._closedByUser = false;
  }

  _log(...args) {
    if (this.debug) console.log("[ws-debug]", ...args);
  }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }

  _emit(type, ev) {
    for (const fn of this._listeners[type] || []) fn(ev);
  }

  /** 建立连接（握手 + 帧监听） */
  connect() {
    const u = new URL(this.url);
    const isTls = u.protocol === "wss:";
    const port = u.port ? Number(u.port) : isTls ? 443 : 80;

    const key = crypto.randomBytes(16).toString("base64");
    const path = u.pathname + u.search;
    // Host 头不带端口（默认端口省略；带 :443 会被部分网关拒绝）
    const hostHeader = port === 443 || port === 80 ? u.hostname : `${u.hostname}:${port}`;
    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${hostHeader}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(this.headers).map(([k, v]) => `${k}: ${v}`),
      "",
      "",
    ].join("\r\n");

    this._socket = (isTls ? tls : net).connect(
      {
        host: u.hostname,
        port,
        // 关键：必须显式传 servername（SNI）！
        // 不传时 Node 在多租户 IP 上可能拿不到正确 SNI，
        // 服务器返回默认证书（如 *.ias.tencent-cloud.net）→ 主机名校验失败
        servername: isTls ? u.hostname : undefined,
      },
      () => this._socket.write(request),
    );

    this._socket.on("data", (chunk) => {
      this._log("recv chunk:", chunk.toString("utf8").slice(0, 300));
      this._buffer = Buffer.concat([this._buffer, chunk]);
      if (!this._handshaked) {
        if (this._tryHandshake(key)) {
          this._handshaked = true;
          this.readyState = 1;
          this._emit("open", {});
          this._drainFrames(); // 握手后可能同包带帧
        }
      } else {
        this._drainFrames();
      }
    });

    this._socket.on("error", (err) => {
      this._emit("error", err);
    });

    this._socket.on("close", () => {
      this.readyState = 3;
      this._emit("close", { code: 1006, reason: "" });
    });
  }

  /** 解析 HTTP 响应头，校验 Sec-WebSocket-Accept；成功返回剩余 buffer */
  _tryHandshake(key) {
    const idx = this._buffer.indexOf("\r\n\r\n");
    if (idx === -1) return false; // 头还没收完

    const headerText = this._buffer.slice(0, idx).toString("utf8");
    this._buffer = this._buffer.slice(idx + 4);

    const lines = headerText.split("\r\n");
    const statusLine = lines[0];
    this._log("handshake response:", statusLine, "| headers:", lines.slice(1).join("; "));
    if (!statusLine.includes(" 101 ")) {
      this._emit("error", new Error(`握手失败: ${statusLine}`));
      this.close();
      return false;
    }

    const expected = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    const accept = lines
      .find((l) => l.toLowerCase().startsWith("sec-websocket-accept:"))
      ?.split(":")[1]
      .trim();

    if (accept !== expected) {
      this._emit("error", new Error("Sec-WebSocket-Accept 校验失败"));
      this.close();
      return false;
    }
    return true;
  }

  /** 解析 buffer 里的帧（可能多条，可能半条） */
  _drainFrames() {
    while (true) {
      const frame = this._parseFrame();
      if (!frame) return; // buffer 不够一条完整帧
      this._handleFrame(frame);
    }
  }

  _parseFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] >> 7) & 1;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] >> 7) & 1;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const longLen = buf.readBigUInt64BE(offset);
      if (longLen > BigInt(MAX_FRAME_BYTES)) {
        this._emit("error", new Error(`WebSocket 帧超过 ${MAX_FRAME_BYTES} 字节上限`));
        this._buffer = Buffer.alloc(0);
        this._socket?.destroy();
        return null;
      }
      len = Number(longLen);
      offset += 8;
    }
    if (len > MAX_FRAME_BYTES) {
      this._emit("error", new Error(`WebSocket 帧超过 ${MAX_FRAME_BYTES} 字节上限`));
      this._buffer = Buffer.alloc(0);
      this._socket?.destroy();
      return null;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;

    let payload = buf.slice(offset, offset + len);
    if (maskKey) {
      payload = Buffer.from(payload.map((b, i) => b ^ maskKey[i % 4]));
    }
    this._buffer = buf.slice(offset + len);

    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.TEXT:
        this._emit("message", { data: payload.toString("utf8") });
        break;
      case OP.BINARY:
        this._emit("message", { data: payload });
        break;
      case OP.PING:
        this._sendFrame(OP.PONG, payload);
        break;
      case OP.PONG:
        break;
      case OP.CLOSE: {
        // 回 close 回执（RFC 6455）
        if (this.readyState === 1) this._sendFrame(OP.CLOSE, Buffer.alloc(0));
        this.readyState = 3;
        this._emit("close", { code: 1000, reason: "" });
        this._socket?.destroy();
        break;
      }
    }
  }

  /** 发送文本 */
  send(text) {
    this._sendFrame(OP.TEXT, Buffer.from(text, "utf8"));
  }

  /** 发帧（客户端必须掩码） */
  _sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    const len = payload.length;

    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this._socket.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    this._closedByUser = true;
    if (this.readyState === 1) {
      this.readyState = 2;
      this._sendFrame(OP.CLOSE, Buffer.alloc(0));
    }
    setTimeout(() => this._socket?.destroy(), 100);
  }
}
