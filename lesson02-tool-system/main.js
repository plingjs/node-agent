/**
 * 第2课 · 入口（CLI 交互确认版，Node）
 *
 * 用法：
 *   在同目录 env.json 里填 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL（优先），
 *   或 export 同名环境变量（env.json 缺失时生效），然后：
 *   node main.js
 *
 * confirm 回调：演示用 readline 交互确认（生产是 UI 弹窗/审批流）。
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { Agent } from "./agent.js";
import { NOTES, buildRegistry } from "./tools_demo.js";

const rl = createInterface({ input: stdin, output: stdout });

/** 三态确认：y=一次 / a=始终允许 / n=拒绝 */
async function cliConfirm(name, args) {
  console.log(`\n  ⚠️  需要确认: ${name}(${JSON.stringify(args)})`);
  const choice = (await rl.question("  批准? (y=一次 / a=始终允许 / n=拒绝): ")).trim().toLowerCase();
  if (choice === "a") return "always";
  return choice === "y";
}

async function main() {
  const registry = buildRegistry(cliConfirm);
  const agent = new Agent(registry, { verbose: true });

  const answer = await agent.run(
    "帮我做三件事：1) 查询北京天气；2) 保存一条笔记，标题'例会'，内容'周三下午三点'；" +
      "3) 删除一条标题为'临时'的笔记。",
  );
  console.log(`\n[agent] ${answer}`);
  console.log(`[notes] ${JSON.stringify([...NOTES.entries()])}`);
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
