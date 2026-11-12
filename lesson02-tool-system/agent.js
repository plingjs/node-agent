/**
 * 第2课 · v5: agent —— 主循环升级（防失控，Node 版）
 *
 * 第1课只有 max_turns。v5 加两个生产级防护：
 *  1. Loop 检测：同工具+同参数重复调用 → 死循环（对应 LoopDetectionService）
 *  2. 错误预算：retryable 错误累计超阈值 → 终止（模型"死磕"坏工具）
 *
 * 设计：llm 通过构造函数注入 —— 测试时替换成 fake 函数即可，
 * 不需要 mock 框架（这是 Node 版相对 Python mock.patch 的简化点）。
 */

import { call_llm } from "./llm.js";
import { ErrorCode } from "./errors.js";

export const MAX_TURNS = 10;
export const LOOP_THRESHOLD = 3;  // 同工具+同参数重复 3 次视为死循环
export const ERROR_BUDGET = 4;    // retryable 错误累计 4 次终止

const NUDGE = "请直接给出最终回答，不要再调用工具。";

/** 递归排序对象键，让参数键顺序不同的同一调用得到相同签名。 */
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export class Agent {
  /**
   * @param {Object} registry - createFullRegistry() 的返回值
   * @param {Object} [options]
   * @param {Function} [options.llm] LLM 调用函数，默认用真实实现（测试注入 fake）
   * @param {boolean} [options.verbose]
   */
  constructor(registry, { llm = call_llm, verbose = true } = {}) {
    this.registry = registry;
    this.llm = llm;
    this.verbose = verbose;
  }

  /** 每次任务（不是每轮）重置防护状态 */
  _newGuards() {
    return {
      callSignatures: new Map(), // "tool|stableArgsJson" -> count
      retryableErrors: 0,
    };
  }

  /** 返回 null=正常；返回字符串=终止原因（LOOP_DETECTED） */
  _checkLoop(guards, name, args) {
    const key = `${name}|${stableStringify(args)}`;
    const count = (guards.callSignatures.get(key) || 0) + 1;
    guards.callSignatures.set(key, count);
    if (count >= LOOP_THRESHOLD) {
      return `检测到死循环: ${name}(${JSON.stringify(args)}) 重复调用 ${LOOP_THRESHOLD} 次`;
    }
    return null;
  }

  async run(userInput) {
    const messages = [
      { role: "system", content: "你是助手，可调用工具获取实时信息。" },
      { role: "user", content: userInput },
    ];
    const guards = this._newGuards();

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const msg = await this.llm(messages, this.registry.getSchemas());
      messages.push(msg);

      const toolCalls = msg.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        let loopTripped = false;
        for (const tc of toolCalls) {
          const { name, arguments: rawArgs } = tc.function;

          // 解析参数（执行前也容错）
          let args = {};
          try {
            args = rawArgs ? JSON.parse(rawArgs) : {};
          } catch { /* 交给 registry 兜底 */ }

          // ── 防失控检查 ──
          const loopReason = loopTripped ? null : this._checkLoop(guards, name, args);

          let result;
          if (loopTripped || loopReason) {
            // 已判定死循环：跳过本轮剩余调用，但每个 tool_call_id 都必须回填一条 tool 消息 ——
            // assistant(tool_calls) 与 tool 消息不成对，下一轮请求会被服务端 400 拒绝。
            result = {
              error: {
                code: ErrorCode.LOOP_DETECTED,
                message: loopReason || "本轮已判定死循环，跳过剩余工具调用。",
              },
            };
            loopTripped = true;
          } else {
            result = await this.registry.execute(name, rawArgs);
            if (this.verbose) {
              console.log(`  [tool] ${name}(${rawArgs}) -> ${JSON.stringify(result)}`);
            }
          }

          // ── 错误预算 ──
          const err = result.error;
          if (err && err.retryable) {
            guards.retryableErrors += 1;
            if (guards.retryableErrors >= ERROR_BUDGET) {
              result.error = {
                code: ErrorCode.ERROR_BUDGET_EXHAUSTED,
                message: "重试预算耗尽，请放弃该方案，换一种方法。",
              };
            }
          }

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }
        continue; // 本轮结束，进入下一轮推理
      }

      const content = (msg.content || "").trim();
      if (content) return content;
      messages.push({ role: "user", content: NUDGE });
    }

    return "【达到最大轮数，任务未完成】";
  }
}
