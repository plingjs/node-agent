/**
 * lesson08 · v4: hook_registry —— Hooks 生命周期（Plugin 扩展点）
 *
 * Plugin 的"代码扩展"本质 = 在 Agent 生命周期挂钩子。
 * 对应 Qwen Code 的 hooks/ 系统（PreToolUse / PostToolUse / SessionStart...）。
 *
 * 本课实现两个最常用的钩子：
 *   PreToolUse   工具执行前 —— 可拦截（审计/权限/安全检查）
 *   PostToolUse  工具执行后 —— 可改写结果（后处理/统计/脱敏）
 *
 * 注册机制：add(event, fn) → 返回移除函数（插件卸载用）。
 * 触发语义：按注册顺序依次执行；pre 钩子返回 {blocked} 则中断执行。
 */

export const HookEvent = {
  PRE_TOOL_USE: "preToolUse",
  POST_TOOL_USE: "postToolUse",
};

export class HookRegistry {
  constructor() {
    /** event -> [fn, ...] */
    this.hooks = {
      [HookEvent.PRE_TOOL_USE]: [],
      [HookEvent.POST_TOOL_USE]: [],
    };
  }

  /**
   * 注册钩子。
   * @param {string} event
   * @param {Function} fn
   *   pre: async (payload) => { return { blocked: true, reason } } 可拦截
   *       或返回 undefined 放行
   *   post: async (payload) => payload 可改写 result
   * @returns {Function} 移除函数（插件卸载）
   */
  add(event, fn) {
    if (!this.hooks[event]) throw new Error(`未知钩子事件: ${event}`);
    this.hooks[event].push(fn);
    return () => {
      const i = this.hooks[event].indexOf(fn);
      if (i >= 0) this.hooks[event].splice(i, 1);
    };
  }

  /** 触发 pre 钩子；返回 { blocked, reason } 表示被拦截 */
  async firePreToolUse(payload) {
    for (const fn of this.hooks[HookEvent.PRE_TOOL_USE]) {
      const result = (await fn(payload)) || {};
      if (result.blocked) {
        return { blocked: true, reason: result.reason || "被钩子拦截" };
      }
    }
    return { blocked: false };
  }

  /** 触发 post 钩子；可依次改写 payload.result */
  async firePostToolUse(payload) {
    for (const fn of this.hooks[HookEvent.POST_TOOL_USE]) {
      await fn(payload);
    }
    return payload;
  }
}
