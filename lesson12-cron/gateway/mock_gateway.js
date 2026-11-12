/**
 * lesson11 · v3: mock_gateway —— 本地模拟网关
 *
 * 用途：
 *   1. 测试（node:test 里模拟消息收发）
 *   2. 无 QQ token 时的本地演示（main.js 自动 fallback）
 *
 * 与 QQGateway 同一抽象接口（MessageGateway），
 * receive() 是测试/演示注入消息的入口。
 */

import { MessageGateway } from "./gateway.js";

export class MockGateway extends MessageGateway {
  constructor() {
    super();
    this.sent = []; // 所有发送记录（可断言）
    this.connected = false;
  }

  async connect() {
    this.connected = true;
  }

  /** 模拟收到一条消息（测试/演示入口） */
  receive({ channelId, userId = channelId, text }) {
    this._emit({ channelId, userId, text });
  }

  /** 记录发送（不真的发出去）；msgId 为被动回复关联的消息 id */
  async send(channelId, text, msgId = "") {
    this.sent.push({ channelId, text, msgId });
    return true;
  }

  close() {
    this.connected = false;
  }
}
