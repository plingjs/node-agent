/**
 * lesson06 · v6: agent —— 主 Agent（继承 lesson05 + 委派能力）
 *
 * 在 lesson05（记忆 + 核心工具 + 防失控 + 压缩）之上，
 * 主 Agent 构造时把 delegate_task 注册进 registry（depth=0），
 * 模型即可在推理中委派子任务。
 *
 * 完整能力面（对应 Qwen Code）：
 *   工具调度 coreToolScheduler + 防失控 LoopDetection + 压缩 compaction
 *   + 记忆 memory/recall + 委派 subagents（Agent Tool）
 */

import { TieredContextManager, truncateToolResult } from "./context_manager_v2.js";
import { createDelegateTool } from "./agent_tool.js";

const MAX_TURNS = 10;
const LOOP_THRESHOLD = 3;
const ERROR_BUDGET = 4;
const NUDGE = "请直接给出最终回答，不要再调用工具。";

export class Agent {
  /**
   * @param {Object} opts
   * @param {Function} opts.llm
   * @param {import("./memory_manager.js").MemoryManager} opts.memory
   * @param {Object} opts.registry buildCoreTools() 返回（构造时注入 delegate_task）
   * @param {string} opts.systemPrompt
   * @param {number} [opts.maxDepth] 委派深度上限（默认 2）
   */
  constructor({ llm, memory, registry, systemPrompt, maxDepth = 2, verbose = false }) {
    this.llm = llm;
    this.memory = memory;
    this.registry = registry;
    this.systemPrompt = systemPrompt;
    this.maxDepth = maxDepth;
    this.verbose = verbose;
    this.cm = this._newContext();

    // 主 Agent（depth=0）总是暴露 delegate_task。
    // 注意：registry 是共享的（子 Agent 也用它），depth 靠闭包传递——
    // 每个 Agent 实例注册自己的 delegate 工具，后注册的覆盖先前的。
    // 多实例共享 registry 时，最后一次 new Agent 的 depth 生效；
    // 深度风险由物理隔离兜底（子 Agent 不暴露 delegate_task），可接受。
    this.registry.register(
      createDelegateTool({
        llm,
        registry,
        depth: 0,
        maxDepth,
        getParentContext: () => this.cm.recent, // fork 模式取父近期上下文
        verbose,
      }),
      "write",
    );
  }

  _newContext() {
    return new TieredContextManager({
      maxTokens: 4096,
      reserveForOutput: 512,
      compactRatio: 0.8,
      keepRecent: 6,
    });
  }

  reset() {
    this.cm = this._newContext();
  }

  _newGuards() {
    return {
      callSignatures: new Map(),
      retryableErrors: 0,
    };
  }

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
    // ① 记忆注入（lesson05）
    const recalled = await this.memory.recall(userInput);
    const recallText = this.memory.formatRecall(recalled);
    this.cm.setSystem([
      { role: "system", content: this.systemPrompt + recallText },
    ]);

    this.cm.append({ role: "user", content: userInput });
    const guards = this._newGuards();

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.cm.needsCompaction()) {
        if (this.verbose) console.log("  [compaction] 压缩历史...");
        await this.cm.compact(this.llm);
      }

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

          const result = await this.registry.execute(name, rawArgs);

          if (result.error?.retryable) {
            guards.retryableErrors += 1;
            if (guards.retryableErrors >= ERROR_BUDGET) {
              result.error = {
                code: "ERROR_BUDGET_EXHAUSTED",
                message: "重试预算耗尽，请换一种方法。",
              };
            }
          }

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

    // ③ 异步提取（lesson05）
    this.memory.scheduleExtract(this.llm, this.cm.recent, memoryScope);

    const lastAssistant = [...this.cm.recent]
      .reverse()
      .find((m) => m.role === "assistant");
    return (lastAssistant?.content || "").trim() || "【未得到回答】";
  }
}
