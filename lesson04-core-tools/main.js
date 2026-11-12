/**
 * lesson04 · 入口 —— 终端交互式 Agent（REPL）
 *
 * 用户在终端持续和 Agent 对话，多轮上下文自动保留、自动压缩。
 *
 * 架构要点（面试必讲）：
 *   Agent.run() 是"一次交互"的完整单元（对应 Qwen Code 的 AgentHeadless），
 *   交互式 = 外层 readline 循环 + 同一个 cm（TieredContextManager）跨轮复用。
 *   框架零改动 —— Agent 是纯逻辑，REPL 只是 UI 层。
 *
 * 元命令：
 *   /help    帮助    /budget 查看 token 预算   /reset 清空上下文
 *   /exit    退出（/quit /q 同义）
 *
 * 用法：配置 env.json 后 node main.js
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { call_llm } from "./llm.js";
import { Agent } from "./agent.js";
import { TieredContextManager } from "./context_manager_v2.js";
import { buildCoreTools } from "./core_tools.js";

const rl = createInterface({ input: stdin, output: stdout });

/** 三态确认：y=一次 / a=始终允许 / n=拒绝（run_shell 是 danger 级会触发） */
async function cliConfirm(name, args) {
  console.log(`\n  ⚠️  需要确认: ${name}(${JSON.stringify(args)})`);
  const choice = (await rl.question("  批准? (y=一次 / a=始终允许 / n=拒绝): ")).trim().toLowerCase();
  if (choice === "a") return "always";
  return choice === "y";
}

const SYSTEM_PROMPT =
  "你是代码库分析助手，能读文件、搜索、执行命令、写文件。完成任务后用中文简洁汇报。" +
  "如果用户的问题需要联网查资料，可用 fetch_url。";

function newContext() {
  const cm = new TieredContextManager({
    maxTokens: 40960,
    reserveForOutput: 5120,
    compactRatio: 0.8,
    keepRecent: 4,
  });
  cm.setSystem([{ role: "system", content: SYSTEM_PROMPT }]);
  return cm;
}

function printHelp() {
  console.log(`
  元命令：
    /help    显示本帮助
    /budget  查看当前 token 预算分配
    /reset   清空对话上下文，重新开始
    /exit    退出（/quit、/q 同义）

  示例任务：
    "搜索 demo 目录下含 TODO 的文件并统计数量"
    "看看 demo/app.js 里写了什么"
    "跑 ls -la demo 看看目录结构"
  `);
}

async function repl() {
  const registry = buildCoreTools(cliConfirm);
  let cm = newContext();
  const agent = new Agent({ registry, cm, llm: call_llm, verbose: true });

  console.log("=== 交互式 Agent（lesson04 核心工具）===");
  console.log("输入问题开始对话，输入 /help 查看命令。");
  printHelp();

  while (true) {
    const raw = await rl.question("\n你> ");
    const line = raw.trim();
    if (!line) continue;

    if (["/exit", "/quit", "/q"].includes(line)) break;
    if (line === "/help") {
      printHelp();
      continue;
    }
    if (line === "/budget") {
      console.log(JSON.stringify(cm.budget(), null, 2));
      continue;
    }
    if (line === "/reset") {
      cm = newContext();
      agent.cm = cm; // 换新的上下文管理器，历史清空
      console.log("上下文已重置。");
      continue;
    }

    try {
      const answer = await agent.run(line);
      console.log(`\nagent> ${answer}`);
    } catch (e) {
      console.error(`\n[错误] ${e.message}`);
      console.error("提示：检查 env.json 配置是否正确，或输入 /reset 重试。");
    }
  }

  console.log("再见！");
  rl.close();
}

repl().catch((e) => {
  console.error(e);
  process.exit(1);
});
