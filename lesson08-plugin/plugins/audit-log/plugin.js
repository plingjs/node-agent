/**
 * lesson08 · audit-log 插件 —— 安全审计插件（真实价值的示例）
 *
 * 解决的问题（企业合规 + 安全 + 成本分析的真实需求）：
 *   1. 合规审计：Agent 让系统干了什么必须留痕（谁/何时/调了什么/结果如何）
 *   2. 安全拦截：危险命令在 PreToolUse 拦截（规则可配置）
 *   3. 敏感脱敏：参数里的 token/password 打码，防止日志泄漏凭据
 *   4. 使用统计：每个工具的调用/错误/拦截次数 —— 成本与质量分析的基础
 *
 * 设计（可插拔）：
 *   install(hooks) 注册钩子，返回卸载函数（插件系统标准接口）
 *   query()  查询审计记录（限流 + 按工具过滤）
 *   summary() 生成使用统计
 *
 * 对应真实产品：LangSmith/Arize 的 trace 层、企业合规审计系统的 Agent 版
 */

import { appendFileSync } from "node:fs";
import { HookEvent } from "../../hooks/hook_registry.js";

/** 参数中这些字段视为敏感信息 → 脱敏 */
const SENSITIVE_KEYS = ["password", "secret", "token", "api_key", "apikey", "credential"];

/** 参数脱敏：敏感字段打码 + 超长截断 */
function maskValue(value, key = "") {
  if (SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s))) return "***";
  if (typeof value === "string") {
    return value.length > 100 ? `${value.slice(0, 100)}...（截断）` : value;
  }
  if (Array.isArray(value)) return value.map((item) => maskValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        maskValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

function maskArgs(args) {
  return maskValue(args || {});
}

/**
 * 创建审计插件实例。
 * @param {Object} [opts]
 * @param {string} [opts.logFile] 审计日志文件路径（默认 audit.log）
 * @param {Array<{tool:string, field:string, pattern:RegExp, reason:string}>} [opts.dangerRules]
 * @param {Function} [opts.now] 时间戳函数（测试注入）
 */
export function createAuditLogPlugin({
  logFile = "audit.log",
  dangerRules = [],
  now = () => Date.now(),
} = {}) {
  /** 内存审计记录（同时追加写文件，双通道：可查可留档） */
  const records = [];

  function record(entry) {
    records.push(entry);
    const line = JSON.stringify({ ts: now(), ...entry });
    try {
      appendFileSync(logFile, line + "\n"); // 写失败不影响主流程
    } catch {
      /* 日志写失败静默 */
    }
  }

  // ── PreToolUse：拦截 + 留痕 ──
  async function preToolUse({ name, args }) {
    // 1. 危险规则拦截（可配置，如 rm -rf / shutdown / fork bomb）
    for (const rule of dangerRules) {
      if (name === rule.tool) {
        const value = String(args?.[rule.field] || "");
        if (rule.pattern.test(value)) {
          record({ event: "blocked", name, reason: rule.reason, args: maskArgs(args) });
          return { blocked: true, reason: `[audit-log] ${rule.reason}` };
        }
      }
    }
    // 2. 调用留痕（参数已脱敏）
    record({ event: "call", name, args: maskArgs(args) });
  }

  // ── PostToolUse：结果留痕 ──
  async function postToolUse({ name, result }) {
    record({
      event: "result",
      name,
      status: result?.error ? "error" : "ok",
      errorCode: result?.error?.code || undefined,
      // 工具结果可能包含密钥、个人信息或文件内容；审计日志只记录状态，不存原文。
    });
  }

  /** 安装到 HookRegistry，返回卸载函数 */
  function install(hooks) {
    const removers = [
      hooks.add(HookEvent.PRE_TOOL_USE, preToolUse),
      hooks.add(HookEvent.POST_TOOL_USE, postToolUse),
    ];
    return () => removers.forEach((remove) => remove());
  }

  /**
   * 查询审计记录。
   * @param {Object} [opts]
   * @param {number} [opts.limit] 最近 N 条，默认 20
   * @param {string} [opts.tool] 按工具过滤
   */
  function query({ limit = 20, tool } = {}) {
    const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
    if (safeLimit === 0) return [];
    let list = records;
    if (tool) list = list.filter((r) => r.name === tool);
    return list.slice(-safeLimit);
  }

  /** 使用统计：每个工具的 调用/错误/拦截 次数（成本分析基础） */
  function summary() {
    const byTool = {};
    for (const r of records) {
      byTool[r.name] ||= { calls: 0, errors: 0, blocked: 0 };
      if (r.event === "call") byTool[r.name].calls += 1;
      if (r.event === "result" && r.status === "error") byTool[r.name].errors += 1;
      if (r.event === "blocked") byTool[r.name].blocked += 1;
    }
    return byTool;
  }

  return { install, query, summary, records };
}

/** 从 manifest.json 加载并实例化插件（main.js 使用） */
export function loadAuditLogPlugin() {
  // 默认危险规则（与 manifest.json 一致，代码里用正则更直接）
  const dangerRules = [
    { tool: "run_shell", field: "command", pattern: /\brm\s+-rf\b/, reason: "拦截递归删除 rm -rf" },
    { tool: "run_shell", field: "command", pattern: /\bshutdown\b/, reason: "拦截关机命令" },
    { tool: "run_shell", field: "command", pattern: /:\(\)\s*\{/, reason: "拦截 fork bomb" },
  ];
  return createAuditLogPlugin({ logFile: "audit.log", dangerRules });
}
