/**
 * 第2课 · v2: validation —— 参数校验（Node 版）
 *
 * 依据工具定义的 params（JSON Schema）在路由前校验。
 * 校验错误在进入工具函数前拦截，错误信息面向 LLM 可行动。
 *
 * 面试点：LLM 参数幻觉率不低（缺参/类型错/枚举值不存在），
 * 校验层是 Agent 稳定性的第一道防线。
 */

import { invalidParams } from "./errors.js";

/**
 * 按 schema 校验并规范化参数。
 * 规则：
 *  1. 必填缺失 → 报错（列出缺了谁）
 *  2. 类型不匹配 → 宽容转换（"3"→3, 3.0→3, 3→"3"）或报错
 *  3. 未知参数 → 拒绝，避免模型传入未声明字段
 * @param {Object} params - 工具声明的 JSON Schema
 * @param {Object} args - LLM 传的参数
 * @returns {Object} 校验后的参数（抛 ToolError 表示不合法）
 */
export function validateParams(params, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw invalidParams("参数必须是 JSON 对象");
  }

  const properties = params.properties || {};
  const required = params.required || [];
  const errors = [];

  // 1. 必填检查
  for (const name of required) {
    if (!(name in args)) {
      const type = properties[name]?.type || "string";
      errors.push(`缺少必填参数 \`${name}\`（期望类型: ${type}）`);
    }
  }

  // 2. 类型检查 + 宽容转换（只处理已提供的参数）
  for (const [name, value] of Object.entries(args)) {
    const schema = properties[name];
    if (!schema) {
      errors.push(`收到未知参数: ${name}，请只使用工具声明的参数`);
      continue;
    }
    const converted = coerce(schema.type, value);
    if (converted === undefined && value !== undefined) {
      errors.push(`参数 \`${name}\` 期望 ${schema.type}，收到: ${JSON.stringify(value)}`);
    } else {
      args[name] = converted;
    }
  }

  if (errors.length > 0) throw invalidParams(errors.join("; "));
  return args;
}

/**
 * 类型宽容转换。返回 undefined 表示无法转换（不合法）。
 * 模型常见错误：整数传成 "3" 或 3.0、数字传成字符串。
 */
function coerce(type, value) {
  switch (type) {
    case "integer":
      if (typeof value === "boolean") return undefined;
      if (typeof value === "number" && Number.isSafeInteger(value)) return value;
      if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
        const converted = Number(value);
        return Number.isSafeInteger(converted) ? converted : undefined;
      }
      return undefined;
    case "number":
      if (typeof value === "boolean") return undefined;
      if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
      if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) {
        const converted = Number(value);
        return Number.isFinite(converted) ? converted : undefined;
      }
      return undefined;
    case "string":
      if (typeof value === "string") return value;
      if (typeof value === "number" && !Number.isNaN(value)) return String(value);
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "array":
      return Array.isArray(value) ? value : undefined;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
    default:
      return value; // 未知类型宽松放行
  }
}
