/**
 * lesson04 · 核心工具：文件系统（read_file / write_file / list_files）
 *
 * 感知层 + 执行层的基础。Agent 要理解代码库、改文件、探索目录，
 * 全靠这三个工具。对应 Qwen Code 的 read-file / write-file / ls。
 */

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * 读文件（限文本，超大文件提示用 offset/limit 分页）。
 * @param {string} filePath 绝对或相对路径
 */
export async function readFile_(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    // 面试点：大文件直接读会打爆 context，这里提示分页读
    if (content.length > 50000) {
      return {
        filePath,
        truncated: true,
        size: content.length,
        head: content.slice(0, 2000),
        hint: "文件过大，请使用 run_shell 的 head/sed 分页读取",
      };
    }
    return { filePath, content };
  } catch (e) {
    return { filePath, error: e.message };
  }
}

/**
 * 写文件（自动建父目录）。
 * @param {string} filePath
 * @param {string} content
 */
export async function writeFile_(filePath, content) {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return { filePath, written: true, bytes: Buffer.byteLength(content) };
  } catch (e) {
    return { filePath, error: e.message };
  }
}

/**
 * 列目录（返回文件/子目录，含类型标记）。
 * @param {string} dirPath
 */
export async function listFiles(dirPath) {
  try {
    const entries = await readdir(dirPath);
    const result = [];
    for (const name of entries) {
      const full = path.join(dirPath, name);
      const s = await stat(full).catch(() => null);
      result.push({ name, type: s?.isDirectory() ? "dir" : "file" });
    }
    return { dirPath, entries: result };
  } catch (e) {
    return { dirPath, error: e.message };
  }
}
