/**
 * lesson11 · approval_flow —— IM 审批流（权限确认搬到聊天里）
 *
 * 真实业务问题：Agent 的 danger/write 工具需要确认时，确认请求
 * 不能卡在终端（用户在 QQ 里，终端没人看）——必须：
 *   1. 通过 gateway 把确认请求发给用户（QQ 消息）
 *   2. 挂起等待该用户回复
 *   3. 用户回复"批准/拒绝/始终允许" → resolve
 *   4. 超时（默认 60s）→ 自动拒绝（安全默认）
 *
 * 与 lesson02 三态确认的对应：
 *   True        = 批准一次（ProceedOnce）
 *   "always"    = 始终允许（ProceedAlways）
 *   False       = 拒绝（Cancel）
 *
 * 并发要点：确认等待期间 agent.run 挂起，用户回复必须**绕过串行队列**
 * 直接处理（否则队列被 agent.run 占用，回复永远排不上 → 死锁）。
 */

export class ApprovalFlow {
  /**
   * @param {Object} opts
   * @param {Map<string, Object>} [opts.gateways] channelId → gateway（按通道路由确认请求）
   * @param {Object} [opts.defaultGateway] 兜底通道（未匹配时用）
   * @param {number} [opts.timeoutMs] 确认超时，默认 60s
   * @param {Function} [opts.log]
   */
  constructor({ gateways = new Map(), defaultGateway = null, timeoutMs = 60000, log = console.log } = {}) {
    this.gateways = gateways;
    this.defaultGateway = defaultGateway;
    this.timeoutMs = timeoutMs;
    this.log = log;
    /** channelId -> { resolve, timer, name } */
    this.pending = new Map();
  }

  /** 按 channelId 找到确认请求要发往的通道 */
  _gatewayFor(channelId) {
    return this.gateways.get(channelId) || this.defaultGateway;
  }

  /**
   * 创建绑定到某 channel 的 confirm 回调（作为 registry 的权限确认）。
   * @param {string} channelId 请求确认的用户/群
   * @param {string} [msgId] 触发消息的 id —— QQ 被动回复必须带 msg_id，否则发送被拒！
   * @returns {Function} async (name, args) => True | "always" | False
   */
  createConfirm(channelId, msgId = "") {
    return async (name, args) => {
      // 先同步注册 pending，再发确认消息（防 handleReply 竞态：
      // handleReply 可能在 send 完成前被调用，找不到 pending）
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(channelId);
          this.log(`[approval] ${channelId} 确认超时（${this.timeoutMs}ms），自动拒绝`);
          resolve(false); // 安全默认：超时 = 拒绝
        }, this.timeoutMs);

        this.pending.set(channelId, { resolve, timer, name });

        // 确认请求发到对应通道（异步；必须带 msg_id 才能被动回复成功）
        const gw = this._gatewayFor(channelId);
        if (gw) {
          void gw
            .send(
              channelId,
              `⚠️ 需要你的批准：\n工具：${name}\n参数：${JSON.stringify(args)}\n\n回复：1 (批准) / 2 (拒绝) / 3 (始终允许)`,
              msgId,
            )
            .catch(() => {});
        } else {
          this.log(`[approval] 无可用通道发送确认给 ${channelId}`);
        }
      });
    };
  }

  /**
   * 处理用户回复。是确认回复则消费并返回 true；否则返回 false。
   * 必须在串行队列外调用（见 agent_bridge）。
   * @param {string} channelId
   * @param {string} text
   * @returns {boolean} 是否已作为确认回复消费
   */
  handleReply(channelId, text) {
    const p = this.pending.get(channelId);
    if (!p) return false;

    clearTimeout(p.timer);
    this.pending.delete(channelId);

    const t = String(text || "").trim().toLowerCase();
    // 数字映射（与确认文案一致）：1=批准一次 / 2=拒绝 / 3=始终允许
    // 其他输入 = 拒绝（安全默认）
    if (["批准", "同意", "允许", "y", "yes", "ok", "1"].includes(t)) {
      this.log(`[approval] ${channelId} 批准了 ${p.name}`);
      p.resolve(true); // 批准一次
    } else if (["拒绝", "no", "n", "2"].includes(t)) {
      this.log(`[approval] ${channelId} 拒绝了 ${p.name}`);
      p.resolve(false); // 拒绝
    } else if (["始终允许", "always", "a", "3"].includes(t)) {
      this.log(`[approval] ${channelId} 始终允许 ${p.name}`);
      p.resolve("always"); // 记住，会话内不再问
    } else {
      this.log(`[approval] ${channelId} 拒绝了 ${p.name}（未识别输入，安全默认）`);
      p.resolve(false); // 其他输入 = 拒绝（安全默认）
    }
    return true;
  }

  /** 是否有待确认的请求 */
  get waitingCount() {
    return this.pending.size;
  }
}

/** 自动批准版（Mock 演示用，不卡终端） */
export function autoApproveConfirm() {
  return async () => true;
}
