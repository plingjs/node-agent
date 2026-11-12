/**
 * 第2课 · v2: registry_full —— 完整执行流水线（Node 版）
 *
 * 对比 registry.js（v1），把 v2/v3/v4 的升级串起来：
 *
 *   execute(name, argumentsStr)
 *     ├── 1. 注册表查找 → 不存在: TOOL_NOT_FOUND
 *     ├── 2. 解析参数 JSON（模型输出，容错）
 *     ├── 3. 参数校验与规范化 → 不合法: INVALID_PARAMS
 *     ├── 4. 权限决策 → 拒绝: PERMISSION_DENIED（read 放行 / write 确认 / danger 强制）
 *     ├── 5. 执行工具（异常隔离）
 *     └── 6. 结构化错误返回 或 {"result": ...}
 *
 * 对应 Qwen Code coreToolScheduler._schedule() 的迷你版。
 */

import { executionFailed, invalidParams, ToolError, toolNotFound } from "./errors.js";
import { Kind, PermissionManager } from "./permissions.js";
import { validateParams } from "./validation.js";

export function createFullRegistry(confirm = null) {
  const tools = new Map();
  const permissions = new PermissionManager(confirm);

  return {
    /**
     * 注册工具（带安全等级）
     * @param {import("./registry.js").ToolDef} toolDef
     * @param {string} kind - "read" | "write" | "danger"；必须显式声明
     * 面试点：kind 放在注册期（静态声明，审计一目了然），
     * 决策期只叠加动态用户规则 —— 声明与决策分离。
     */
    register(toolDef, kind) {
      if (!Object.values(Kind).includes(kind)) {
        throw new TypeError(`工具 ${toolDef.name} 必须声明有效的安全等级: read / write / danger`);
      }
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

    async execute(name, argumentsStr) {
      // 1. 注册表查找
      const tool = tools.get(name);
      if (!tool) return toolNotFound(name).toResult();

      // 2. 解析参数 JSON
      let args;
      try {
        args = argumentsStr ? JSON.parse(argumentsStr) : {};
      } catch {
        return invalidParams(`参数不是合法 JSON: ${argumentsStr}`).toResult();
      }

      // 3. 参数校验：确认界面应展示规范化后的最终参数
      try {
        args = validateParams(tool.params, args);
      } catch (e) {
        if (e instanceof ToolError) return e.toResult();
        throw e;
      }

      // 4. 权限决策：在副作用发生前，确认本次实际执行的参数
      try {
        await permissions.check(name, args);
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
        // 未预期异常：当前实现把异常类型和消息编码进结构化错误，生产环境应改为日志留细节、对外返回泛化消息。
        return executionFailed(`${e.constructor.name}: ${e.message}`).toResult();
      }
    },
  };
}
