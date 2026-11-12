/**
 * 第2课 · v2: registry_full —— 完整执行流水线（Node 版）
 *
 * 对比 registry.js（v1），把 v2/v3/v4 的升级串起来：
 *
 *   execute(name, argumentsStr)
 *     ├── 1. 注册表查找 → 不存在: TOOL_NOT_FOUND
 *     ├── 2. 解析参数 JSON（模型输出，容错）
 *     ├── 3. 权限决策 → 拒绝: PERMISSION_DENIED（read 放行 / write 确认 / danger 强制）
 *     ├── 4. 参数校验 → 不合法: INVALID_PARAMS（宽容转换）
 *     ├── 5. 执行工具（异常隔离）
 *     └── 6. 结构化错误返回 或 {"result": ...}
 *
 * 对应 Qwen Code coreToolScheduler._schedule() 的迷你版。
 */

import { executionFailed, invalidParams, ToolError, toolNotFound } from "./errors.js";
import { PermissionManager } from "./permissions.js";
import { validateParams } from "./validation.js";

export function createFullRegistry(confirm = null) {
  const tools = new Map();
  const permissions = new PermissionManager(confirm);

  return {
    /**
     * 注册工具（带安全等级）
     * @param {import("./registry.js").ToolDef} toolDef
     * @param {string} kind - "read" | "write" | "danger"
     * 面试点：kind 放在注册期（静态声明，审计一目了然），
     * 决策期只叠加动态用户规则 —— 声明与决策分离。
     */
    register(toolDef, kind = "read") {
      tools.set(toolDef.name, toolDef);
      permissions.setKind(toolDef.name, kind);
      return toolDef;
    },

    getSchemas() {
      return [...tools.values()].map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.params },
      }));
    },

    async execute(name, argumentsStr, { toolOverride = null } = {}) {
      // 1. 注册表查找
      const tool = toolOverride || tools.get(name);
      if (!tool) return toolNotFound(name).toResult();

      // 2. 解析参数 JSON
      let args;
      try {
        args = argumentsStr ? JSON.parse(argumentsStr) : {};
      } catch {
        return invalidParams(`参数不是合法 JSON: ${argumentsStr}`).toResult();
      }

      // 3. 权限决策
      try {
       await permissions.check(name, args);
      } catch (e) {
        if (e instanceof ToolError) return e.toResult();
        throw e;
      }

      // 4. 参数校验（基于工具声明的 schema）
      try {
        args = validateParams(tool.params, args);
      } catch (e) {
        if (e instanceof ToolError) return e.toResult();
        throw e;
      }

      // 5. 执行（异常隔离：任何异常都变结构化结果，不炸 Agent）
      try {
        const result = await tool.fn(args);
        return { result };
      } catch (e) {
        if (e instanceof ToolError) return e.toResult(); // 工具主动抛的业务错误
        // 未预期异常：细节进日志，用户消息泛化（防泄漏内部细节）
        return executionFailed(`${e.constructor.name}: ${e.message}`).toResult();
      }
    },
  };
}
