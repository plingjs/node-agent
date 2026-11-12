/**
 * lesson03-context · 工具集（完整工具系统 + 大结果截断演示）
 *
 * 五个工具覆盖两类能力：
 *   get_weather / list_notes / write_note / delete_note
 *     → 演示 lesson02 的权限分级（read/write/danger）+ 完整流水线
 *   search_logs
 *     → 演示 lesson03 的工具结果截断（返回几 MB 日志）
 */

import { executionFailed } from "./errors.js";
import { createFullRegistry } from "./registry_full.js";

/** 演示用的"笔记存储"（真实系统是文件/数据库） */
export const NOTES = new Map();

/** 构建带完整流水线的注册表（confirm 由调用方注入） */
export function buildRegistry(confirm = null) {
  const r = createFullRegistry(confirm);

  r.register(
    {
      name: "get_weather",
      description: "查询指定城市的当前天气。",
      params: {
        type: "object",
        properties: { city: { type: "string", description: "城市名，如 北京" } },
        required: ["city"],
      },
      fn: async ({ city }) => {
        const fake = { 北京: "晴 25°C", 上海: "多云 28°C", 深圳: "小雨 30°C" };
        if (!(city in fake)) throw executionFailed(`没有 ${city} 的天气数据`);
        return { city, weather: fake[city] };
      },
    },
    "read",
  );

  r.register(
    {
      name: "list_notes",
      description: "列出所有已保存的笔记标题。",
      params: { type: "object", properties: {} },
      fn: async () => [...NOTES.keys()],
    },
    "read",
  );

  r.register(
    {
      name: "search_logs",
      description: "搜索系统日志（可能返回大量内容）。",
      params: {
        type: "object",
        properties: { keyword: { type: "string" } },
        required: ["keyword"],
      },
      fn: async ({ keyword }) => {
        const line = `[2026-07-28] INFO request handled keyword=${keyword} trace_id=${Math.random()}`;
        return Array.from({ length: 10000 }, (_, i) => `${line} #${i}`).join("\n");
      },
    },
    "read",
  );

  r.register(
    {
      name: "write_note",
      description: "保存一条笔记。title 是标题，content 是正文。",
      params: {
        type: "object",
        properties: { title: { type: "string" }, content: { type: "string" } },
        required: ["title", "content"],
      },
      fn: async ({ title, content }) => {
        NOTES.set(title, content);
        return `已保存笔记: ${title}`;
      },
    },
    "write",
  );

  r.register(
    {
      name: "delete_note",
      description: "删除一条笔记。不可恢复，请谨慎操作。",
      params: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      fn: async ({ title }) => {
        if (!NOTES.has(title)) throw executionFailed(`笔记不存在: ${title}`);
        NOTES.delete(title);
        return `已删除笔记: ${title}`;
      },
    },
    "danger",
  );

  return r;
}
