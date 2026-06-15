# @y-claude-code/mcp

MCP 协议支持 — Model Context Protocol 客户端与服务端实现。将外部 MCP 服务器提供的工具适配为 core 内部 Tool 实例。

## 文件

| 文件 | 职责 |
|------|------|
| `src/client.ts` | JSON-RPC 客户端：连接管理、`tools/list`、`tools/call`、流式传输 |
| `src/adapter.ts` | MCPToolAdapter：将 MCP 工具定义包装为 core 的 `Tool` 子类 |
| `src/types.ts` | MCP 协议类型定义：`MCPToolDefinition`、`MCPToolResult`、`MCPServerConfig` |

## MCPToolAdapter

```typescript
class MCPToolAdapter extends Tool {
    get name(): string { return `mcp__${serverName}__${toolName}`; }
    // 执行时通过 MCPClient.callTool() 调用远程工具
}
```

注册到 ToolRegistry 后，LLM 可像调用内置工具一样调用 MCP 工具。

## 配置

在 `.claude/settings.json` 中配置 MCP 服务器：

```json
{
    "mcpServers": {
        "filesystem": {
            "command": "npx",
            "args": ["-y", "@anthropic-ai/mcp-server-filesystem", "/path"]
        }
    }
}
```

## 使用

```typescript
import { MCPClient } from "@y-claude-code/mcp";

const client = new MCPClient(serverConfig);
await client.connect();
const tools = await client.listTools();
// 通过 MCPToolAdapter 注册到 ToolRegistry
```
