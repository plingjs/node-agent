/**
 * lesson07 · v5: agent —— 主 Agent（继承 lesson06 + Skill 注入）
 *
 * 能力面（对应 Qwen Code）：
 *   工具 coreToolScheduler + 防失控 LoopDetection + 压缩 compaction
 *   + 记忆 memory/recall + 委派 subagents + 技能 SkillTool/Activation
 *
 * Skill 集成点（两处）：
 *   ① system prompt 尾部注入"可用技能清单"（Agent 可主动调 skill 工具）
 *   ② 用户输入自动匹配技能 → 注入"已加载技能"指导（skill_trigger）
 */

import { TieredContextManager, truncateToolResult } from "./context_manager_v2.js";
import { createDelegateTool } from "./agent_tool.js";
import { SkillRegistry } from "./skill_registry.js";
import { createSkillTool, buildAvailableSkillsPrompt } from "./skill_tool.js";
import { matchSkillsForInput, buildSkillInjection } from "./skill_trigger.js";

const MAX_TURNS = 10;
const LOOP_THRESHOLD = 3;
const ERROR_BUDGET = 4;
const NUDGE = "请直接给出最终回答，不要再调用工具。";

export class Agent {
  /**
   * @param {Object} opts
   * @param {Function} opts.llm
   * @param {import("./memory_manager.js").MemoryManager} opts.memory
   * @param {Object} opts.registry buildCoreTools() 返回
   * @param {string} opts.systemPrompt
   * @param {number} [opts.maxDepth]
   * @param {SkillRegistry} [opts.skills] 注入的 SkillRegistry（默认新建并加载）
   */
  constructor({
    llm,
    memory,
    registry,
    systemPrompt,
    maxDepth = 2,
    skills = null,
    verbose = false,
  }) {
    this.llm = llm;
    this.memory = memory;
    this.registry = registry;
    this.systemPrompt = systemPrompt;
    this.maxDepth = maxDepth;
    this.verbose = verbose;
    this.cm = this._newContext();
    this.skills = skills || new SkillRegistry();
    this.skillsLoaded = false;

    // 注册委派工具（lesson06）
    this.registry.register(
      createDelegateTool({
        llm,
        registry,
        depth: 0,
        maxDepth,
        getParentContext: () => this.cm.recent,
        verbose,
      }),
      "write",
    );
    // 注册技能加载工具（lesson07）：Agent 可主动调 skill("xxx")
    this.registry.register(createSkillTool(this.skills), "read");
  }

  /** 确保技能已加载（懒加载，首次 run 前） */
  async _ensureSkills() {
    if (!this.skillsLoaded) {
      await this.skills.load();
      this.skillsLoaded = true;
    }
  }

  _newContext() {
    return new TieredContextManager({
      maxTokens: 40960,
      reserveForOutput: 5120,
      compactRatio: 0.8,
      keepRecent: 6,
    });
  }

  reset() {
    this.cm = this._newContext();
  }

  _newGuards() {
    return { callSignatures: new Map(), retryableErrors: 0 };
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
    await this._ensureSkills();

    // ① 记忆注入（lesson05）+ 技能自动匹配注入（lesson07）+ 可用技能清单
    const [recalled, matchedSkills] = await Promise.all([
      this.memory.recall(userInput),
      matchSkillsForInput(userInput, this.skills),
    ]);
    const injected =
      this.memory.formatRecall(recalled) +
      buildSkillInjection(matchedSkills) +
      buildAvailableSkillsPrompt(this.skills);
    this.cm.setSystem([
      { role: "system", content: this.systemPrompt + injected },
    ]);

    this.cm.append({ role: "user", content: userInput });
    const guards = this._newGuards();

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.cm.needsCompaction()) {
        if (this.verbose) console.log("  [compaction] 压缩历史...");
        await this.cm.compact(this.llm);
      }

      const schemas = this.registry.getSchemas();
      const msg = await this.llm(this.cm.build(), schemas);
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
