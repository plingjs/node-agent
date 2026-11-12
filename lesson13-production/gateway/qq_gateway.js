/**
 * lesson11 · v2: qq_gateway —— QQ 官方开放平台机器人网关
 *
 * 零依赖实现（手写 WebSocket 客户端，见 ws_client.js）：
 *   - WebSocket 长连接：wss://api.sgroup.qq.com/websocket
 *   - 握手阶段鉴权：Authorization: QQBot <token> + X-Union-Appid（必须！）
 *   - 鉴权：连接后发 IDENTIFY（token + intents）
 *   - 心跳：按 HELLO 返回的 heartbeat_interval 定时发 op 1
 *   - 消息事件：GROUP_AT_MESSAGE_CREATE（群@）/ C2C_MESSAGE_CREATE（私聊）
 *   - 发送：POST /v2/users/{openid}/messages（私聊）
 *              /v2/groups/{group_openid}/messages（群聊）
 *
 * 配置（env.json）：
 *   QQ_APPID  机器人 appid
 *   QQ_TOKEN  机器人 token
 *
 * 协议要点（面试可讲）：
 *   opcode: 0=事件 1=心跳 2=鉴权 10=Hello 11=心跳ACK
 *   intents=0 订阅公共事件（群@/私聊无需申请私域）
 *   断线重连：指数退避 + 上限（鉴权失败重连无意义，超限提示检查配置）
 */

import { MessageGateway } from "./gateway.js";
import { WsClient } from "./ws_client.js";

const GATEWAY_URL = "wss://api.sgroup.qq.com/websocket";
const API_BASE = "https://api.sgroup.qq.com";

/** 事件类型常量 */
export const QQ_EVENTS = {
  GROUP_AT: "GROUP_AT_MESSAGE_CREATE",
  C2C: "C2C_MESSAGE_CREATE",
};

/**
 * 解析 QQ 事件 payload → 统一消息模型。
 * 纯函数（可离线测试）。
 * @param {Object} payload WebSocket 收到的 DISPATCH 事件
 * @returns {{channelId: string, userId: string, text: string, msgId: string, type: string}|null}
 */
export function parseDispatch(payload) {
  if (!payload || payload.op !== 0 || !payload.t) return null;

  const d = payload.d || {};
  if (payload.t === QQ_EVENTS.C2C) {
    // 兼容新旧结构：新版 openid 在 d.author.user_openid（d.openid 可能缺失）
    const openid = d.openid || d.author?.user_openid || d.author?.id || "";
    const msgId = d.msg_id || d.id || "";
    if (!openid || !msgId) return null;
    return {
      type: "c2c",
      channelId: openid,
      userId: openid,
      text: String(d.content || "").trim(),
      msgId,
    };
  }
  if (payload.t === QQ_EVENTS.GROUP_AT) {
    const channelId = d.group_openid || "";
    const userId = d.author?.member_openid || d.author?.user_openid || "";
    const msgId = d.msg_id || d.id || "";
    if (!channelId || !userId || !msgId) return null;
    return {
      type: "group_at",
      channelId,
      userId,
      // 去掉 "<@!机器人ID> " 前缀（群@消息内容自带）
      text: String(d.content || "").replace(/^<@![^>]+>\s*/, "").trim(),
      msgId,
    };
  }
  return null; // 其他事件（READY 等）不是消息
}

/**
 * 获取 access_token（新版 union 机器人：appid + clientSecret 换取）。
 * 对应官方：POST https://api.bot.qq.com/app/getAppAccessToken
 * @param {string} appid
 * @param {string} clientSecret
 * @returns {Promise<string>} access_token（有效期 7200s，生产需缓存刷新）
 */
