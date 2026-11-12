/**
 * lesson11 · v4: agent_bridge —— 消息 → Agent → 回复
 *
 * 把 gateway 收到的消息接进 Agent，并维护"每用户一个会话"：
 *   QQ 用户 openid → session（复用 lesson10 SessionManager）
 *
 * 关键设计：
 *   1. 单 Agent 实例服务多用户：处理消息前 restoreContext 切换 cm，
 *      处理完保存（每用户会话互不干扰）
 *   2. 串行队列：同一时刻只处理一条消息（单 Agent 的并发保护）
 *   3. 持久化前重置 system 为基础 prompt —— 注入内容（记忆/技能）
 *      每轮重建，不落盘（lesson10 的"注入 vs 持久"原则）
 */

import { serializeContext, restoreContext } from "./session_state.js";
import { autoTitle } from "./session_manager.js";

export class AgentBridge {
  /**
   * @param {Object} opts
   * @param {import("./agent.js").Agent} opts.agent
   * @param {import("./session_manager.js").SessionManager} opts.sessions
   * @param {import("./approval_flow.js").ApprovalFlow} [opts.approval] IM 审批流
   */
  constructor({ agent, sessions, approval = null }) {
    this.agent = agent;
    this.sessions = sessions;
    this.approval = approval;
    /** 当前正在处理消息的 channel（confirm 回调取用） */
    this.currentChannel = null;
    /** 当前消息的 msgId（被动回复必须带） */
    this.currentMsgId = "";
    /** channelId -> session_id（QQ 私聊 openid / 群聊 group_openid） */
    this.channelToSession = new Map();
    /** 串行队列（单 Agent 实例一次处理一条） */
    this.queue = Promise.resolve();
  }

  /** 挂到 gateway：收消息 → 处理 → 回复 */
  attach(gateway) {
    gateway.onMessage((msg) => {
      this.handleMessage(msg)
        .then((reply) => {
          if (reply) return gateway.send(msg.channelId, reply, msg.msgId);
        })
        .catch((err) => {
          // LLM 超时/失败绝不退出进程：记录 + 通知用户重试
          console.error(`[bridge] 消息处理失败（${msg.channelId}）: ${err.message}`);
          return gateway
            .send(msg.channelId, `⚠️ 处理失败：${err.message}\n（请稍后重试）`, msg.msgId)
            .catch(() => {});
        })
        .finally(() => {
          // 处理完成信号（终端用它决定 prompt 显示时机；无回复也通知）
          gateway.onMessageDone?.(msg);
        });
    });
  }

  /** 处理一条消息（串行化，返回回复文本） */
  handleMessage({ channelId, text, msgId }) {
    // ── 审批回复优先：绕过串行队列直接处理 ──
    // 原因：agent.run 正在等确认时已占用队列，确认回复若进队列会死锁
    if (this.approval && this.approval.handleReply(channelId, text)) {
      return Promise.resolve(null);
    }
    const task = this.queue.then(() => this._process({ channelId, text, msgId }));
    this.queue = task.catch(() => {}); // 队列吞掉错误，下一条继续
    return task;
  }

  /** 系统消息（定时任务/告警）：与 handleMessage 的区别是
   * 不参与审批回复消费（系统消息不是用户回复，不能被误判为"批准"）。
   * @returns {Promise<string>} 回复文本（由调用方决定推送目标）
   */
  handleSystemMessage({ channelId, text }) {
    const task = this.queue.then(() => this._process({ channelId, text, system: true }));
    this.queue = task.catch(() => {});
    return task;
  }

  // ── 会话管理（继承 lesson10 能力，供终端命令调用）──

  /** 列出所有会话 */
  async listSessions() {
    return this.sessions.list();
  }

  /** 切换某通道到指定会话（恢复上下文到 cm，会话历史可续聊） */
  async switchSession(channelId, sessionId) {
    this.channelToSession.set(channelId, sessionId);
    this.agent.reset();
    const state = await this.sessions.load(sessionId).catch(() => null);
    if (state) restoreContext(this.agent.cm, state);
    return state;
  }

  /** 删除会话；若某通道正用它则清除映射（下次消息自动建新会话） */
  async deleteSession(channelId, sessionId) {
    await this.sessions.delete(sessionId);
    if (this.channelToSession.get(channelId) === sessionId) {
      this.channelToSession.delete(channelId);
    }
  }

  async _process({ channelId, text, msgId, system = false }) {
    this.currentChannel = channelId; // confirm 回调需要知道"谁在等确认"
    this.currentMsgId = msgId || ""; // 被动回复必须带原消息 id
    // 1. 找/建该用户的 session
    let sid = this.channelToSession.get(channelId);
    if (!sid) {
      const meta = await this.sessions.create({ title: autoTitle(text) });
      sid = meta.session_id;
      this.channelToSession.set(channelId, sid);
      this.agent.reset(); // 新用户：干净上下文
    } else {
      // 老用户：恢复该会话到 agent.cm（多用户切换）
      const state = await this.sessions.load(sid);
      restoreContext(this.agent.cm, state);
    }

    // 2. 跑 Agent（1-9 课全部能力）
    const answer = await this.agent.run(text, { memoryScope: sid });

    // 3. 保存会话（只持久化基础 system，注入内容不落盘）
    this.agent.cm.setSystem([
      { role: "system", content: this.agent.systemPrompt },
    ]);
    const state = {
      ...(await this.sessions.load(sid)),
      ...serializeContext(this.agent.cm),
      message_count: this.agent.cm.recent.filter((m) => m.role === "user").length,
      updated_at: Date.now(),
    };
    await this.sessions.save(sid, state).catch(() => {});

    return answer;
  }
}
