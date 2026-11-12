/**
 * lesson13 · cron_tool —— 让 Agent 用"语言"设置定时任务
 *
 * 用户说"每天早上9点帮我生成日报" → 模型推理 → 调用 create_cron_job
 * 工具（cron 表达式 + 任务描述）→ 注册进 CronScheduler → 到点自动执行。
 *
 * 设计：
 *   - create_cron_job：注册任务（write 级，走审批流——用户确认后才生效）
 *     推送目标固定为当前触发消息所在通道，避免任务被发到其他用户的会话
 *   - list_cron_jobs：查看已注册任务（read 级）
 *   - 非法 cron 表达式 → 工具返回 error（模型会重新尝试）
 */

import { parseCron } from "./cron_parser.js";
import { nextRun } from "./cron_scheduler.js";

/**
 * 创建"设置定时任务"工具。
 * @param {Object} opts
 * @param {import("./cron/cron_scheduler.js").CronScheduler} opts.scheduler
 * @param {import("./agent_bridge.js").AgentBridge} opts.bridge
 * @param {Function} opts.gatewayFor (channelId) => gateway（推送用）
 * @param {string} [opts.defaultChannel]
 */
export function createCronJobTool({ scheduler, bridge, gatewayFor, defaultChannel = "terminal" }) {
  return {
    name: "create_cron_job",
    description:
      "注册一个定时任务。cron 为 5 字段表达式（分 时 日 月 周）：" +
      "'0 9 * * *'=每天9点、'30 8 * * 1-5'=工作日8点半、分字段步进5=每5分钟。" +
      "到点会自动执行任务描述并推送结果到触发者所在通道。",
    params: {
      type: "object",
      properties: {
        cron: { type: "string", description: "5 字段 cron 表达式，如 '0 9 * * *'" },
        task: { type: "string", description: "到点执行的任务描述，如 '生成今天的日报'" },
      },
      required: ["cron", "task"],
    },
    fn: async ({ cron, task }) => {
      // 非法表达式 → 抛错（registry 会转成结构化错误，模型可见）
      const spec = parseCron(cron);
      const next = nextRun(spec);

      // 任务只能推回创建者当前所在的通道，不能由模型指定其他用户。
      const target = bridge.currentChannel || defaultChannel;

      scheduler.schedule(
        cron,
        async () => {
          const reply = await bridge.handleSystemMessage({
            channelId: target,
            text: `【定时任务】${task}`,
          });
          const gw = gatewayFor(target);
          if (reply && gw) await gw.send(target, `[定时] ${reply}`);
        },
        { name: task },
      );

      return {
        created: true,
        job: `cron: ${cron}`,
        nextRun: next ? next.toLocaleString() : "5 年内无触发时间（请检查表达式）",
        channel: target,
      };
    },
  };
}

/** 创建"查看定时任务"工具 */
export function createListCronJobsTool({ scheduler }) {
  return {
    name: "list_cron_jobs",
    description: "列出当前所有已注册的定时任务（名称/表达式/已触发次数/上次触发时间）。",
    params: { type: "object", properties: {} },
    fn: async () => ({ jobs: scheduler.list() }),
  };
}
