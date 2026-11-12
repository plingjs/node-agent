/**
 * 第3课 · v1: token_counter —— Token 估算（Node 版）
 *
 * 为什么 Agent 框架必须会"数 token"？
 *   context window 是按 token 算的，不是按消息条数或字符数。
 *   不知道每条消息多少 token，就无法做预算管理、无法判断何时压缩。
 *
 * 精确做法：用 tokenizer（如 tiktoken，BPE 分词）逐 token 计数。
 * 零依赖近似：区分 CJK 与非 CJK 字符 ——
 *   中文/日文/韩文：一个汉字 ≈ 1 token
 *   英文等：约 4 字符 ≈ 1 token（GPT 系经验值）
 * 误差 10~20%，够做预算管理用（我们只需"是否接近上限"，不需精确到个位）。
 */

/** 判断是否中日韩统一表意/假名/谚文字符 */
function isCJK(ch) {
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0xac00 && code <= 0xd7af) // 韩文谚文
  );
}

/** 估算一段文本的 token 数 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCJK(ch)) cjk += 1;
    else other += 1;
  }
  // 中文每字 1 token，其余每 4 字符 1 token
  return cjk + Math.ceil(other / 4);
}

/** 估算单条消息的 token（含 role 与结构开销） */
export function estimateMessageTokens(msg) {
  let tokens = 4; // role 标记等固定开销（近似）
  if (typeof msg.content === "string") {
    tokens += estimateTokens(msg.content);
  }
  if (msg.tool_calls) {
    tokens += estimateTokens(JSON.stringify(msg.tool_calls));
  }
  if (msg.tool_call_id) {
    tokens += 8; // tool 消息的 id + name 开销
  }
  return tokens;
}

/** 估算整个消息列表的总 token */
export function countTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
