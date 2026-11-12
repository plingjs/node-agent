/**
 * lesson05 · v1: memory_store —— 记忆存储层（文件系统持久化）
 *
 * 记忆 = 文件系统上的 markdown 文件，人类可读、可 git 管理、可 inspect。
 * 对应 Qwen Code 的 memory/paths + memory/store：
 *   memories/
 *   ├── MEMORY.md              索引（每条一行：标题 + 描述）
 *   ├── user/                  用户偏好（跨项目）
 *   ├── feedback/              用户纠正/规则
 *   ├── project/               项目知识
 *   └── reference/             外部资源引用
 *
 * 记忆文件格式（frontmatter + body）：
 *   ---
 *   name: 标题
 *   description: 一行描述（召回时判断相关性）
 *   type: user
 *   ---
 *   正文
 *   Why: 为什么（判断边界条件）
 *   How to apply: 何时使用
 */

import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 记忆根目录（本课固定放课程目录下，生产是可配置路径） */
export const MEMORY_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "memories",
);

/** 四种记忆类型（对应 Qwen Code 的 AUTO_MEMORY_TYPES） */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"];

/** 记忆条目的结构 */
export const EMPTY_ENTRY = {
  name: "",
  description: "",
  type: "user",
  body: "",
};

/** 标题 → 文件名 slug（去特殊字符，限长） */
export function toSlug(title) {
  return title
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/** 记忆文件路径：memories/<type>/<slug>.md */
export function memoryPath(type, title) {
  return path.join(MEMORY_ROOT, type, `${toSlug(title)}.md`);
}

/** 序列化：frontmatter + body */
export function serializeMemory(entry) {
  return [
    "---",
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    "---",
    "",
    entry.body.trim(),
    "",
  ].join("\n");
}

/** 解析：frontmatter + body → entry（解析失败返回 null） */
export function parseMemory(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!meta.name) return null;
  return {
    name: meta.name,
    description: meta.description || "",
    type: meta.type || "user",
    body: m[2].trim(),
  };
}

/** 初始化目录结构（幂等） */
export async function ensureStore() {
  await mkdir(MEMORY_ROOT, { recursive: true });
  for (const t of MEMORY_TYPES) {
    await mkdir(path.join(MEMORY_ROOT, t), { recursive: true });
  }
  // 索引文件不存在则创建
  const indexPath = path.join(MEMORY_ROOT, "MEMORY.md");
  try {
    await readFile(indexPath, "utf8");
  } catch {
    await writeFile(indexPath, "# Memory Index\n\n_No entries yet._\n", "utf8");
  }
}

/** 写一个记忆文件 */
export async function writeMemory(entry) {
  await ensureStore();
  await writeFile(memoryPath(entry.type, entry.name), serializeMemory(entry), "utf8");
}

/** 删除一个记忆文件（不存在则静默） */
export async function deleteMemoryFile(type, title) {
  try {
    await unlink(memoryPath(type, title));
  } catch {
    // ENOENT 忽略
  }
}

/** 读取某个类型目录下的所有记忆文件 */
async function readTypeDir(type) {
  const dir = path.join(MEMORY_ROOT, type);
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    try {
      const content = await readFile(path.join(dir, f), "utf8");
      const entry = parseMemory(content);
      if (entry) entries.push(entry);
    } catch {
      // 单个文件损坏跳过
    }
  }
  return entries;
}

/** 读取全部记忆（四种类型） */
export async function readAllMemories() {
  await ensureStore();
  const all = [];
  for (const t of MEMORY_TYPES) {
    all.push(...(await readTypeDir(t)));
  }
  return all;
}

/** 重建 MEMORY.md 索引（对应 Qwen Code 的 indexer） */
export async function updateIndex(memories) {
  const lines = ["# Memory Index", ""];
  if (memories.length === 0) {
    lines.push("_No entries yet._");
  } else {
    for (const m of memories) {
      lines.push(`- [${m.name}](${m.type}/${toSlug(m.name)}.md) — ${m.description}`);
    }
  }
  await writeFile(path.join(MEMORY_ROOT, "MEMORY.md"), lines.join("\n") + "\n", "utf8");
}
