/**
 * lesson05 · v6: agent —— 记忆 + 核心工具合并版
 *
 * 继承 lesson04 的完整能力（核心工具 + 防失控 + 上下文管理），
 * 叠加 lesson05 的记忆能力（注入 + 异步提取）。
 *
 * run(userInput)
 *   ├── ① 记忆注入：recall(输入) → 相关记忆拼进 system prompt
 *   ├── ② 推理循环（lesson04 同款）：
 *   │      压缩检查 → llm(带工具 schema) → Loop 检测 → registry.execute
 *   │      → 错误预算 → 工具结果截断 → 回填
 *   └── ③ 结束时：scheduleExtract（fire-and-forget 异步提取）
 *
 * 这是"迷你 Qwen Code"的又一步：工具调度 + 防失控 + 压缩 + 记忆全齐。
 */

import { TieredContextManager, truncateToolResult } from "./context_manager_v2.js";

const MAX_TURNS = 30;
const LOOP_THRESHOLD = 3;   // 同工具+同参数重复 3 次判死循环
const ERROR_BUDGET = 4;     // retryable 错误累计 4 次终止
const NUDGE = "请直接给出最终回答，不要再调用工具。";

export class Agent {
  /**
   * @param {Object} opts
   * @param {Function} opts.llm
   * @param {import("./memory_manager.js").MemoryManager} opts.memory
   * @param {Object} opts.registry  buildCoreTools() 返回的注册表（lesson04 核心工具）
   * @param {string} opts.systemPrompt
   */
  constructor({ llm, memory, registry, systemPrompt, verbose = false }) {
    this.llm = llm;
    this.memory = memory;
    this.registry = registry;
    this.systemPrompt = systemPrompt;
    this.verbose = verbose;
    this.cm = this._newContext();
  }

  _newContext() {
    return new TieredContextManager({
      maxTokens: 40960,
      reserveForOutput: 5120,
      compactRatio: 0.8,
      keepRecent: 6,
    });
  }

  /** 清空上下文（保留记忆）—— REPL 的 /reset 用 */
  reset() {
    this.cm = this._newContext();
  }

  _newGuards() {
    return {
      callSignatures: new Map(), // "tool|argsJson" -> count
      retryableErrors: 0,
    };
  }

  /** 返回 null=正常；返回字符串=终止原因（LOOP_DETECTED） */
  _checkLoop(guards, name, args) {
    const key = `${name}|${JSON.stringify(args)}`;
    const count = (guards.callSignatures.get(key) || 0) + 1;
    guards.callSignatures.set(key, count);
    if (count >= LOOP_THRESHOLD) {
      return `检测到死循环: ${name}(${JSON.stringify(args)}) 重复调用 ${LOOP_THRESHOLD} 次`;
    }
    return null;
  }

  async run(userInput, { memoryScope = "default" } = {}) {
    // ① 记忆注入：每轮动态 recall，结果拼进 system prompt
    const recalled = await this.memory.recall(userInput);
    const recallText = this.memory.formatRecall(recalled);
    this.cm.setSystem([
      { role: "system", content: this.systemPrompt + recallText },
    ]);

    this.cm.append({ role: "user", content: userInput });
    const guards = this._newGuards();

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // ── 上下文：压缩水位线 ──
      if (this.cm.needsCompaction()) {
        if (this.verbose) console.log("  [compaction] 压缩历史...");
        await this.cm.compact(this.llm);
      }

      // ── 推理：记忆注入后的 system + 完整工具 schema ──
      const msg = await this.llm(this.cm.build(), this.registry.getSchemas());
      this.cm.append(msg);

      const toolCalls = msg.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        // 本轮已判定死循环 → 剩余调用跳过执行，但每条都必须回填（见下）
        let loopDetected = false;
        for (const tc of toolCalls) {
          const { name, arguments: rawArgs } = tc.function;

          let args = {};
          try {
            args = rawArgs ? JSON.parse(rawArgs) : {};
          } catch { /* 交给 registry 兜底 */ }

          // ── 防失控：Loop 检测 ──
          // 判定死循环后，这条响应里剩下的 tool_calls 不再执行，但仍逐条回填
          // role="tool"：少回填一条，下一轮 assistant(tool_calls) 与 tool 的配对就
          // 断了，服务端直接 400（只在一条响应带多个 tool_calls 时才撞上）
          const loopReason = loopDetected
            ? `本轮已判定死循环，跳过执行: ${name}`
            : this._checkLoop(guards, name, args);
          if (loopReason) {
            loopDetected = true;
            this.cm.append({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({
                error: { code: "LOOP_DETECTED", message: loopReason },
              }),
            });
            continue;
          }

          // ── 工具执行：完整流水线（权限/校验/错误）──
          const result = await this.registry.execute(name, rawArgs);

          // ── 防失控：retryable 错误预算 ──
          if (result.error?.retryable) {
            guards.retryableErrors += 1;
            if (guards.retryableErrors >= ERROR_BUDGET) {
              result.error = {
                code: "ERROR_BUDGET_EXHAUSTED",
                message: "重试预算耗尽，请换一种方法。",
              };
            }
          }

          // ── 上下文：工具结果截断后回填 ──
          const content = truncateToolResult(JSON.stringify(result));
          if (this.verbose) {
            console.log(`  [tool] ${name} -> ${content.slice(0, 80)}...`);
          }
          this.cm.append({ role: "tool", tool_call_id: tc.id, content });
        }
        continue;
      }

      const content = (msg.content || "").trim();
      if (content) break;
      this.cm.append({ role: "user", content: NUDGE });
    }

    // ③ 异步提取：fire-and-forget（游标/频率/串行队列在 manager 内）
    this.memory.scheduleExtract(this.llm, this.cm.recent, memoryScope);

    // 取最后一条 assistant 消息作为回答
    const lastAssistant = [...this.cm.recent]
      .reverse()
      .find((m) => m.role === "assistant");
    return (lastAssistant?.content || "").trim() || "【未得到回答】";
  }
}
