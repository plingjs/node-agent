/**
 * lesson04 · 继承自 lesson03-context（完整工具系统 + 上下文管理）
 *
 * 把三套能力整合进一个主循环：
 *   1. 完整工具系统（lesson02）：registry_full 的权限分级 + 参数校验 + 错误分层
 *   2. 防失控（lesson02）：Loop 检测 + retryable 错误预算
 *   3. 上下文管理（lesson03）：三层结构 + 水位线压缩 + 工具结果截断
 *
 * 这已经是一个"迷你 Qwen Code"——对应其 coreToolScheduler（工具调度）
 * + LoopDetectionService（防失控）+ auto-compact（上下文管理）。
 */

import { TieredContextManager, truncateToolResult } from "./context_manager_v2.js";

const MAX_TURNS = 10;
const LOOP_THRESHOLD = 3;  // 同工具+同参数重复 3 次视为死循环
const ERROR_BUDGET = 4;    // retryable 错误累计 4 次终止
const NUDGE = "请直接给出最终回答，不要再调用工具。";

export class Agent {
  /**
   * @param {Object} opts
   * @param {Object} opts.registry  createFullRegistry() 的返回值（完整工具系统）
   * @param {TieredContextManager} opts.cm 上下文管理器
   * @param {Function} opts.llm LLM 调用函数（注入）
   */
  constructor({ registry, cm, llm, verbose = false }) {
    this.registry = registry;
    this.cm = cm;
    this.llm = llm;
    this.verbose = verbose;
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

  async run(userInput) {
    this.cm.append({ role: "user", content: userInput });
    const guards = this._newGuards();

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // ── 上下文：水位线压缩检查（每轮推理前）──
      if (this.cm.needsCompaction()) {
        if (this.verbose) console.log("  [compaction] 达到水位线，压缩历史...");
        await this.cm.compact(this.llm);
      }

      // ── 推理：从 cm 取组装后的消息 + 完整工具 schema ──
      const msg = await this.llm(this.cm.build(), this.registry.getSchemas());
      this.cm.append(msg);

      const toolCalls = msg.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        let loopDetected = false;
        for (const tc of toolCalls) {
          const { name, arguments: rawArgs } = tc.function;

          // 解析参数（执行前容错）
          let args = {};
          try {
            args = rawArgs ? JSON.parse(rawArgs) : {};
          } catch { /* 交给 registry 兜底 */ }

          // ── 防失控：Loop 检测 ──
          // 判定死循环后，同一条响应里剩下的 tool_calls 不再执行，
          // 但仍逐条回填 role="tool" —— 少回填一条，下一轮 assistant(tool_calls)
          // 与 tool 的配对就断了，服务端直接 400（响应里有多个 tool_calls 时才会撞上）
          const loopReason = loopDetected
            ? `本轮已判定死循环，跳过执行: ${name}`
            : this._checkLoop(guards, name, args);
          if (loopReason) {
            loopDetected = true;
            this.cm.append({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ error: { code: "LOOP_DETECTED", message: loopReason } }),
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
                message: "重试预算耗尽，请放弃该方案，换一种方法。",
              };
            }
          }

          // ── 上下文：工具结果截断后回填 ──
          const content = truncateToolResult(JSON.stringify(result));
          if (this.verbose) {
            console.log(`  [tool] ${name}(${rawArgs}) -> ${content.slice(0, 80)}...`);
          }
          this.cm.append({ role: "tool", tool_call_id: tc.id, content });
        }
        continue;
      }

      const content = (msg.content || "").trim();
      if (content) return content;
      this.cm.append({ role: "user", content: NUDGE });
    }
    return "【达到最大轮数，任务未完成】";
  }
}
