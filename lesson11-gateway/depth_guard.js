/**
 * lesson06 · v3: depth_guard —— 防递归深度门控
 *
 * 对应 Qwen Code 的 spawnBlockReason + EXCLUDED_TOOLS_FOR_SUBAGENTS：
 *   1. 物理隔离：子 Agent 的工具列表默认不含 delegate_task（prepareTools 排除）
 *   2. 运行时兜底：即使工具暴露，执行时再检查深度（spawnBlockReason 兜底）
 *
 * 为什么两层都要？
 *   物理隔离防"模型调用不存在的工具"（幻觉工具名会被 registry 拦截）；
 *   运行时兜底防"配置漏洞/手动构造"绕过工具列表。
 */

/** 当前深度是否还能委派（执行时兜底检查） */
export function canDelegate(depth, maxDepth) {
  return depth < maxDepth;
}

/**
 * 该深度的 Agent 是否应暴露 delegate_task 工具。
 * 子 Agent 深度 = 父深度 + 1；它还能再委派 = 深度+1 < maxDepth。
 */
export function shouldExposeDelegateTool(depth, maxDepth) {
  return depth + 1 < maxDepth;
}

/** 深度限制错误信息（返回给模型，让它自己完成而不是继续委派） */
export function depthLimitMessage(maxDepth) {
  return (
    `委派深度限制：最多 ${maxDepth} 层（当前已到边界）。` +
    "请使用你自己的工具直接完成任务，不要再调用 delegate_task。"
  );
}
