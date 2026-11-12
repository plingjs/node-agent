/**
 * lesson04 · 核心工具：fetch_url（HTTP 请求）
 *
 * 通用"联网感知"工具 —— 让 Agent 能访问任意 URL：
 * 抓网页、调 REST API、读在线文档。对应 Qwen Code 的 web-fetch。
 *
 * 安全注意：write 级（网络请求可能产生副作用/泄露数据），注册时归 write。
 */

/**
 * GET 请求一个 URL，返回文本内容（限 2MB）。
 * @param {string} url
 * @param {Object} [options]
 * @param {number} [options.timeout] 毫秒，默认 15s
 */
export async function fetchUrl(url, { timeout = 15000 } = {}) {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { "User-Agent": "lesson04-agent/1.0" },
    });
    const reader = resp.body?.getReader();
    let text = "";
    let byteLimited = false;
    if (reader) {
      const chunks = [];
      let total = 0;
      const maxBytes = 2_000_000;
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxBytes - total;
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          total = maxBytes;
          byteLimited = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      text = decoder.decode(bytes);
    } else {
      text = await resp.text();
      byteLimited = new TextEncoder().encode(text).byteLength > 2_000_000;
    }
    const outputLimit = 10_000;
    const truncated = byteLimited || text.length > outputLimit;
    return {
      url,
      status: resp.status,
      contentType: resp.headers.get("content-type") || "",
      truncated,
      body: text.slice(0, outputLimit),
      hint: truncated ? `响应内容已截断，仅返回前 ${outputLimit} 个字符` : undefined,
    };
  } catch (e) {
    return { url, error: e.message };
  }
}
