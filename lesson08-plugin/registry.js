/**
 * 第2课 · v1: ToolRegistry —— 工具注册表（Node 版）
 *
 * 对比 Python 版：Python 能从函数签名+类型注解自动生成 JSON Schema，
 * JS 没有类型系统，所以工具以"定义对象"显式声明 schema。
 * 这正是 Vercel AI SDK 用 Zod 定义工具参数的原因 —— 语言差异决定框架设计。
 *
 * 一个工具 = 定义对象 { name, description, params, fn }：
 *   name        工具名（LLM 调用时使用）
 *   description 工具描述（LLM 决定何时调用，提示工程在工具层的体现）
 *   params      JSON Schema（参数协议）
 *   fn          真正干活的函数
 */

/**
 * 工具定义
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {Object} params - JSON Schema（type/properties/required）
 * @property {Function} fn
 */

/** 创建工具注册表（每实例独立，测试互不污染） */
export function createRegistry() {
  /** @type {Map<string, ToolDef>} */
  const tools = new Map();

  return {
    /** 注册工具 */
    register(toolDef) {
      tools.set(toolDef.name, toolDef);
      return toolDef;
    },

    /** 给 LLM 的 tools 参数（协议层：OpenAI Function Calling 格式） */
    getSchemas() {
      return [...tools.values()].map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.params,
        },
      }));
    },

    /**
     * 路由执行（v2 的 validation.js / permissions.js 将插入到这里）。
     * argumentsStr 是 LLM 生成的 JSON 字符串 —— 可能非法，必须容错。
     */
    async execute(name, argumentsStr) {
      const tool = tools.get(name);
      if (!tool) return { error: `未知工具: ${name}` };

      let args;
      try {
        args = argumentsStr ? JSON.parse(argumentsStr) : {};
      } catch {
        return { error: `工具 ${name} 的参数不是合法 JSON: ${argumentsStr}` };
      }

      try {
        const result = await tool.fn(args);
        return { result };
      } catch (e) {
        // 工具内部异常隔离：错误回传给模型看，不让进程崩溃
        return { error: `工具 ${name} 执行失败: ${e.message}` };
      }
    },
  };
}
