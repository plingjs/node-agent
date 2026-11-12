/**
 * 第3课 · LLM 调用层（Node 版）
 * 从同级 env.json 读取配置（不提交 git），缺失时 fallback 环境变量。
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
    // env.json 不存在 → 用环境变量
  }
  return {
    apiKey: config.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "",
    baseUrl:
      config.OPENAI_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://api.openai.com/v1",
    model: (config.OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini").trim(),
  };
}

const cfg = loadConfig();

/** 导出配置（streaming/retry/telemetry 复用） */
export function getConfig() {
  return { ...cfg };
}

export async function call_llm(messages, tools, { timeoutMs = 60000 } = {}) {
  const body = { model: cfg.model, messages };
  if (tools) body.tools = tools;

  // 超时控制：LLM 挂起不无限等待（超时抛可识别错误，由上层决定重试/降级）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LLM API ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    return data.choices[0].message;
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`LLM 调用超时（${timeoutMs}ms）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
