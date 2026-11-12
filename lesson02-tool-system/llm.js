/**
 * 第2课 · LLM 调用层（Node 版）
 * 从同级 env.json 读配置（不提交 git），文件缺失时 fallback 环境变量，再 fallback 默认值。
 * 用 Node 18+ 内置 fetch，零依赖。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadConfig() {
  const envPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "env.json",
  );
  let config = {};
  try {
    config = JSON.parse(readFileSync(envPath, "utf8"));
  } catch {
    // env.json 不存在（或不合法 JSON）→ 退到环境变量
  }
  return {
    apiKey: config.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "",
    baseUrl:
      config.OPENAI_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://api.openai.com/v1",
    // model 必须 trim：手填的配置常带尾空格，会导致 404/400
    model: (config.OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini").trim(),
  };
}

const cfg = loadConfig();

export async function call_llm(messages, tools) {
  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      tools,
    }),
  });

  if (!response.ok) {
    // 面试点：生产必须处理 429 退避重试 / 5xx 熔断 / fallback 模型（第13课）
    throw new Error(`LLM API ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.choices[0].message;
}
