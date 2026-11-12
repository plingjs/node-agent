/**
 * 工具层：同一个文件里住着两个角色
 *
 *   TOOLS      给"模型"看的工具说明书（JSON Schema）→ 随每轮请求发过去，
 *              让它知道"你能用哪些工具、参数怎么传"
 *   call_tool  给"框架"用的执行器 → 模型说"我要调 get_weather"之后，
 *              真正跑代码的是它（模型永远不执行任何东西）
 *
 * 三个 mock 工具刻意做成**依赖链**：查天气、查美食都需要城市，
 * 而城市要从 get_city 拿 —— 逼模型分多步、多轮完成，循环才转得起来。
 *
 * 数据是写死的假数据（不是随机数），保证每个读者跑出来的输出一致。
 */

export const TOOLS = [{
    type: "function",
    function: {
        name: "get_city",
        description: "获取当前我的城市",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
    },
}, {
    type: "function",
    function: {
        name: "get_weather",
        description: "查询天气",
        parameters: {
            type: "object",
            properties: {
                city: {
                    type: "string",
                    description: "城市名称",
                },
            },
            required: ["city"],
        },
    },
}, {
    type: "function",
    function: {
        name: "get_food",
        description: "获取当前我的城市美食",
        parameters: {
            type: "object",
            properties: {
                city: {
                    type: "string",
                    description: "城市名称",
                },
            },
            required: ["city"],
        },
    },
}];

/** 假数据表（只认识这四个城市；未知城市会抛错——本课不处理，第 2 课修） */
const CITIES = {
    "北京": { weather: "晴 25°C", foods: ["烤鸭", "炸酱面", "豆汁"] },
    "上海": { weather: "多云 22°C", foods: ["鱼香肉丝", "红烧肉"] },
    "广州": { weather: "小雨 20°C", foods: ["白切鸡", "烧鹅"] },
    "深圳": { weather: "大雨 18°C", foods: ["肠粉", "牛杂"] },
};

/** 教学用固定值：真实场景这里会读定位或用户配置 */
const MY_CITY = "北京";

const get_city = async () => MY_CITY;
const get_weather = async (city) => CITIES[city].weather;
const get_food = async (city) => CITIES[city].foods[0];

/**
 * 工具执行器：按名字路由到实现。
 * @param {string} name 工具名（模型给的）
 * @param {string} args 参数字符串（协议规定是 string，不是对象）
 */
export async function call_tool(name, args) {
    if (name === "get_city") {
        return { city: await get_city() };
    }
    if (name === "get_weather") {
        const { city } = JSON.parse(args);
        return { city, weather: await get_weather(city) };
    }
    if (name === "get_food") {
        const { city } = JSON.parse(args);
        return { city, food: await get_food(city) };
    }
    // 未知工具：返回结构化错误而不是抛异常（让模型看到并自行纠正）
    return { error: `Unknown tool: ${name}` };
}
