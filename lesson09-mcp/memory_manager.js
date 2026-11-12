/**
 * lesson05 · v5: memory_manager —— 记忆统一入口 + 异步提取调度
 *
 * 对外 API（agent 只跟它打交道）：
 *   save(entry)                    保存记忆（去重）
 *   recall(query, {useLLM})        召回相关记忆
 *   list() / forget(name)          管理
 *   scheduleExtract(llm, messages) 异步提取（游标 + 频率 + 串行队列）
 *
 * 异步提取的并发控制（本课工程核心，对应 Qwen Code 的 scheduleExtract）：
 *   1. 快照     提取分析的消息是 slice 副本，与主循环 append 并发安全
 *   2. 游标     记录已提取到第几条，下次从游标后开始（避免重复提取）
 *   3. 频率     新增消息不足阈值则跳过（避免每轮都调 LLM，token 翻倍）
 *   4. 串行队列 同一时刻只跑一个提取；积压时合并等待（防堆积）
 *   5. 失败隔离 提取失败 try/catch 静默，绝不影响主对话
 */

import { extractMemories } from "./extract.js";
import { deleteMemory, listMemories, saveMemory } from "./memory_entries.js";
import { recallByKeywords, rerankByLLM } from "./recall.js";

/** 触发提取的最小新增消息数（频率阈值） */
export const EXTRACT_MIN_NEW_MESSAGES = 2;

export class MemoryManager {
  constructor() {
    // 不同会话各自记录提取位置，避免切换会话时共用一个数组下标。
    this.cursors = new Map();
    this.anchors = new Map();
    this.extracting = new Set();
    this.pendingMessages = new Map();
  }

  // ─── 基础操作（委托 v2）───────────────────────────────────────

  async save(entry) {
    return saveMemory(entry);
  }

  async recall(query, { useLLM = false, llm = null } = {}) {
    const memories = await listMemories();
    const candidates = recallByKeywords(query, memories);
    if (useLLM && llm && candidates.length > 1) {
      return rerankByLLM(llm, query, candidates);
    }
    return candidates;
  }

  async list() {
    return listMemories();
  }

  async forget(name) {
    return deleteMemory(name);
  }

  /**
   * 把召回结果格式化为注入文本（追加到 system prompt 尾部）。
   * @returns {string} 空字符串 = 无相关记忆
   */
  formatRecall(recalled) {
    if (!recalled || recalled.length === 0) return "";
    return (
      "\n\n## 相关记忆（来自历史会话，仅相关时使用）\n" +
      recalled
        .map((m) => `- ${m.name}（${m.type}）：${m.description}\n  ${m.body}`)
        .join("\n")
    );
  }

  // ─── 异步提取调度（v5 工程核心）───────────────────────────────

  /**
   * 异步提取：fire-and-forget，不阻塞主对话。
   * @param {Function} llm
   * @param {Array<Object>} messages 主循环的完整消息（内部取快照）
   * @param {string} [scope="default"] 会话标识；同一会话内复用
   */
  scheduleExtract(llm, messages, scope = "default") {
    // 1. 快照：立即拷贝，与主循环后续 append 并发安全
    const snapshot = messages.map((m) => ({ ...m }));

    // 压缩、重置或恢复历史后，下标可能已经失效。用上次提取边界的消息
    // 做校验；边界变了就从当前会话的开头重新检查（记忆保存会去重）。
    let cursor = this.cursors.get(scope) || 0;
    const anchor = this.anchors.get(scope);
    if (
      cursor > snapshot.length ||
      (cursor > 0 && JSON.stringify(snapshot[cursor - 1]) !== anchor)
    ) {
      cursor = 0;
      this.cursors.set(scope, 0);
      this.anchors.delete(scope);
    }

    // 2. 频率检查：游标之后的新消息不足阈值 → 跳过
    const newMessages = snapshot.slice(cursor);
    if (newMessages.length < EXTRACT_MIN_NEW_MESSAGES) return;

    // 3. 串行队列：已有提取在跑 → 合并等待（记录最新快照）
    if (this.extracting.has(scope)) {
      this.pendingMessages.set(scope, snapshot);
      return;
    }

    this.extracting.add(scope);
    // 4. 后台执行（不 await，调用方 fire-and-forget）
    void this._runExtract(llm, newMessages, snapshot, scope);
  }

  async _runExtract(llm, newMessages, snapshot, scope) {
    try {
      const existing = await listMemories();
      const extracted = await extractMemories(llm, newMessages, existing);
      for (const entry of extracted) {
        await this.save(entry); // save 内部去重
      }
      // 5. 推进游标到本次快照末尾
      this.cursors.set(scope, snapshot.length);
      this.anchors.set(
        scope,
        snapshot.length ? JSON.stringify(snapshot[snapshot.length - 1]) : undefined,
      );
    } catch (e) {
      // 失败隔离：记日志，不抛出（后台任务不能影响主对话）
      console.error(`[memory-extract] 提取失败（忽略）: ${e.message}`);
    } finally {
      this.extracting.delete(scope);
      // 处理积压：提取期间有新消息到达 → 立即再跑一轮
      if (this.pendingMessages.has(scope)) {
        const pending = this.pendingMessages.get(scope);
        this.pendingMessages.delete(scope);
        const pendingNew = pending.slice(this.cursors.get(scope) || 0);
        if (pendingNew.length >= EXTRACT_MIN_NEW_MESSAGES) {
          this.extracting.add(scope);
          void this._runExtract(llm, pendingNew, pending, scope);
        }
      }
    }
  }
}
