/**
 * lesson11 · v1: gateway —— 消息网关抽象接口
 *
 * 真实业务里 Agent 的入口是 IM（QQ/企业微信/钉钉），不是终端。
 * Gateway 抽象统一"消息收发"，具体平台（QQ）在子类实现。
 *
 * 统一消息模型（跨平台归一）：
 *   { channelId, userId, text }
 *     channelId  会话通道标识（QQ 私聊 = openid，群聊 = group_openid）
 *     userId     用户标识（QQ = openid）
 *     text       消息文本
 *
 * 生命周期：connect → onMessage(回调) → send(回复) → close
 * 本课实现：QQGateway（官方机器人 WebSocket）+ MockGateway（本地模拟）
 */

export class MessageGateway {
  /** 建立连接（子类实现） */
  async connect() {
    throw new Error("未实现 connect");
  }

  /** 注册消息回调（子类在收到平台消息时调用） */
  onMessage(callback) {
    this._onMessage = callback;
  }

  /** 发送回复（子类实现；channelId = 消息里的 channelId） */
  async send(channelId, text) {
    throw new Error("未实现 send");
  }

  /** 关闭连接 */
  close() {}

  /** 内部：触发消息回调 */
  _emit(message) {
    if (this._onMessage) this._onMessage(message);
  }
}
