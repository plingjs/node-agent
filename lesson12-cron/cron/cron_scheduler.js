/**
 * lesson12 · v2: cron_scheduler —— 调度器（nextRun 计算 + 触发循环）
 *
 * 核心思想（面试必讲）：定时任务不是"每秒钟检查一次到没到点"（轮询，
 * 有漂移、耗 CPU），而是"计算下一次触发时间，睡到那个点，触发后再算"。
 *
 * nextRun(spec, from)：从 from 的下一分钟起递增扫描
 *   分钟不匹配 → 在本小时内找下一个匹配分钟
 *   小时不匹配 → 跳到下一小时（分钟归零）
 *   日/月不匹配 → 进位
 *   匹配 → 返回该时间
 *
 * 简化约定（文档注明）：日和周字段用 AND（标准 cron 是 OR）。
 * 最小粒度：分钟（标准 cron 无秒）。
 */

import { parseCron } from "./cron_parser.js";

/** 计算 spec 在 from 之后的下一次触发时间 */
export function nextRun(spec, from = new Date()) {
  const d = new Date(from);
  d.setSeconds(0, 0); // 对齐到分钟

  // 从 from 的下一分钟开始
  d.setMinutes(d.getMinutes() + 1);

  // 上限保护：扫描 5 年（防表达式永不匹配时死循环）
  const limit = 5 * 366 * 24 * 60;

  for (let i = 0; i < limit; i++) {
    const minuteOk = spec.minute.includes(d.getMinutes());
    const hourOk = spec.hour.includes(d.getHours());
    const monthOk = spec.month.includes(d.getMonth() + 1);
    // 日和周：AND（简化；标准 cron 是 OR）
    const dateOk =
      spec.day.includes(d.getDate()) && spec.weekday.includes(d.getDay());

    if (minuteOk && hourOk && monthOk && dateOk) return d;

    // 进位策略（避免逐分钟空转）：
    //   分钟不匹配 → 跳到本小时的下一个匹配分钟（或下一小时）
    if (!minuteOk) {
      const nextMin = spec.minute.find((m) => m > d.getMinutes());
      if (nextMin !== undefined) {
        d.setMinutes(nextMin);
      } else {
        d.setHours(d.getHours() + 1, 0, 0, 0);
      }
      continue;
    }
    // 分钟匹配但小时不匹配 → 跳到下一个匹配小时
    if (!hourOk) {
      const nextHour = spec.hour.find((h) => h > d.getHours());
      if (nextHour !== undefined) {
        d.setHours(nextHour, 0, 0, 0);
      } else {
        d.setDate(d.getDate() + 1);
        d.setHours(spec.hour[0], 0, 0, 0);
      }
      continue;
    }
    // 时/分都匹配但日/月不匹配 → 加一天
    d.setDate(d.getDate() + 1);
    d.setHours(spec.hour[0], 0, 0, 0);
  }
  return null;
}

/** 注册的定时任务 */
export class CronJob {
  constructor({ name, spec, callback, intervalMs = null }) {
    this.name = name;
    this.spec = spec; // parseCron 产物；null = 间隔任务
    this.callback = callback;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.runs = 0;
    this.lastRunAt = null;
    this.running = false;
  }

  /** 任务描述（列表用） */
  describe() {
    if (this.spec) return `${this.name} (cron: ${this.spec.raw})`;
    return `${this.name} (每 ${this.intervalMs}ms)`;
  }
}

/** Node setTimeout 单次最大延迟：2^31-1 ms ≈ 24.8 天，超过会溢出并立即触发 */
const MAX_TIMEOUT = 2147483647;

/**
 * 调度器：注册 cron / 间隔任务，自动触发。
 * @param {Object} [opts] {log}
 */
export class CronScheduler {
  constructor({ log = console.log } = {}) {
    this.log = log;
    /** @type {Map<string, CronJob>} */
    this.jobs = new Map();
    this.started = false;
  }

  /**
   * 注册 cron 表达式任务。
   * @param {string} expr 5 字段 cron
   * @param {Function} callback 到点触发
   * @param {Object} [opts] {name}
   */
  schedule(expr, callback, { name = expr } = {}) {
    const spec = parseCron(expr);
    const job = new CronJob({ name, spec, callback });
    this.remove(name); // 同名覆盖：先清掉旧任务的 timer，否则它成了 stopAll 够不到的孤儿句柄
    this.jobs.set(name, job);
    this._arm(job);
    return job;
  }

  /** 注册间隔任务（便捷 API；测试/演示用毫秒级） */
  scheduleInterval(ms, callback, { name = `interval-${ms}` } = {}) {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error("间隔必须是大于 0 的有限毫秒数");
    }
    const job = new CronJob({ name, callback, intervalMs: ms });
    this.remove(name); // 同名覆盖同上
    this.jobs.set(name, job);
    this._arm(job);
    return job;
  }

  /** 移除任务 */
  remove(name) {
    const job = this.jobs.get(name);
    if (job) {
      if (job.intervalMs === null) clearTimeout(job.timer);
      else clearInterval(job.timer);
      this.jobs.delete(name);
    }
  }

  /** 停止所有任务（进程退出/测试清理用——pending timer 会阻止事件循环退出） */
  stopAll() {
    for (const job of this.jobs.values()) {
      if (job.intervalMs === null) clearTimeout(job.timer);
      else clearInterval(job.timer);
    }
    this.jobs.clear();
  }

  list() {
    return [...this.jobs.values()].map((j) => ({
      name: j.name,
      desc: j.describe(),
      runs: j.runs,
      lastRunAt: j.lastRunAt,
    }));
  }

  /** 触发一次任务（外部也可手动调，如测试） */
  async fire(job) {
    // 间隔定时器可能在上一次异步回调结束前再次触发；同一任务不并发执行。
    if (job.running) return false;
    job.running = true;
    job.runs += 1;
    job.lastRunAt = new Date();
    try {
      await job.callback();
    } catch (e) {
      this.log(`[cron] 任务 ${job.name} 执行失败: ${e.message}`);
    } finally {
      job.running = false;
    }
    return true;
  }

  /** 武装任务：安排下一次触发 */
  _arm(job) {
    if (job.intervalMs !== null) {
      // setInterval 可能在上一次异步回调结束前再次触发；fire 会跳过重叠执行。
      job.timer = setInterval(() => {
        if (this.jobs.get(job.name) === job) void this.fire(job);
      }, job.intervalMs);
      return;
    }
    this._armCron(job);
  }

  /**
   * cron 任务武装：等 nextRun → 触发 → 再算（无漂移）。
   * 分段 sleep：单次 setTimeout 上限 2^31-1 ms（24.8 天），
   * 超长间隔（年度任务等）分段逼近目标点——否则溢出会立即触发。
   */
  _armCron(job) {
    if (this.jobs.get(job.name) !== job) return;
    const next = nextRun(job.spec);
    if (!next) {
      this.log(`[cron] 任务 ${job.name} 在 5 年内无触发时间，已跳过`);
      return;
    }
    const delay = next.getTime() - Date.now();

    if (delay > MAX_TIMEOUT) {
      // 距离目标超过 24.8 天：分段等待，到段后重新武装（目标不变，delay 递减）
      job.timer = setTimeout(() => this._armCron(job), MAX_TIMEOUT);
      return;
    }

    job.timer = setTimeout(() => {
      if (this.jobs.get(job.name) !== job) return;
      // 等本次任务结束后再安排下一次，避免长任务重叠运行。
      void this.fire(job).finally(() => {
        if (this.jobs.get(job.name) === job) this._armCron(job);
      });
    }, Math.max(0, delay));
  }
}
