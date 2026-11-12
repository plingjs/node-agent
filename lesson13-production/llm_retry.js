/**
 * lesson13 · llm_retry —— LLM 调用可靠性（重试 + 熔断）
 *
 * 生产 Agent 的 LLM 调用必须能扛住瞬时故障：
 *   - 可重试错误：429 限流 / 5xx 服务器 / 网络超时 → 指数退避重试
 *   - 不可重试错误：400 参数错 / 401 鉴权错 → 直接抛，重试无意义
 *   - 熔断器：连续失败 N 次 → 短路（不再发请求），冷却后恢复
 *
 * 面试点：重试要"分类"（不是所有错误都重试）、要"退避"（不是立刻重试）、
 * 要"熔断"（不是无限重试）——三者是调用层可靠性的标准三件套。
 */

/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** 携带重试信息的错误类型 */
export class LlmError extends Error {
  constructor(message, { status = null, retryable = false, cause } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/** 错误分类：判断是否可重试 */
export function isRetryable(err) {
  if (err instanceof LlmError) return err.retryable;
  // 网络错误（TypeError: fetch failed / ETIMEDOUT）→ 可重试
  if (err instanceof TypeError && /fetch failed|failed to fetch/i.test(err.message)) return true;
  const code = err?.code || err?.cause?.code;
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return true;
  }
  return false;
}

/** 熔断器：连续失败 → 短路 → 冷却后半开 → 成功则关闭 */
export class CircuitBreaker {
  constructor({ failureThreshold = 5, cooldownMs = 30000, now = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.failures = 0;
    this.state = "closed"; // closed(正常) | open(短路) | half_open(试探)
    this.openedAt = 0;
  }

  /** 调用前检查：熔断则拒绝 */
  beforeCall() {
    if (this.state === "open") {
      // 冷却期结束 → 半开试探
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half_open";
        return true;
      }
      return false; // 仍在冷却
    }
    // 冷却结束后只放行一个探测请求，其他并发请求等探测结果。
    if (this.state === "half_open") return false;
    return true;
  }

  onSuccess() {
    this.failures = 0;
    this.state = "closed";
  }

  onFailure() {
    this.failures += 1;
    if (this.state === "half_open" || this.failures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  get status() {
    return { state: this.state, failures: this.failures };
  }
}

/**
 * 包装 LLM 函数：重试 + 熔断。
 * @param {Function} fn 原始 LLM 调用（可能抛错）
 * @param {Object} [opts]
 * @param {number} [opts.maxRetries] 最多重试次数，默认 3
 * @param {number} [opts.baseDelayMs] 初始退避，默认 500（测试传小值）
 * @param {CircuitBreaker} [opts.breaker]
 * @param {Function} [opts.onRetry] 重试回调（观测用）
 * @returns {Function} 包装后的 LLM 函数
 */
export function withRetry(fn, {
  maxRetries = 3,
  baseDelayMs = 500,
  breaker = new CircuitBreaker(),
  onRetry = null,
} = {}) {
  return async (...args) => {
    if (!breaker.beforeCall()) {
      throw new LlmError(`熔断器已短路（${breaker.status.state}），拒绝调用`, {
        retryable: false,
      });
    }

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn(...args);
        breaker.onSuccess();
        return result;
      } catch (err) {
        lastError = err;
        breaker.onFailure();

        // 不可重试 → 直接抛
        if (!isRetryable(err)) throw err;
        // 达到重试上限 → 抛最后一个错误
        if (attempt >= maxRetries) break;

        // 指数退避 + jitter（防惊群）
        const delay = baseDelayMs * 2 ** attempt + Math.random() * 100;
        if (onRetry) onRetry({ attempt, err, delayMs: delay });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  };
}

/** 便捷：HTTP 状态码 → LlmError（llm.js 集成用） */
export function errorFromStatus(status, message) {
  return new LlmError(message, {
    status,
    retryable: RETRYABLE_STATUS.has(status),
  });
}
