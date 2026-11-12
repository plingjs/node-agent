/**
 * lesson06 · v5: parallel —— 并行委派 + 结果汇聚
 *
 * 多个独立子任务可以并行执行（对应 Qwen Code 的 runConcurrently，上限 10）。
 * 简单并发池：同时最多跑 maxConcurrent 个子 Agent，全部完成后汇聚结果。
 *
 * 面试点：
 *   - 并行委派的收益：多个独立子任务总耗时 ≈ 最慢的那个（而不是累加）
 *   - 成本控制：并发上限（防一次性启动 N 个子 Agent 烧钱/抢资源）
 *   - 什么时候不该并行：任务间有依赖、共享可变状态时
 */

import { SubAgent } from "./subagent.js";
import { canDelegate, depthLimitMessage } from "./depth_guard.js";

/**
 * 并行委派多个子任务。
 * @param {Object} opts
 * @param {Function} opts.llm
 * @param {Object} opts.registry
 * @param {Array<{task: string, tools?: string[]}>} opts.tasks
 * @param {number} [opts.maxConcurrent] 并发上限，默认 3
 * @param {number} [opts.depth] 当前深度
 * @param {number} [opts.maxDepth]
 * @param {boolean} [opts.verbose]
 * @returns {Promise<Array<string>>} 按 tasks 顺序返回的结果数组
 */
export async function delegateParallel({
  llm,
  registry,
  tasks,
  maxConcurrent = 3,
  depth = 0,
  maxDepth = 2,
  verbose = false,
}) {
  // 前置深度检查（v2.1 补）：越界直接拒绝全部任务，不创建子 Agent
  if (!canDelegate(depth, maxDepth)) {
    return tasks.map(() => `【委派被拒绝】${depthLimitMessage(maxDepth)}`);
  }

  const results = new Array(tasks.length);
  let next = 0;

  // 简单并发池：每个 worker 循环取下一个任务执行
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      const { task, tools } = tasks[i];
      const sub = new SubAgent({
        llm,
        registry,
        depth: depth + 1,
        maxDepth,
        verbose,
      });
      results[i] = await sub.run(task, { tools });
    }
  }

  const workerCount = Math.min(maxConcurrent, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/** 把并行结果汇聚成父 Agent 可读的文本（v6 集成时使用） */
export function mergeResults(tasks, results) {
  return tasks
    .map((t, i) => `【子任务 ${i + 1}】${t.task}\n结果：${results[i]}`)
    .join("\n\n");
}
