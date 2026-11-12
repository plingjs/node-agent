/**
 * lesson04 · core_tools —— 高杠杆核心工具的统一注册
 *
 * 六个工具覆盖 Agent 的"感知 + 执行"两大能力：
 *   read_file / list_files / search_files  感知（read，自动执行）
 *   write_file                            执行（write，需确认）
 *   fetch_url                             联网感知（write，需确认）
 *   run_shell                             万能执行（danger，强制确认）
 *
 * 面试点：工具数量收敛到 6 个"高杠杆"，其余能力交给模型组合。
 * 对比玩具工具的 get_weather/search_logs —— 这才是真实 Agent 的手。
 */

import { createFullRegistry } from "./registry_full.js";
import { runShell } from "./tools/shell.js";
import { readFile_, writeFile_, listFiles } from "./tools/filesystem.js";
import { searchFiles } from "./tools/search.js";
import { fetchUrl } from "./tools/fetch.js";

/** 构建注册好核心工具的 registry（confirm 由调用方注入） */
export function buildCoreTools(confirm = null) {
  const r = createFullRegistry(confirm);

  r.register(
    {
      name: "read_file",
      description: "读取文本文件内容。文件过大时会提示分页读取。",
      params: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "绝对或相对路径" },
        },
        required: ["file_path"],
      },
      fn: async ({ file_path }) => readFile_(file_path),
    },
    "read",
  );

  r.register(
    {
      name: "list_files",
      description: "列出目录下的文件和子目录（不含递归）。",
      params: {
        type: "object",
        properties: {
          dir_path: { type: "string", description: "目录路径，默认当前目录" },
        },
        required: [],
      },
      fn: async ({ dir_path = "." }) => listFiles(dir_path),
    },
    "read",
  );

  r.register(
    {
      name: "search_files",
      description:
        "递归搜索目录下文件内容。默认按字面量匹配；regex=true 时按正则匹配。支持文件名通配过滤。",
      params: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "要查找的文本；regex=true 时可写正则" },
          dir: { type: "string", description: "搜索根目录，默认当前目录" },
          file_glob: { type: "string", description: "文件名通配，如 '*.js'，默认全部" },
          regex: { type: "boolean", description: "是否把 pattern 当正则处理，默认 false" },
        },
        required: ["pattern"],
      },
      fn: async ({ pattern, dir = ".", file_glob = "*", regex = false }) =>
        searchFiles(pattern, { dir, fileGlob: file_glob, regex }),
    },
    "read",
  );

  r.register(
    {
      name: "write_file",
      description: "写入文本文件（自动创建父目录，覆盖已有内容）。",
      params: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          content: { type: "string" },
        },
        required: ["file_path", "content"],
      },
      fn: async ({ file_path, content }) => writeFile_(file_path, content),
    },
    "write",
  );

  r.register(
    {
      name: "fetch_url",
      description: "GET 请求一个 URL，返回文本内容（如网页/API 响应）。",
      params: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整的 http/https URL" },
        },
        required: ["url"],
      },
      fn: async ({ url }) => fetchUrl(url),
    },
    "write",
  );

  r.register(
    {
      name: "run_shell",
      description:
        "执行 shell 命令并返回 stdout/stderr。用于运行脚本、处理数据、统计文件等。危险命令会被拦截。",
      params: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
          timeout: { type: "integer", description: "超时毫秒，默认 10000" },
        },
        required: ["command"],
      },
      fn: async ({ command, timeout }) => runShell(command, { timeout: timeout || 10000 }),
    },
    "danger",
  );

  return r;
}
