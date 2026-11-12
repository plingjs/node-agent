/**
 * lesson03-context · 入口
 *
 * 用法：配置 env.json 后 node main.js
 *   env.json 格式：{"OPENAI_API_KEY":"...","OPENAI_BASE_URL":"...","OPENAI_MODEL":"..."}
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { call_llm } from "./llm.js";
import { Agent } from "./agent.js";
import { TieredContextManager } from "./context_manager_v2.js";
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

  const cm = new TieredContextManager({
    maxTokens: 4096,
    reserveForOutput: 512,
    compactRatio: 0.8,
    keepRecent: 4,
  });
  cm.setSystem([
    { role: "system", content: "你是助手，可调用工具获取信息并管理笔记，回答要简洁。" },
  ]);

  const agent = new Agent({ registry, cm, llm: call_llm, verbose: true });

  const answer = await agent.run(
    "帮我：1) 查北京天气；2) 搜索日志关键词 timeout；3) 保存一条笔记（标题'例会'，内容'周三下午三点'）。",
  );
  console.log(`\n[agent] ${answer}`);
  console.log(`[notes] ${JSON.stringify([...NOTES.entries()])}`);
  console.log(`[budget] ${JSON.stringify(cm.budget())}`);
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
