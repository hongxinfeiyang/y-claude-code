// ─── packages/mcp/src/__tests__/client.test.ts ───
// MCPClient 单元测试 — 验证 JSON-RPC 通信、连接生命周期、工具操作

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCPClient } from "../client";
import type { MCPServerConfig } from "../types";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

// ─── Mock child_process ───
// 通过 vi.mock 拦截 spawn 调用，返回可控的 mock 子进程

let mockStdin: Writable;
let mockStdout: Readable;
let mockStderr: Readable;
let mockProcess: EventEmitter;

vi.mock("node:child_process", () => ({
    spawn: vi.fn(() => {
        mockStdin = new Writable({
            write(_chunk, _encoding, callback) { callback(); },
        });
        mockStdout = new Readable({ read() {} });
        mockStderr = new Readable({ read() {} });
        mockProcess = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: Readable; stderr: Readable; kill: () => void; pid: number };
        Object.assign(mockProcess, {
            stdin: mockStdin,
            stdout: mockStdout,
            stderr: mockStderr,
            kill: vi.fn(),
            pid: 12345,
        });
        return mockProcess;
    }),
}));

function createConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
    return {
        name: "test-mcp-server",
        command: "node",
        args: ["server.js"],
        connectTimeout: 5000,
        ...overrides,
    };
}

