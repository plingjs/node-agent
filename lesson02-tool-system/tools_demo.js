/**
 * 第2课 · 演示工具集（Node 版）
 * 对比第1课 tools.js 手写 schema —— 这里工具定义对象自带 schema，
 * 零手写协议层：name/description/params 就是协议。
 *
 * 三种安全等级各一个示例：
 *   get_weather  read    自动执行
 *   write_note   write   需确认，可"始终允许"
 *   delete_note  danger  强制确认（不给"始终允许"）
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
        properties: {
          city: { type: "string", description: "城市名，如 北京" },
        },
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
      name: "write_note",
      description: "保存一条笔记。title 是标题，content 是正文。",
      params: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
        },
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
        properties: {
          title: { type: "string" },
        },
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
