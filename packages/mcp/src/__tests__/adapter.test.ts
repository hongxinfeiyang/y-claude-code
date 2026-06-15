// ─── packages/mcp/src/__tests__/adapter.test.ts ───
// MCPToolAdapter 单元测试 — 验证 MCP 工具适配器将远程工具正确包装为 core Tool 实例

import { describe, it, expect, vi } from "vitest";
import { MCPToolAdapter } from "../adapter";
import type { MCPClient } from "../client";
import type { MCPToolDefinition, MCPToolCallResult } from "../types";
import type { ToolContext } from "@y-claude-code/core";

function createMockClient(overrides: Partial<{
    serverName: string;
    callToolResult: MCPToolCallResult;
    callToolError: Error;
}> = {}): MCPClient {
    return {
        serverName: overrides.serverName ?? "test-server",
        callTool: vi.fn().mockImplementation(async (_name: string, _args: Record<string, unknown>) => {
            if (overrides.callToolError) throw overrides.callToolError;
            return overrides.callToolResult ?? {
                content: [{ type: "text", text: "ok" }],
                isError: false,
            };
        }),
    } as unknown as MCPClient;
}

function createMockToolDef(overrides: Partial<MCPToolDefinition> = {}): MCPToolDefinition {
    return {
        name: "test_tool",
        description: "测试工具",
        inputSchema: {
            type: "object",
            properties: { query: { type: "string", description: "搜索关键词" } },
            required: ["query"],
        },
        ...overrides,
    };
}

function createMockContext(): ToolContext {
    return {
        workingDirectory: "/tmp/test",
        sessionId: "test-session",
        signal: undefined,
        sandbox: undefined,
        logger: undefined,
        appendMessage: async () => {},
    } as ToolContext;
}

describe("MCPToolAdapter", () => {
    // ─── 构造与元数据 ───
    it("应用 MCP 命名空间前缀构造工具名", () => {
        const client = createMockClient({ serverName: "filesystem" });
        const adapter = new MCPToolAdapter(client, createMockToolDef({ name: "read_file" }));
        expect(adapter.name).toBe("mcp__filesystem__read_file");
    });

    it("应在描述中标注 MCP Server 来源", () => {
        const client = createMockClient({ serverName: "github" });
        const adapter = new MCPToolAdapter(client, createMockToolDef({ description: "列出 Issues" }));
        expect(adapter.description).toContain("[MCP:github]");
        expect(adapter.description).toContain("列出 Issues");
    });

    it("应正确映射 JSON Schema 参数定义", () => {
        const client = createMockClient();
        const adapter = new MCPToolAdapter(client, createMockToolDef({
            inputSchema: {
                type: "object",
                properties: { repo: { type: "string" } },
                required: ["repo"],
            },
        }));
        expect(adapter.parameters.type).toBe("object");
        expect(adapter.parameters.required).toEqual(["repo"]);
    });

    // ─── execute 正常流程 ───
    it("execute 应调用 MCPClient.callTool 并返回文本结果", async () => {
        const client = createMockClient({
            callToolResult: {
                content: [{ type: "text", text: "查询结果: 42 条记录" }],
                isError: false,
            },
        });
        const adapter = new MCPToolAdapter(client, createMockToolDef({ name: "search" }));
        const result = await adapter.execute({ query: "test" }, createMockContext());

        expect(result.is_error).toBeFalsy();
        expect(result.content).toContain("查询结果: 42 条记录");
        expect(client.callTool).toHaveBeenCalledWith("search", { query: "test" });
    });

    // ─── execute 多 content 合并 ───
    it("应合并多个 content 项为单个文本输出", async () => {
        const client = createMockClient({
            callToolResult: {
                content: [
                    { type: "text", text: "第一段" },
                    { type: "text", text: "第二段" },
                ],
                isError: false,
            },
        });
        const adapter = new MCPToolAdapter(client, createMockToolDef());
        const result = await adapter.execute({}, createMockContext());

        expect(result.content).toContain("第一段");
        expect(result.content).toContain("第二段");
    });

    // ─── execute 图片 content 处理 ───
    it("应将图片类型 content 转换为占位符", async () => {
        const client = createMockClient({
            callToolResult: {
                content: [{ type: "image", data: "base64...", mimeType: "image/png" }],
                isError: false,
            },
        });
        const adapter = new MCPToolAdapter(client, createMockToolDef());
        const result = await adapter.execute({}, createMockContext());

        expect(result.content).toContain("[图片: image/png]");
    });

    it("图片无 mimeType 时应显示 unknown", async () => {
        const client = createMockClient({
            callToolResult: {
                content: [{ type: "image", data: "base64..." }],
                isError: false,
            },
        });
        const adapter = new MCPToolAdapter(client, createMockToolDef());
        const result = await adapter.execute({}, createMockContext());

        expect(result.content).toContain("[图片: unknown]");
    });

    // ─── execute 错误处理 ───
    it("MCP Server 返回 isError 时应正确标记", async () => {
        const client = createMockClient({
            callToolResult: {
                content: [{ type: "text", text: "权限不足" }],
                isError: true,
            },
        });
        const adapter = new MCPToolAdapter(client, createMockToolDef());
        const result = await adapter.execute({}, createMockContext());

        expect(result.is_error).toBe(true);
        expect(result.content).toContain("权限不足");
    });

    it("MCP 调用抛异常时应返回错误结果而不向上抛出", async () => {
        const client = createMockClient({
            callToolError: new Error("连接超时"),
        });
        const adapter = new MCPToolAdapter(client, createMockToolDef({ name: "remote_search" }));
        const result = await adapter.execute({ query: "test" }, createMockContext());

        expect(result.is_error).toBe(true);
        expect(result.content).toContain("MCP 工具调用失败");
        expect(result.content).toContain("连接超时");
        expect(result.content).toContain("test-server");
        expect(result.content).toContain("remote_search");
    });

    // ─── requiresApproval ───
    it("MCP 工具默认需要用户审批", () => {
        const client = createMockClient();
        const adapter = new MCPToolAdapter(client, createMockToolDef());
        expect(adapter.requiresApproval()).toBe(true);
    });

    // ─── 空结果处理 ───
    it("MCP 返回空 content 时应显示占位文本", async () => {
        const client = createMockClient({
            callToolResult: { content: [], isError: false },
        });
        const adapter = new MCPToolAdapter(client, createMockToolDef());
        const result = await adapter.execute({}, createMockContext());

        expect(result.content).toBe("(空结果)");
    });
});
