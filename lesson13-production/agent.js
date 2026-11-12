/**
 * lesson08 · v5: agent —— 主 Agent（继承 lesson07 + MCP 工具 + Hooks）
 *
 * 能力面（对应 Qwen Code，全齐）：
 *   工具 coreToolScheduler + 防失控 + 压缩 + 记忆 + 委派 + 技能
 *   + MCP 外部工具（mcp__ 前缀）+ Hooks 扩展点（Pre/PostToolUse）
 *
 * Hooks 集成点（本课新增）：
 *   工具执行前：firePreToolUse —— 可拦截（返回 blocked → 错误回填给模型）
 *   工具执行后：firePostToolUse —— 可改写结果（脱敏/统计/后处理）
 */

import { TieredContextManager, truncateToolResult } from "./context_manager_v2.js";
import { createDelegateTool } from "./agent_tool.js";
import { SkillRegistry } from "./skill_registry.js";
import { createSkillTool, buildAvailableSkillsPrompt } from "./skill_tool.js";
import { matchSkillsForInput, buildSkillInjection } from "./skill_trigger.js";
import { HookRegistry, HookEvent } from "./hooks/hook_registry.js";

const MAX_TURNS = 10;
const LOOP_THRESHOLD = 3;
const ERROR_BUDGET = 4;
const NUDGE = "请直接给出最终回答，不要再调用工具。";

export class Agent {
  /**
   * @param {Object} opts
   * @param {Function} opts.llm
   * @param {import("./memory_manager.js").MemoryManager} opts.memory
   * @param {Object} opts.registry
   * @param {string} opts.systemPrompt
   * @param {number} [opts.maxDepth]
   * @param {SkillRegistry} [opts.skills]
   * @param {HookRegistry} [opts.hooks] 注入的钩子注册表（默认新建）
   */
  constructor({
    llm,
    memory,
    registry,
    systemPrompt,
    maxDepth = 2,
    skills = null,
    hooks = null,
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
    this.hooks = hooks || new HookRegistry();

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
    this.registry.register(createSkillTool(this.skills), "read");
  }

  async _ensureSkills() {
    if (!this.skillsLoaded) {
      await this.skills.load();
      this.skillsLoaded = true;
    }
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

  async run(userInput, { memoryScope = "default", extractMemory = true } = {}) {
    await this._ensureSkills();

    // ① 记忆 + 技能自动注入
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
          // 判定死循环后，同一条响应里剩下的 tool_calls 不再执行，但仍逐条回填
          // role="tool"：少回填一条，assistant(tool_calls) 与 tool 的配对就断了，
          // 下一轮请求被服务端 400 拒绝（响应里有多个 tool_calls 时才会撞上）
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

          // ── Hooks：PreToolUse（可拦截）──
          const pre = await this.hooks.firePreToolUse({ name, args, turn });
          if (pre.blocked) {
            this.cm.append({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({
                error: { code: "HOOK_BLOCKED", message: pre.reason },
              }),
            });
            if (this.verbose) console.log(`  [hook] 拦截 ${name}: ${pre.reason}`);
            continue;
          }

          const result = await this.registry.execute(name, rawArgs);

          // ── Hooks：PostToolUse（可改写结果）──
          await this.hooks.firePostToolUse({ name, args, result });

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

    if (extractMemory) {
      this.memory.scheduleExtract(this.llm, this.cm.recent, memoryScope);
    }

    const lastAssistant = [...this.cm.recent]
      .reverse()
      .find((m) => m.role === "assistant");
    return (lastAssistant?.content || "").trim() || "【未得到回答】";
  }
}
