/**
 * lesson12 · v1: cron_parser —— cron 表达式解析
 *
 * 标准 5 字段 cron：分 时 日 月 周
 *   "0 9 * * *"       每天 9:00
 *   "每 5 分钟"       分字段步进 5（星号斜杠 5）
 *   "0 9 1,15 * *"    每月 1 日和 15 日 9:00
 *   "0 9 * * 1-5"     周一到周五 9:00
 *
 * 字段语法：
 *   *      全部
 *   步进    每 N 个（如 星号斜杠 5）
 *   a,b    列举
 *   a-b    范围
 *
 * 解析结果：每个字段展开为"匹配值数组"（调度器直接 includes 判断）。
 * 面试点：cron 解析的产物不是正则，而是"可匹配的值集合"——
 * 调度器用它做 O(1) 匹配判断。
 */

/** 字段顺序与取值范围 */
export const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "weekday", min: 0, max: 6 }, // 0=周日
];

/** 展开单个字段：步进→[0,5,10,...]；"1,15"→[1,15]；"1-5"→[1,2,3,4,5] */
function expandField(expr, min, max, fieldName) {
  const values = new Set();

  for (const part of String(expr).split(",")) {
    if (!part) throw new Error(`${fieldName} 字段不能为空`);
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (step === 0) throw new Error(`${fieldName} 字段的步长必须大于 0`);
      for (let v = min; v <= max; v += step) values.add(v);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const [a, b] = [Number(rangeMatch[1]), Number(rangeMatch[2])];
      if (a < min || b > max || a > b) {
        throw new Error(`${fieldName} 字段范围必须在 ${min}-${max} 内且起点不大于终点`);
      }
      for (let v = a; v <= b; v++) values.add(v);
      continue;
    }
    if (part === "*") {
      for (let v = min; v <= max; v++) values.add(v);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error(`${fieldName} 字段格式无效: "${part}"`);
    const num = Number(part);
    if (num < min || num > max) {
      throw new Error(`${fieldName} 字段取值必须在 ${min}-${max} 内`);
    }
    values.add(num);
  }
  if (values.size === 0) throw new Error(`${fieldName} 字段没有有效取值`);
  return [...values].sort((a, b) => a - b);
}

/**
 * 解析 cron 表达式。
 * @param {string} expr 5 字段 cron，如 "0 9 * * *"
 * @returns {{minute:number[], hour:number[], day:number[], month:number[], weekday:number[], raw:string}}
 * @throws 表达式非法时抛错
 */
export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式必须是 5 字段（分 时 日 月 周），收到: "${expr}"`);
  }

  const spec = { raw: expr };
  for (let i = 0; i < 5; i++) {
    const f = CRON_FIELDS[i];
    spec[f.name] = expandField(parts[i], f.min, f.max, f.name);
  }
  return spec;
}

/** 校验时间是否匹配某 cron spec（测试用） */
export function matches(spec, date) {
  return (
    spec.minute.includes(date.getMinutes()) &&
    spec.hour.includes(date.getHours()) &&
    spec.day.includes(date.getDate()) &&
    spec.month.includes(date.getMonth() + 1) &&
    spec.weekday.includes(date.getDay())
  );
}