describe("MCPClient", () => {
    let client: MCPClient;

    beforeEach(() => {
        client = new MCPClient(createConfig());
    });

    afterEach(() => {
        client.disconnect();
    });

    // ─── 构造 ───
    it("应从配置中获取 serverName", () => {
        expect(client.serverName).toBe("test-mcp-server");
    });

    // ─── connect 初始化握手 ───
    it("connect 应发送 initialize 请求并完成握手", async () => {
        const connectPromise = client.connect();

        // 等待子进程启动 + readline 建立
        await vi.waitFor(() => mockProcess.listenerCount("exit") > 0, { timeout: 1000 });

        // 模拟 Server 返回 initialize 响应
        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
                name: "test-mcp-server",
                version: "1.0.0",
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
            },
        }) + "\n");

        const info = await connectPromise;
        expect(info.name).toBe("test-mcp-server");
        expect(info.version).toBe("1.0.0");
        expect(info.protocolVersion).toBe("2025-03-26");
    });

    it("connect 超时时应抛出异常", async () => {
        const shortTimeoutClient = new MCPClient(createConfig({ connectTimeout: 100 }));
        const connectPromise = shortTimeoutClient.connect();

        await expect(connectPromise).rejects.toThrow("连接超时");
        shortTimeoutClient.disconnect();
    });

    it("子进程异常退出时 connect 应失败", async () => {
        const connectPromise = client.connect();

        await vi.waitFor(() => mockProcess.listenerCount("exit") > 0, { timeout: 1000 });

        mockProcess.emit("exit", 1); // 异常退出

        await expect(connectPromise).rejects.toThrow("异常退出");
    });

    it("子进程启动错误时 connect 应失败", async () => {
        const connectPromise = client.connect();

        await vi.waitFor(() => mockProcess.listenerCount("error") > 0, { timeout: 1000 });

        mockProcess.emit("error", new Error("ENOENT"));

        await expect(connectPromise).rejects.toThrow("ENOENT");
    });

    // ─── getServerInfo ───
    it("未连接时 getServerInfo 应返回 null", () => {
        expect(client.getServerInfo()).toBeNull();
    });

    it("连接后 getServerInfo 应返回服务器信息", async () => {
        const connectPromise = client.connect();
        await vi.waitFor(() => mockProcess.listenerCount("exit") > 0, { timeout: 1000 });

        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { name: "srv", version: "2.0", protocolVersion: "2025-03-26", capabilities: {} },
        }) + "\n");

        await connectPromise;
        expect(client.getServerInfo()?.name).toBe("srv");
    });

    // ─── listTools ───
    it("listTools 应发送 tools/list 请求并返回工具列表", async () => {
        const connectPromise = client.connect();
        await vi.waitFor(() => mockProcess.listenerCount("exit") > 0, { timeout: 1000 });

        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { name: "srv", version: "1.0", protocolVersion: "2025-03-26", capabilities: {} },
        }) + "\n");
        await connectPromise;

        // 发起 listTools
        const listPromise = client.listTools();

        // 此时 id 应为 2（因为 initialize 用了 id=1）
        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: {
                tools: [
                    { name: "read_file", description: "读取文件", inputSchema: { type: "object", properties: {} } },
                    { name: "write_file", description: "写入文件", inputSchema: { type: "object", properties: {} } },
                ],
            },
        }) + "\n");

        const tools = await listPromise;
        expect(tools).toHaveLength(2);
        expect(tools[0].name).toBe("read_file");
        expect(tools[1].name).toBe("write_file");
    });

    // ─── getCachedTools ───
    it("getCachedTools 应返回缓存的工具列表", async () => {
        const connectPromise = client.connect();
        await vi.waitFor(() => mockProcess.listenerCount("exit") > 0, { timeout: 1000 });

        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { name: "srv", version: "1.0", protocolVersion: "2025-03-26", capabilities: {} },
        }) + "\n");
        await connectPromise;

        // 初始缓存为空
        expect(client.getCachedTools()).toHaveLength(0);

        // listTools 后缓存更新
        const listPromise = client.listTools();
        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { tools: [{ name: "tool1", description: "desc", inputSchema: { type: "object", properties: {} } }] },
        }) + "\n");
        await listPromise;

        expect(client.getCachedTools()).toHaveLength(1);
    });

    // ─── callTool ───
    it("callTool 应发送 tools/call 请求并返回结果", async () => {
        const connectPromise = client.connect();
        await vi.waitFor(() => mockProcess.listenerCount("exit") > 0, { timeout: 1000 });

        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { name: "srv", version: "1.0", protocolVersion: "2025-03-26", capabilities: {} },
        }) + "\n");
        await connectPromise;

        const callPromise = client.callTool("read_file", { path: "/tmp/test.txt" });
        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: "文件内容" }], isError: false },
        }) + "\n");

        const result = await callPromise;
        expect(result.content).toHaveLength(1);
        expect(result.content[0].text).toBe("文件内容");
        expect(result.isError).toBe(false);
    });

    // ─── callTool 错误响应 ───
    it("JSON-RPC 错误响应应抛出异常", async () => {
        const connectPromise = client.connect();
        await vi.waitFor(() => mockProcess.listenerCount("exit") > 0, { timeout: 1000 });

        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { name: "srv", version: "1.0", protocolVersion: "2025-03-26", capabilities: {} },
        }) + "\n");
        await connectPromise;

        const callPromise = client.callTool("bad_tool", {});
        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            error: { code: -32601, message: "Method not found" },
        }) + "\n");

        await expect(callPromise).rejects.toThrow("Method not found");
    });

    // ─── disconnect 清理 ───
    it("disconnect 应 kill 子进程并清空 pending 请求", async () => {
        const connectPromise = client.connect();
        await vi.waitFor(() => mockProcess.listenerCount("exit") > 0, { timeout: 1000 });

        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { name: "srv", version: "1.0", protocolVersion: "2025-03-26", capabilities: {} },
        }) + "\n");
        await connectPromise;

        client.disconnect();

        expect(mockProcess.kill).toHaveBeenCalled();
    });

    // ─── 非法 JSON 行应被静默忽略 ───
    it("非 JSON 的 stdout 输出应被静默忽略", async () => {
        const connectPromise = client.connect();
        await vi.waitFor(() => mockProcess.listenerCount("exit") > 0, { timeout: 1000 });

        // 先发一行非法内容
        mockStdout.push("这不是 JSON\n");

        // 然后发正确的 initialize 响应
        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { name: "srv", version: "1.0", protocolVersion: "2025-03-26", capabilities: {} },
        }) + "\n");

        const info = await connectPromise;
        expect(info.name).toBe("srv");
    });

    // ─── resources 操作 ───
    it("listResources 应发送 resources/list 请求", async () => {
        const connectPromise = client.connect();
        await vi.waitFor(() => mockProcess.listenerCount("exit") > 0, { timeout: 1000 });

        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { name: "srv", version: "1.0", protocolVersion: "2025-03-26", capabilities: {} },
        }) + "\n");
        await connectPromise;

        const listPromise = client.listResources();
        mockStdout.push(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { resources: [{ uri: "file:///data.csv", name: "data" }] },
        }) + "\n");

        const resources = await listPromise;
        expect(resources).toHaveLength(1);
    });
});
