/**
 * lesson06 · v2: agent_tool —— delegate_task 委派工具
 *
 * 把"委派子 Agent"做成一个普通工具，注册进父 registry——
 * 模型在推理时像调用其他工具一样调用它（对应 Qwen Code 的 Agent Tool）。
 *
 * 设计要点：
 *   - 工厂函数：每次调用创建新的 SubAgent（depth = 父 depth + 1）
 *   - depth 从调用链传递：父(0) → 子(1) → 孙(2)，配合 depth_guard 防递归
 *   - 返回子 Agent 的文本摘要，作为 tool 结果回填父上下文
 *   - 安全等级 write（委派会启动子 Agent 消耗资源，需确认）
 *
 * v2.1 修复（code review）：
 *   - subagentPrompt 参数此前声明但未传给 SubAgent → 子 Agent prompt 无法定制
 *   - 集成 context_select：mode=fork 时通过 getParentContext 回调继承父近期上下文
 */

import { SubAgent } from "./subagent.js";
import { canDelegate, depthLimitMessage } from "./depth_guard.js";
import { CONTEXT_MODE, buildInheritedContext } from "./context_select.js";

/**
 * 创建 delegate_task 工具定义。
 * @param {Object} opts
 * @param {Function} opts.llm
 * @param {Object} opts.registry 共享工具注册表
 * @param {number} opts.depth 当前 Agent 的深度
 * @param {number} opts.maxDepth
 * @param {string} [opts.subagentPrompt] 子 Agent 的系统提示（默认见 SubAgent）
 * @param {Function} [opts.getParentContext] 返回父 Agent 近期消息的回调（fork 模式用）
 * @param {boolean} [opts.verbose]
 */
export function createDelegateTool({
  llm,
  registry,
  depth,
  maxDepth,
  subagentPrompt,
  getParentContext,
  verbose = false,
}) {
  return {
    name: "delegate_task",
    description:
      "把子任务委派给一个独立的子 Agent，等待其完成并返回结果摘要。" +
      "适合：可并行的独立子任务、需要隔离上下文的探索任务。委派有深度限制。" +
      "mode=fork 时子 Agent 继承父的近期上下文（默认 independent 只看任务）。",
    params: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "给子 Agent 的完整任务描述（包含目标、约束、需要什么证据）",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "子 Agent 可用工具白名单，如 ['search_files','read_file']；省略则全部",
        },
        mode: {
          type: "string",
          enum: ["independent", "fork"],
          description: "independent=只看任务描述；fork=继承父近期上下文作背景（默认 independent）",
        },
      },
      required: ["task"],
    },
    fn: async ({ task, tools, mode }) => {
      // ── 运行时深度兜底（v3 的第二道防线）──
      if (!canDelegate(depth, maxDepth)) {
        return { error: depthLimitMessage(maxDepth) };
      }

      if (verbose) {
        console.log(`  [delegate] 深度${depth} → 子Agent(深度${depth + 1}): ${String(task).slice(0, 50)}...`);
      }

      // fork 模式：通过回调取父 recent，用 context_select 选取继承窗口
      let parentContext = null;
      if (mode === "fork" && typeof getParentContext === "function") {
        parentContext = buildInheritedContext(
          CONTEXT_MODE.FORK,
          getParentContext(),
        );
      }

      const sub = new SubAgent({
        llm,
        registry,
        depth: depth + 1,
        maxDepth,
        systemPrompt: subagentPrompt, // v2.1 修复：此前漏传
        delegateFactory: ({ depth: childDepth, getParentContext: childContext }) =>
          createDelegateTool({
            llm,
            registry,
            depth: childDepth,
            maxDepth,
            subagentPrompt,
            getParentContext: childContext,
            verbose,
          }),
        verbose,
      });
      const result = await sub.run(task, { tools, parentContext });
      return { result, fromSubagent: true };
    },
  };
}
