// ─── packages/mcp/src/index.ts ───
// @y-claude-code/mcp 模块公共 API 入口
// 解决问题：通过统一的入口文件对外暴露 MCP Client、工具适配器和所有协议类型，
// 使外部消费者（主要是 core 包）只需 import 此模块即可获取完整的 MCP 集成能力。
//
// 模块职责：
//   - MCPClient: 管理 MCP Server 进程的启动、通信和生命周期
//   - MCPToolAdapter: 将 MCP 工具适配为 core Tool 接口，实现无缝集成
//   - 类型定义: 提供完整的 JSON-RPC 和 MCP 协议类型，确保编译时类型安全
//
// 外部使用示例：
//   import { MCPClient, MCPToolAdapter } from "@y-claude-code/mcp";
//   const client = new MCPClient({ name: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] });
//   await client.connect();
//   const tools = await client.listTools();
//   const adapters = tools.map(def => new MCPToolAdapter(client, def));
//   // 将 adapters 注册到 ToolRegistry...

// ─── 实现类导出（运行时） ───
export { MCPClient } from "./client";
export { MCPToolAdapter } from "./adapter";

// ─── 类型导出（仅编译时） ───
export type {
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCNotification,
    MCPToolDefinition,
    MCPToolCallResult,
    MCPServerInfo,
    MCPServerConfig,
} from "./types";
