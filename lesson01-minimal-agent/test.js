/**
 * lesson01 · 自测（node:test，零依赖、无需 API key）
 *
 * 本课测法说明（重要）：
 *   agent.js 直接 import call_llm，没有依赖注入点，所以测试用"替换 globalThis.fetch"
 *   的办法喂脚本化响应——不改一行业务代码就能把主循环跑起来。
 *   第 2 课起 Agent 改成构造注入（new Agent({ llm })），测试就不用再黑盒替换了。
 *
 * 跑法：npm test   或   node --test test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { run_agent } from "./agent.js";
import { TOOLS, call_tool } from "./tools.js";

/** 造一条"模型要调工具"的响应 */
function toolCall(name, args, id = "call_1") {
    return {
        role: "assistant",
        content: null,
        tool_calls: [{
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
        }],
    };
}

/** 造一条"模型给最终答案"的响应 */
function text(content) {
    return { role: "assistant", content, tool_calls: null };
}

/**
 * 替换 globalThis.fetch：llm.js 在调用时才取全局 fetch，所以能在这里"喂"响应。
 * @param {Array|Function} script 响应消息数组（按请求次序取），或函数 (index, body) => message
 */
function mockLlmFetch(script) {
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        requests.push(body);
        const i = requests.length - 1;
        const message = typeof script === "function" ? script(i, body) : script[i];
        if (!message) throw new Error(`脚本化响应已用完（第 ${requests.length} 次请求）`);
        return { ok: true, json: async () => ({ choices: [{ message }] }) };
    };
    return {
        requests,
        restore: () => { globalThis.fetch = original; },
    };
}

// ─── 主循环：正常路径 ──────────────────────────────────────────────

test("正常路径：查城市 → 查天气 → 给答案，循环 3 轮结束", async () => {
    const m = mockLlmFetch([
        toolCall("get_city", {}, "c1"),
        toolCall("get_weather", { city: "北京" }, "c2"),
        text("北京今天晴 25°C"),
    ]);
    try {
        const answer = await run_agent("今天的天气怎么样", false);

        assert.equal(answer, "北京今天晴 25°C");
        assert.equal(m.requests.length, 3);      // 正好三轮，不多不少

        // 第 3 轮的请求里应带上完整的协议序列
        const msgs = m.requests[2].messages;
        assert.deepEqual(msgs[0], { role: "user", content: "今天的天气怎么样" });
        assert.equal(msgs[1].role, "assistant");
        assert.equal(msgs[2].role, "tool");
        // tool 消息必须与 assistant(tool_calls) 的 id 配对
        assert.equal(msgs[2].tool_call_id, msgs[1].tool_calls[0].id);
        assert.deepEqual(JSON.parse(msgs[2].content), { city: "北京" });
    } finally {
        m.restore();
    }
});

test("一轮多个 tool_calls：按顺序执行、按 id 一一回填", async () => {
    const m = mockLlmFetch([
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "p1", type: "function", function: { name: "get_city", arguments: "{}" } },
                { id: "p2", type: "function", function: { name: "get_food", arguments: '{"city":"北京"}' } },
            ],
        },
        text("北京推荐烤鸭"),
    ]);
    try {
        const answer = await run_agent("推荐点吃的", false);
        assert.equal(answer, "北京推荐烤鸭");

        const msgs = m.requests[1].messages;
        assert.equal(msgs[2].role, "tool");
        assert.equal(msgs[2].tool_call_id, "p1");
        assert.equal(msgs[3].role, "tool");
        assert.equal(msgs[3].tool_call_id, "p2");
        assert.deepEqual(JSON.parse(msgs[3].content), { city: "北京", food: "烤鸭" });
    } finally {
        m.restore();
    }
});

test("模型同时给 content 和 tool_calls 时，以 tool_calls 为准继续循环", async () => {
    const m = mockLlmFetch([
        {
            role: "assistant",
            content: "我先查一下城市",
            tool_calls: [{ id: "c1", type: "function", function: { name: "get_city", arguments: "{}" } }],
        },
        text("北京"),
    ]);
    try {
        const answer = await run_agent("随便问问", false);
        assert.equal(answer, "北京");
        assert.equal(m.requests.length, 2);   // 没被那句 content 提前结束
    } finally {
        m.restore();
    }
});

test("自定义输入会作为第一条 user 消息发出去；tools 说明书每轮都带", async () => {
    const m = mockLlmFetch([text("好的")]);
    try {
        await run_agent("帮我查点东西", false);
        assert.deepEqual(m.requests[0].messages, [{ role: "user", content: "帮我查点东西" }]);
        assert.equal(m.requests[0].tools.length, 3);
    } finally {
        m.restore();
    }
});

// ─── 主循环：保险丝 ───────────────────────────────────────────────

test("每轮都调工具时：MAX_ROUND 精确拦截在第 10 轮，不多转一轮", async () => {
    const m = mockLlmFetch(() => toolCall("get_city", {}, "c"));
    try {
        const answer = await run_agent("无限循环测试", false);
        assert.match(answer, /\[MAX_ROUND\]/);
        assert.equal(m.requests.length, 10);
    } finally {
        m.restore();
    }
});

// ─── 工具层（不经过 LLM，直接调执行器）───────────────────────────

test("TOOLS 说明书：三个工具、字段齐全、get_weather 必填 city", () => {
    const names = TOOLS.map((t) => t.function.name);
    assert.deepEqual(names, ["get_city", "get_weather", "get_food"]);
    const weather = TOOLS.find((t) => t.function.name === "get_weather");
    assert.deepEqual(weather.function.parameters.required, ["city"]);
    assert.equal(weather.function.parameters.properties.city.type, "string");
});

test("call_tool：三个工具都返回确定性假数据", async () => {
    assert.deepEqual(await call_tool("get_city", "{}"), { city: "北京" });
    assert.deepEqual(await call_tool("get_weather", '{"city":"上海"}'), { city: "上海", weather: "多云 22°C" });
    assert.deepEqual(await call_tool("get_food", '{"city":"深圳"}'), { city: "深圳", food: "肠粉" });
});

test("call_tool：未知工具返回结构化错误（不抛异常，让模型自己纠正）", async () => {
    assert.deepEqual(await call_tool("not_a_tool", "{}"), { error: "Unknown tool: not_a_tool" });
});

// ─── 负向测试：本课故意留的两个缺口（第 2 课修）───────────────────

test("缺口①：模型传了假数据表里没有的城市 → 抛 TypeError（本课未捕获）", async () => {
    await assert.rejects(() => call_tool("get_food", '{"city":"杭州"}'), TypeError);
});

test("缺口②：模型给出非法 JSON 参数 → 抛 SyntaxError（本课未捕获）", async () => {
    await assert.rejects(() => call_tool("get_weather", "这不是 JSON"), SyntaxError);
});