export async function getAppAccessToken(appid, clientSecret) {
  const resp = await fetch("https://api.bot.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: String(appid), clientSecret }),
  });
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`获取 access_token 失败: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

export class QQGateway extends MessageGateway {
  /**
   * @param {Object} config {appid, token}
   * @param {Object} [opts] {gatewayUrl, apiBase, maxReconnects, log}
   */
  constructor(
    { appid, token },
    { gatewayUrl = GATEWAY_URL, apiBase = API_BASE, maxReconnects = 5, log = console.log } = {},
  ) {
    super();
    if (!appid || !token) {
      throw new Error("QQGateway 需要 appid 和 token（env.json 的 QQ_APPID/QQ_TOKEN）");
    }
    this.appid = appid;
    this.token = token;
    this.gatewayUrl = gatewayUrl;
    this.apiBase = apiBase;
    this.maxReconnects = maxReconnects;
    this.log = log;
    this.ws = null;
    this.heartbeatTimer = null;
    this.reconnectAttempts = 0;
    this.closedByUser = false;
    /** msg_id → 已回复次数（同一消息多次被动回复 msg_seq 必须递增，否则被去重拒绝） */
    this.msgSeqs = new Map();
  }

  /** 建立连接：握手（带鉴权 headers）→ 等 HELLO → IDENTIFY */
  connect() {
    return new Promise((resolve, reject) => {
      this.closedByUser = false;
      let ready = false;

      // ── 关键：握手阶段必须带鉴权 headers（Node 内置 WebSocket 做不到，故手写）──
      this.ws = new WsClient(this.gatewayUrl, {
        headers: {
          Authorization: `QQBot ${this.token}`,
          "X-Union-Appid": this.appid,
        },
        debug: process.env.DEBUG_WS === "1",
      });

      this.ws.addEventListener("open", () => {
        this.log("[qq] WebSocket 握手成功，等待 HELLO...");
      });

      this.ws.addEventListener("message", (ev) => {
        let payload;
        try {
          payload = JSON.parse(ev.data);
        } catch {
          return;
        }

        const op = payload.op;

        // op 10: HELLO → 发 IDENTIFY
        if (op === 10) {
          const interval = payload.d?.heartbeat_interval || 45000;
          this._startHeartbeat(interval);
          this._send({
            op: 2,
            d: {
              token: `QQBot ${this.token}`,
              // 订阅 C2C 单聊 + 群@ 消息 → intents = 1 << 25（GROUP_AND_C2C_EVENT）
              // 注意：1<<30 是频道消息（AT_MESSAGE_CREATE），收不到私聊/群@！
              intents: 1 << 25,
              shard: [0, 1],
            },
          });
          return;
        }
        // op 11: 心跳 ACK
        if (op === 11) return;
        // op 0: 事件
        if (op === 0) {
          if (payload.t === "READY") {
            this.log("[qq] 鉴权成功，机器人已就绪");
            if (!ready) {
              ready = true;
              resolve();
            }
            return;
          }
          const msg = parseDispatch(payload);
          if (msg) {
            this.log(`[qq] 收到消息事件 ${payload.t}（channel=${msg.channelId.slice(0, 8)}...）`);
            this._emit(msg);
          } else {
            // 非消息事件（调试用：能看到服务端推了什么）
            this.log(`[qq] 收到未处理事件: ${payload.t}`);
          }
        }
      });

      this.ws.addEventListener("close", (ev) => {
        this._stopHeartbeat();
        if (this.closedByUser) return;

        this.reconnectAttempts += 1;
        if (this.reconnectAttempts > this.maxReconnects) {
          this.log(
            `[qq] 重连超过 ${this.maxReconnects} 次，已放弃。` +
              "请检查 env.json 的 QQ_APPID/QQ_TOKEN 是否正确、机器人是否已发布上线。",
          );
          return;
        }
        // 指数退避重连（1s→2s→4s...，封顶 30s）
        const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000);
        this.log(
          `[qq] 连接断开（close code: ${ev?.code ?? 1006}），${delay}ms 后重连（第 ${this.reconnectAttempts} 次）...`,
        );
        setTimeout(() => this.connect(), delay);
      });

      this.ws.addEventListener("error", (err) => {
        if (!ready) reject(err);
      });

      this.ws.connect();
    });
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _startHeartbeat(intervalMs) {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this._send({ op: 1, d: null }); // 心跳
    }, intervalMs);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 发送消息（群聊/私聊自动路由）。
   * @param {string} channelId openid（私聊）或 group_openid（群聊）
   * @param {string} text 回复内容
   * @param {string} [msgId] 回显原消息 id（被动回复防重复；同 msg_id 多次回复 seq 自动递增）
   */
  async send(channelId, text, msgId = "") {
    const isGroup = channelId.startsWith("group");
    const path = isGroup
      ? `/v2/groups/${channelId}/messages`
      : `/v2/users/${channelId}/messages`;

    const body = { content: text, msg_type: 0 };
    if (msgId) {
      // 同一 msg_id 每次被动回复 msg_seq 递增（否则报 40054005 消息被去重）
      const seq = (this.msgSeqs.get(msgId) || 0) + 1;
      this.msgSeqs.set(msgId, seq);
      body.msg_id = msgId;
      body.msg_seq = seq;
      // 简单清理：防长期运行 Map 无限增长
      if (this.msgSeqs.size > 1000) this.msgSeqs.clear();
    }

    const resp = await fetch(`${this.apiBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `QQBot ${this.token}`,
        "X-Union-Appid": this.appid,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      this.log(`[qq] 发送失败: ${resp.status} ${await resp.text()}`);
      return false;
    }
    return true;
  }

  close() {
    this.closedByUser = true;
    this._stopHeartbeat();
    if (this.ws) this.ws.close();
  }
}
