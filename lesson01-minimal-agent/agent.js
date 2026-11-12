import { call_llm } from "./llm.js";
import { TOOLS, call_tool } from "./tools.js";

/** 保险丝：最多转多少轮（模型"犯轴"时强制收工） */
const MAX_ROUND = 10;

/**
 * 最小 Agent 主循环：想 → 做 → 看结果 → 再想，直到模型给出最终文本。
 *
 * @param {string} userInput 用户输入
 * @param {boolean} verbose 是否打印每轮的原始响应（教学用：看调用链条，而不是看结果）
 * @returns {Promise<string>} 模型最终回答，或 MAX_ROUND 兜底文案
 */
export async function run_agent(userInput = "今天的天气和美食", verbose = true) {
    const messages = [
        { role: "user", content: userInput },
    ];

    let round = 0;
    while (true) {
        if (round >= MAX_ROUND) {
            return `[MAX_ROUND] 达到最大轮数 ${MAX_ROUND}，已强制结束`;
        }

        const response = await call_llm(messages, TOOLS);
        if (verbose) console.log(`Round ${round}:`, JSON.stringify(response));
        round += 1;

        // 模型的"调用意图"本身也是历史的一部分：下一轮它要能看到自己说过要调什么
        messages.push(response);

        if (response.tool_calls && response.tool_calls.length > 0) {
            for (const tool_call of response.tool_calls) {
                const tool_result = await call_tool(
                    tool_call.function.name,
                    tool_call.function.arguments,
                );
                messages.push({
                    role: "tool",
                    tool_call_id: tool_call.id,
                    content: JSON.stringify(tool_result),
                });
            }
        } else {
            return response.content;
        }
    }
}
