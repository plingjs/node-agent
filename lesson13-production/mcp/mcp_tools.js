/**
 * lesson08 · v3: mcp_tools —— MCP 工具注册进 registry
 *
 * 把 MCP server 动态发现的工具注册为内部工具（mcp__ 前缀），
 * 之后与内建工具完全平等：同一套权限/校验/调度。
 * 对应 Qwen Code 的 DiscoveredMCPTool（mcp__server__tool 命名）。
 *
 * 面试点：这就是 MCP 的价值——"接入任意外部系统"变成一个注册循环，
 * 工具协议（Function Calling schema）由 server 声明，客户端零适配。
 */

/**
 * 连接 MCP server 并把其工具注册进 registry。
 * @param {Object} registry createFullRegistry() 返回
 * @param {import("./mcp_client.js").McpClient} client
 * @param {string} [serverName] 前缀用（对应 Qwen Code 的 mcp__<server>__<tool>）
 */
export async function registerMcpTools(registry, client, serverName = "ext") {
  const tools = await client.listTools();

  for (const t of tools) {
    registry.register(
      {
        name: `mcp__${serverName}__${t.name}`,
        description: `${t.description}（来自 MCP 外部服务器 ${serverName}）`,
        params: t.inputSchema || t.parameters || { type: "object", properties: {} },
        fn: async (args) => {
          const res = await client.callTool(t.name, args);
          return res.error ? { error: res.error } : { text: res.text };
        },
      },
      // 外部系统调用可能有副作用 → 默认 write（需确认）
      "write",
    );
  }

  return tools.map((t) => t.name);
}

/** 便捷：连接 + 注册一步完成（main.js 使用） */
export async function connectMcpServer(registry, { serverName = "ext" } = {}) {
  const { McpClient } = await import("./mcp_client.js");
  const client = new McpClient();
  await client.connect();
  const names = await registerMcpTools(registry, client, serverName);
  return { client, toolNames: names };
}
