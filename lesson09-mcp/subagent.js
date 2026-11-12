/**
 * lesson06 · v1: subagent —— 子 Agent 执行器
 *
 * 子 Agent = 独立的上下文管理器（cm）+ 简化推理循环。
 * 对应 Qwen Code 的 AgentHeadless：独立上下文、跑完返回文本摘要。
 *
 * 上下文隔离（本课灵魂）：
 *   父 Agent 的 cm：     [system, user, assistant(tool_calls: delegate_task), tool(子结果)...]
 *   子 Agent 的 cm：     [system(子), user(任务)] → 推理 → 返回文本
 *                          ↑ 独立 cm —— 子 Agent 的探索过程不会塞爆父的上下文
 *
 * 工具集：默认共享父 registry，但可传白名单（tools 数组）；
 * delegate_task 默认排除（物理防递归，见 depth_guard）。
 */

import { TieredContextManager, truncateToolResult } from "./context_manager_v2.js";
import { depthLimitMessage, shouldExposeDelegateTool } from "./depth_guard.js";

const MAX_TURNS = 8;
const LOOP_THRESHOLD = 3; // 子 Agent 同工具+同参数重复 3 次判死循环（v2.1 补）
const NUDGE = "请直接给出最终结果，不要再调用工具。";

export const DEFAULT_SUBAGENT_PROMPT =
  "你是子 Agent，负责完成父 Agent 委派的独立任务。完成只属于你的任务，" +
  "不要扩展范围。使用工具获取信息，最后用简洁文本汇报结果（含关键证据）。";

export class SubAgent {
  /**
   * @param {Object} opts
   * @param {Function} opts.llm
   * @param {Object} opts.registry 共享的工具注册表（core_tools）
   * @param {string} [opts.systemPrompt]
   * @param {number} [opts.depth] 当前嵌套深度（父=0）
   * @param {number} [opts.maxDepth] 最大深度（默认 2：父→子→孙）
   * @param {Function} [opts.delegateFactory] 生成 delegate 工具的工厂（v2 注入）
   * @param {boolean} [opts.verbose]
   */
  constructor({
    llm,
    registry,
    systemPrompt = DEFAULT_SUBAGENT_PROMPT,
    depth = 0,
    maxDepth = 2,
    delegateFactory = null,
    verbose = false,
  }) {
    this.llm = llm;
    this.registry = registry;
    this.systemPrompt = systemPrompt;
    this.depth = depth;
    this.maxDepth = maxDepth;
    this.delegateFactory = delegateFactory;
    this.verbose = verbose;
    this.cm = new TieredContextManager({
      maxTokens: 2048, // 子 Agent 预算更小（只负责一个子任务）
      reserveForOutput: 256,
      compactRatio: 0.8,
      keepRecent: 4,
    });
    this.delegateTool =
      this.delegateFactory && shouldExposeDelegateTool(this.depth, this.maxDepth)
        ? this.delegateFactory({
            depth: this.depth,
            getParentContext: () => this.cm.recent,
          })
        : null;
  }

  /** 子 Agent 的工具 schema：使用当前深度对应的委派函数。 */
  _schemas(tools) {
    let schemas = this.registry.getSchemas().filter(
      (s) => s.function.name !== "delegate_task",
    );

    if (Array.isArray(tools)) {
      schemas = schemas.filter((s) => tools.includes(s.function.name));
    }

    if (
      this.delegateTool &&
      (!Array.isArray(tools) || tools.includes("delegate_task"))
    ) {
      schemas.push({
        type: "function",
        function: {
          name: this.delegateTool.name,
          description: this.delegateTool.description,
          parameters: this.delegateTool.params,
        },
      });
    }
    return schemas;
  }
  /** Loop 检测（v2.1 补：与父 Agent 能力对齐，防子 Agent 死磕同一工具） */
  _checkLoop(guards, name, args) {
    const key = `${name}|${JSON.stringify(args)}`;
    const count = (guards.callSignatures.get(key) || 0) + 1;
    guards.callSignatures.set(key, count);
    if (count >= LOOP_THRESHOLD) {
      return `检测到死循环: ${name}(${JSON.stringify(args)}) 重复调用 ${LOOP_THRESHOLD} 次`;
    }
    return null;
  }

  /**
   * 执行委派任务。
   * @param {string} task 任务描述
   * @param {Object} [options]
   * @param {string[]} [options.tools] 工具白名单
   * @param {Array<Object>} [options.parentContext] fork 模式：继承的父上下文
   * @returns {Promise<string>} 结果文本
   */
  async run(task, { tools, parentContext } = {}) {
    const system = this.systemPrompt;
    this.cm.setSystem([{ role: "system", content: system }]);

    // fork 模式：把父的近期上下文作为一条 user 消息注入（v4）
    if (parentContext && parentContext.length > 0) {
      this.cm.append({
        role: "user",
        content: `[继承的父对话上下文，仅作背景参考]\n${JSON.stringify(parentContext)}`,
      });
    }
    this.cm.append({ role: "user", content: task });
    const guards = { callSignatures: new Map() };

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.cm.needsCompaction()) {
        await this.cm.compact(this.llm);
      }

      const schemas = this._schemas(tools);
      const msg = await this.llm(this.cm.build(), schemas);
      this.cm.append(msg);

      const toolCalls = msg.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        let loopDetected = false;
        for (const tc of toolCalls) {
          const { name, arguments: rawArgs } = tc.function;

          let args = {};
          try {
            args = rawArgs ? JSON.parse(rawArgs) : {};
          } catch { /* 交给 registry 兜底 */ }

          // Loop 检测（v2.1 补）：判定死循环后，同一条响应里剩下的 tool_calls
          // 不再执行，但仍逐条回填 role="tool"（配对断了下一轮 API 报 400）
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

          let result;
          if (name === "delegate_task") {
            result = this.delegateTool
              ? await this.registry.execute(name, rawArgs, { toolOverride: this.delegateTool })
              : { error: { code: "DEPTH_LIMIT", message: depthLimitMessage(this.maxDepth) } };
          } else {
            result = await this.registry.execute(name, rawArgs);
          }
          const content = truncateToolResult(JSON.stringify(result));
          if (this.verbose) {
            console.log(`  [子Agent#${this.depth}] [tool] ${name} -> ${content.slice(0, 60)}...`);
          }
          this.cm.append({ role: "tool", tool_call_id: tc.id, content });
        }
        continue;
      }

      const content = (msg.content || "").trim();
      if (content) return content;
      this.cm.append({ role: "user", content: NUDGE });
    }
    return "【子 Agent 达到最大轮数】";
  }
}
