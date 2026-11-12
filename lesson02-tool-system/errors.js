/**
 * 第2课 · v3: errors —— 结构化错误分层（Node 版）
 *
 * 只靠 message 字符串无法支撑生产：日志分类、重试决策、监控统计
 * 都需要机器可读的错误码。对应 Qwen Code 的 ToolErrorType：
 * INVALID_TOOL_PARAMS / TOOL_NOT_REGISTERED / EXECUTION_DENIED ...
 */

/** 错误码常量（单一事实来源，日志/监控/测试都引用它） */
export const ErrorCode = {
  INVALID_PARAMS: "INVALID_PARAMS",       // 参数不合法，模型需修正（不可重试）
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",       // 模型幻觉了工具名（不可重试）
  EXECUTION_FAILED: "EXECUTION_FAILED",   // 执行失败（可标记 retryable）
  PERMISSION_DENIED: "PERMISSION_DENIED", // 权限拒绝（不可重试）
  LOOP_DETECTED: "LOOP_DETECTED",                 // 死循环检测（框架级）
  ERROR_BUDGET_EXHAUSTED: "ERROR_BUDGET_EXHAUSTED", // 重试预算耗尽（框架级）
};

/**
 * 工具错误类
 * @param {string} code    机器可读错误码
 * @param {string} message 面向 LLM 的可操作提示（不是堆栈！）
 * @param {boolean} retryable 网络超时=可重试，参数错误=不可重试
 */
export class ToolError extends Error {
  constructor(code, message, retryable = false, detail = undefined) {
    super(`[${code}] ${message}`);
    this.name = "ToolError";
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }

  /** 转成回传给 LLM 的结构化结果（错误对模型可见，可行动） */
  toResult() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        detail: this.detail,
      },
    };
  }
}

export function invalidParams(message) {
  return new ToolError(
    ErrorCode.INVALID_PARAMS,
    `工具参数不合法: ${message}。请检查工具 schema 后修正参数再试。`,
  );
}

export function toolNotFound(name) {
  return new ToolError(
    ErrorCode.TOOL_NOT_FOUND,
    `工具 \`${name}\` 不存在。请只使用系统提供的工具。`,
  );
}

export function executionFailed(message, retryable = false) {
  return new ToolError(ErrorCode.EXECUTION_FAILED, `工具执行失败: ${message}`, retryable);
}

export function permissionDenied(name, reason) {
  return new ToolError(
    ErrorCode.PERMISSION_DENIED,
    `工具 \`${name}\` 被拒绝: ${reason}`,
  );
}
