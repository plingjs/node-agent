/**
 * lesson05 · v2: memory_entries —— 记忆条目管理（CRUD + 去重）
 *
 * 在 v1 存储层之上提供业务操作：
 *   saveMemory   保存（按 name 去重，同标题覆盖；内容相同则跳过）
 *   listMemories 列出
 *   getMemory    按 name 查
 *   deleteMemory 删除
 *
 * 面试点：记忆去重是"写入侧"的第一道防线——
 * 反复提取同一事实会污染记忆库，每次写入前先查重。
 */

import {
  deleteMemoryFile,
  readAllMemories,
  updateIndex,
  writeMemory,
} from "./memory_store.js";

/** 校验并规范化记忆条目 */
export function normalizeEntry(entry) {
  const name = String(entry?.name || "").trim();
  if (!name) throw new Error("记忆必须有 name");
  const type = ["user", "feedback", "project", "reference"].includes(entry.type)
    ? entry.type
    : "user";
  return {
    name,
    description: String(entry.description || "").trim(),
    type,
    body: String(entry.body || "").trim(),
  };
}

/** 保存记忆：同 name 覆盖；内容完全一致则跳过（去重） */
export async function saveMemory(entry) {
  const normalized = normalizeEntry(entry);

  const all = await readAllMemories();
  const existing = all.find((m) => m.name === normalized.name);
  if (existing) {
    // 内容一致 → 无变化，跳过（避免重复写 + 避免索引抖动）
    if (
      existing.body === normalized.body &&
      existing.description === normalized.description &&
      existing.type === normalized.type
    ) {
      return { entry: existing, created: false, deduped: true };
    }
  }

  await writeMemory(normalized);
  // 类型变了：旧类型目录下的同名文件必须删掉，否则同一条记忆会同时躺在两个目录里，
  // 召回时注入两份（内容还一样），MEMORY.md 索引也会重复列一行。
  if (existing && existing.type !== normalized.type) {
    await deleteMemoryFile(existing.type, existing.name);
  }
  await updateIndex(await readAllMemories());
  return { entry: normalized, created: !existing, deduped: false };
}

/** 列出全部记忆（可按类型过滤） */
export async function listMemories(type) {
  const all = await readAllMemories();
  return type ? all.filter((m) => m.type === type) : all;
}

/** 按 name 查记忆 */
export async function getMemory(name) {
  const all = await readAllMemories();
  return all.find((m) => m.name === name) || null;
}

/** 删除记忆（按 name，跨类型查找） */
export async function deleteMemory(name) {
  const all = await readAllMemories();
  const target = all.find((m) => m.name === name);
  if (!target) return false;
  await deleteMemoryFile(target.type, target.name);
  await updateIndex(await readAllMemories());
  return true;
}
