// ─── packages/mcp/src/adapter.ts ───
// MCP 工具适配器 — 将 MCP 工具包装为 @y-claude-code/core 的 Tool 实例
// 解决问题：MCP Server 提供的工具与 core 包的 Tool 抽象是不兼容的——
// MCP 工具通过 JSON-RPC 远程调用，而 core 的 Tool 要求本地 execute 方法。
// MCPToolAdapter 作为适配器（Adapter 模式），将 MCP 远程工具包装成 core Tool 实例，
// 使其能被 ToolRegistry 统一注册和管理，AI 模型无需感知工具是本地还是远程的。

import { Tool } from "@y-claude-code/core";
import type { JSONSchema, ToolContext, ToolResult } from "@y-claude-code/core";
import type { MCPClient } from "./client";
import type { MCPToolDefinition } from "./types";

// ─── MCPToolAdapter ───
// 继承 core 的 Tool 抽象类，将 execute 调用委托给 MCPClient 的 JSON-RPC 调用
// 设计模式：适配器模式（Adapter Pattern）— 将 MCP Tool 接口适配为 core Tool 接口
// 命名规则：mcp__<serverName>__<toolName>，确保不同 MCP Server 的同名工具不会冲突

export class MCPToolAdapter extends Tool {
    /** 适配后的工具名称，格式: mcp__serverName__toolName */
    name: string;

    /** 工具描述，前缀 [MCP:serverName] 标明来源 */
    description: string;

    /** 工具参数 JSON Schema，直接映射 MCP Tool 的 inputSchema */
    parameters: JSONSchema;

    /** MCP 客户端引用，用于发起远程工具调用 */
    private client: MCPClient;

    /** MCP Server 侧的原始工具名称（去适配前缀） */
    private mcpToolName: string;

    /**
     * @param client - MCP 客户端实例，用于发起 JSON-RPC 调用
     * @param toolDef - MCP 工具定义，包含名称、描述、参数 Schema
     */
    constructor(client: MCPClient, toolDef: MCPToolDefinition) {
        super();
        this.client = client;
        this.mcpToolName = toolDef.name;
        // 使用命名空间前缀避免不同 MCP Server 提供的同名工具产生冲突
        this.name = `mcp__${client.serverName}__${toolDef.name}`;
        // 在描述中添加 MCP Server 来源标记，便于 AI 和用户识别工具的提供方
        this.description = `[MCP:${client.serverName}] ${toolDef.description}`;
        // 将 MCP 的 inputSchema 映射为 core 的 JSONSchema 格式
        this.parameters = {
            type: "object",
            properties: (toolDef.inputSchema.properties as Record<string, import("@y-claude-code/core").SchemaProperty>) ?? {},
            required: toolDef.inputSchema.required,
        };
    }

    /**
     * 执行 MCP 工具调用
     *
     * 流程：
     *   1. 通过 MCPClient 发起 tools/call JSON-RPC 请求
     *   2. 将 MCP 返回的 content 数组（支持 text 和 image 类型）展平为文本
     *   3. 包装为 core 的 ToolResult 格式返回
     *
     * @param params - 工具调用参数（已由 core 根据 JSON Schema 校验过）
     * @param _context - 工具执行上下文（未使用，MCP 工具无法感知 core 内部上下文）
     * @returns 统一的 ToolResult 格式，兼容 core 的工具结果处理流程
     */
    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        try {
            // 发起远程 MCP 工具调用
            const result = await this.client.callTool(this.mcpToolName, params);

            // 将 MCP 返回的 content 数组转为纯文本字符串
            // MCP content 格式: [{ type: "text", text: "..." }, { type: "image", data: "...", mimeType: "..." }]
            // 对于图片类型，无法在纯文本 UI 中渲染，仅显示占位符
            const textContent = result.content
                .map((c) => {
                    if (c.type === "text") return c.text ?? "";
                    if (c.type === "image") return `[图片: ${c.mimeType ?? "unknown"}]`;
                    return "";
                })
                .join("\n");

            return {
                tool_use_id: "",
                content: textContent || "(空结果)",
                is_error: result.isError ?? false,
            };
        } catch (error) {
            // 捕获所有错误（网络错误、JSON-RPC 错误等），统一包装为错误结果
            // 设计原因：不向上抛出异常，而是返回 is_error=true 的结果，
            // 让 AI 模型能看到错误信息并尝试修正调用参数
            const message = error instanceof Error ? error.message : "MCP 工具调用失败";
            return {
                tool_use_id: "",
                content: `MCP 工具调用失败 [${this.client.serverName}/${this.mcpToolName}]: ${message}`,
                is_error: true,
            };
        }
    }

    /**
     * 是否需要用户批准才能执行
     * MCP 工具默认要求用户批准，因为工具由外部 Server 提供，行为不完全可控
     * @returns 始终返回 true（需要批准）
     */
    requiresApproval(): boolean {
        return true;
    }
}
