/**
 * lesson10 · v2: session_manager —— 多会话管理
 *
 * 会话 = 一个持久化的对话状态文件（sessions/<id>.json）。
 * 多会话并行：同一时刻一个活跃会话在内存，切换 = save 旧 + load 新。
 *
 * 工程细节（面试必讲）：
 *   1. 原子写：先写 .tmp 再 rename —— 防写一半崩溃损坏会话文件
 *   2. 自动保存：run() 结束后 save + 退出 save —— 崩溃最多丢当前一轮
 *   3. 标题自动生成：第一轮用户消息前 20 字（零依赖版；真实产品用 LLM 生成）
 *   4. 失败静默：保存失败不打断对话（记日志）
 */

import { readFile, writeFile, readdir, rename, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "sessions",
);

export class SessionManager {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.dir] 会话目录
   */
  constructor({ dir = DEFAULT_DIR } = {}) {
    this.dir = dir;
    this.ready = mkdir(this.dir, { recursive: true });
  }

  _path(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{8}$/i.test(id)) {
      throw new Error("会话 ID 格式无效");
    }
    return path.join(this.dir, `${id}.json`);
  }

  /** 新建会话（写入初始文件），返回会话元数据 */
  async create({ title = "新会话", model = "" } = {}) {
    await this.ready;
    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    const meta = {
      session_id: id,
      title,
      model,
      created_at: now,
      updated_at: now,
      message_count: 0,
    };
    await this._atomicWrite(id, meta);
    return meta;
  }

  /** 列出所有会话（按更新时间倒序） */
  async list() {
    await this.ready;
    let files = [];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const sessions = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(this.dir, f), "utf8"));
        sessions.push(meta);
      } catch {
        // 损坏的会话文件跳过
      }
    }
    return sessions.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }

  /** 读取会话完整状态 */
  async load(id) {
    await this.ready;
    const content = await readFile(this._path(id), "utf8");
    return JSON.parse(content);
  }

  /**
   * 保存会话（原子写）。
   * @param {string} id
   * @param {Object} state 完整会话状态（含 meta + context）
   */
  async save(id, state) {
    await this.ready;
    await this._atomicWrite(id, state);
  }

  /** 原子写：临时文件 + rename（防写一半崩溃损坏）；写前确保目录存在 */
  async _atomicWrite(id, state) {
    await mkdir(this.dir, { recursive: true });
    const target = this._path(id);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, target);
  }

  /** 删除会话 */
  async delete(id) {
    await this.ready;
    try {
      await unlink(this._path(id));
      return true;
    } catch {
      return false;
    }
  }

  /** 重命名会话（改标题） */
  async rename(id, title) {
    const state = await this.load(id);
    state.title = title;
    await this.save(id, state);
    return state;
  }

  /**
   * 便捷：更新会话元数据（自动保存时用）。
   * 读-改-写整个文件，简单但够用（零依赖）。
   */
  async touch(id, { title, message_count, model } = {}) {
    const state = await this.load(id);
    if (title !== undefined) state.title = title;
    if (message_count !== undefined) state.message_count = message_count;
    if (model !== undefined) state.model = model;
    state.updated_at = Date.now();
    await this.save(id, state);
    return state;
  }
}

/** 标题自动生成：取文本前 N 字符（空输入兜底） */
export function autoTitle(text, max = 20) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "新会话";
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
