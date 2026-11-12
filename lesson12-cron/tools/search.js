/**
 * lesson04 · 核心工具：search_files（本地搜索：grep + glob）
 *
 * 感知层的核心 —— Agent 探索代码库的第一工具。
 * 对应 Qwen Code 的 grep / glob（ripgrep 驱动）。
 *
 * 零依赖实现：递归遍历目录，对文本文件内容做正则匹配，
 * 支持文件名通配符过滤 + 结果条数上限。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** 匹配结果 */
function toMatch(line, lineNo, filePath) {
  return { file: filePath, line: lineNo, text: line.trim() };
}

/**
 * 递归搜索目录下匹配正则的文件内容。
 * @param {string} pattern 正则或字面量（字面量会转义）
 * @param {Object} [options]
 * @param {string} [options.dir] 搜索根目录，默认当前目录
 * @param {string} [options.fileGlob] 文件名通配（如 "*.js"），默认全部
 * @param {number} [options.limit] 最多返回条数，默认 50
 * @param {boolean} [options.regex] true 时按正则搜索；默认按字面量搜索
 * @returns {Promise<Object>} { matches, count }
 */
export async function searchFiles(pattern, { dir = ".", fileGlob = "*", limit = 50, regex = false } = {}) {
  const matches = [];
  let scanned = 0;

  // 文件名 glob 转正则（简化版：* → .*，? → .）
  const globRe = new RegExp(
    "^" + fileGlob.split("*").map(escapeRe).join(".*").replace(/\?/g, ".") + "$",
  );

  // 默认按字面量匹配，避免括号、点号等字符被误当成正则语法。
  // 用户显式设置 regex=true 时才解析正则；非法正则会明确报错。
  const contentRe = regex ? new RegExp(pattern) : new RegExp(escapeRe(pattern));

  async function walk(dirPath) {
    let entries;
    try {
      entries = await readdir(dirPath);
    } catch {
      return; // 无权限/不存在目录，跳过
    }
    for (const name of entries) {
      if (matches.length >= limit) return;
      const full = path.join(dirPath, name);
      const s = await stat(full).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) {
        // 跳过 node_modules / .git（性能与噪音）
        if (name === "node_modules" || name === ".git") continue;
        await walk(full);
      } else if (globRe.test(name)) {
        scanned += 1;
        try {
          const content = await readFile(full, "utf8");
          content.split("\n").forEach((line, i) => {
            if (matches.length < limit && contentRe.test(line)) {
              matches.push(toMatch(line, i + 1, full));
            }
          });
        } catch {
          // 二进制/不可读文件跳过
        }
      }
    }
  }

  await walk(dir);
  return { pattern, matches, count: matches.length, scannedFiles: scanned };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
