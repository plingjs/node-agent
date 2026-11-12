/**
 * lesson11 · terminal_gateway —— 终端通道
 *
 * 与 QQGateway 同属 MessageGateway 抽象：
 *   终端 = 一个"通道"（channelId 固定为 "terminal"）
 *   用户输入 → _emit({channelId:"terminal", text})
 *   send() → 打印到终端
 *
 * 与 QQ 共存的关键：readline 的 question 是异步的（await 让出事件循环），
 * QQ 的 WebSocket 事件照常处理——两个通道互不阻塞。
 *
 * 命令机制：/ 开头的输入命中 onCommand 注册的命令 → 执行（不当作普通消息）。
 * 会话：终端固定一个会话（channelId "terminal"），QQ 每用户独立会话。
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { MessageGateway } from "./gateway.js";

export const TERMINAL_CHANNEL = "terminal";

export class TerminalGateway extends MessageGateway {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.prompt]
   */
  constructor({ prompt = "你> " } = {}) {
    super();
    this.prompt = prompt;
    this.sent = [];
    this.rl = null;
    this.closed = false;
    /** / 命令表：name -> async (args) => {} */
    this.commands = new Map();
    /** 本次回复是否已通过打字机输出（send 不重复打印） */
    this._streaming = false;
    /** 等待"回复完成"的 waiter（输入后不立即显示 prompt） */
    this._replyWaiters = [];
  }

  /** 标记：本次回复已由打字机流式输出（main.js onDelta 调用） */
  markStreaming() {
    this._streaming = true;
  }

  /** 打字机输出完成（main.js 队列清空时调用）→ 此时才允许显示下一个 prompt */
  markTypingDone() {
    this._streaming = false;
    this._notifyReplyDone();
  }

  /** 通知等待者：一次回复已输出完成 */
  _notifyReplyDone() {
    const waiters = this._replyWaiters;
    this._replyWaiters = [];
    for (const r of waiters) r();
  }

  /** bridge 处理完成回调（无回复也通知，避免 waitReplyDone 等超时） */
  onMessageDone = () => this._notifyReplyDone();

  /** 等待 agent 回复完成（send 打印 / bridge 处理结束都会通知） */
  waitReplyDone(timeoutMs = 90000) {
    return Promise.race([
      new Promise((r) => this._replyWaiters.push(r)),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  /** 注册命令（/xxx 输入时命中，不当作普通消息） */
  onCommand(name, handler) {
    this.commands.set(name, handler);
  }

  /** 启动终端 REPL（readline 异步循环，不阻塞其他通道） */
  async connect() {
    this.rl = createInterface({ input: stdin, output: stdout });
    console.log("[terminal] 终端通道已启动（输入 /help 查看命令；/exit 退出）");
    this._loop();
  }

  async _loop() {
    while (!this.closed) {
      const raw = await this.rl.question(this.prompt);
      const handled = await this._handleLine(raw);
      if (!handled) {
        // 普通消息：等 agent 处理完成（回复输出完）再显示下一个"你>"，
        // 否则"你>"会抢在 agent 回复前出现（体验 bug）
        await this.waitReplyDone();
      }
    }
  }

  /**
   * 处理一行输入。返回 true = 已消费（命令或空行）；false = 是普通消息。
   * 拆出来便于测试（不启动 readline 也能测命令分发）。
   */
  async _handleLine(raw) {
    const line = String(raw ?? "").trim();
    if (!line) return true; // 空行

    // ── 命令处理 ──
    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.split(/\s+/);
      if (["/exit", "/quit", "/q"].includes(cmd)) {
        this.close();
        console.log("再见！");
        process.exit(0);
      }
      const handler = this.commands.get(cmd);
      if (handler) {
        try {
          await handler(rest.join(" "));
        } catch (e) {
          console.log(`命令 ${cmd} 执行失败: ${e.message}`);
        }
      } else {
        console.log(`未知命令: ${cmd}（/help 查看）`);
      }
      return true;
    }

    // ── 普通消息 → 通道消息 ──
    this._emit({ channelId: TERMINAL_CHANNEL, userId: TERMINAL_CHANNEL, text: line });
    return false;
  }

  /** 测试/演示注入（不经 readline） */
  receive(text) {
    this._emit({ channelId: TERMINAL_CHANNEL, userId: TERMINAL_CHANNEL, text: String(text) });
  }

  /** 打印 Agent 回复/审批请求到终端 */
  async send(channelId, text) {
    if (this._streaming) {
      // 回复内容已通过打字机逐字输出：只换行收尾，不重复打印（防 [] 残留）
      // 不 notify、不 prompt！——等打字机队列清空（markTypingDone）再显示"你>"，
      // 否则"你>"会抢在打字机输出完之前出现，输入和输出混在一起
      console.log();
    } else {
      console.log(`\n[agent] ${text}`);
      // 刷新输入提示：readline 的 question 只在调用时显示一次 prompt，
      // agent 输出后不会自动重新显示——不刷新的话要按回车才看到"你>"
      if (this.rl) {
        this.rl.setPrompt(this.prompt);
        this.rl.prompt();
      }
      this._notifyReplyDone(); // 非流式消息（确认请求等）：打印完即可显示 prompt
    }
    this.sent.push({ channelId, text });
    return true;
  }

  close() {
    this.closed = true;
    this.rl?.close();
  }
}
