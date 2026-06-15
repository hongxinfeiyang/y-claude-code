// ─── packages/core/src/agent/__tests__/integration.test.ts ───
// Agent 集成测试 — 完整流水线：用户输入 → AgentLoop → 事件流（含工具调用）
// 使用 Mock LLM Provider 避免真实 API 调用，验证事件类型和顺序

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentLoop } from "../loop";
import { ExitPlanModeTool } from "../../tools/builtin/plan-mode";
import { createMockProvider, createMockPermissionManager, createMockToolContext } from "../../../__tests__/helpers";
import type { AgentConfig, AgentLoopContext } from "../../types/agent";

describe("AgentLoop 集成测试 — 纯文本响应", () => {
    it("应完整产出 text → done 事件序列", async () => {
        const provider = createMockProvider([
            { type: "text", content: "你好！" },
            { type: "text", content: "有什么可以帮你的？" },
            { type: "stop", usage: { inputTokens: 10, outputTokens: 8 } },
        ]);

        const config: AgentConfig = {
            model: "test-model",
            provider,
            maxToolRounds: 5,
            maxTokensPerTurn: 4096,
            systemPrompt: "你是一个测试助手",
            tools: [],
            thinkingEnabled: false,
        };

        const ctx: AgentLoopContext = {
            permissionManager: createMockPermissionManager(true),
            sessionId: "test-session",
            workingDirectory: "/test",
            appendMessage: vi.fn().mockResolvedValue(undefined),
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
        };

        const loop = new AgentLoop();
        const events: unknown[] = [];

        for await (const event of loop.run("你好", config, ctx)) {
            events.push(event);
        }

        // 验证事件类型序列：text, text, done
        expect(events.length).toBeGreaterThanOrEqual(2);
        expect(events[0]).toHaveProperty("type", "text");
        expect(events[events.length - 1]).toHaveProperty("type", "done");
    });

    it("应累积文本内容", async () => {
        const provider = createMockProvider([
            { type: "text", content: "部分1" },
            { type: "text", content: "部分2" },
            { type: "stop", usage: { inputTokens: 5, outputTokens: 6 } },
        ]);

        const config: AgentConfig = {
            model: "test",
            provider,
            maxToolRounds: 5,
            maxTokensPerTurn: 4096,
            systemPrompt: "test",
            tools: [],
            thinkingEnabled: false,
        };

        const ctx: AgentLoopContext = {
            permissionManager: createMockPermissionManager(true),
            sessionId: "test",
            workingDirectory: "/test",
            appendMessage: vi.fn().mockResolvedValue(undefined),
        };

        const loop = new AgentLoop();
        let fullText = "";

        for await (const event of loop.run("hello", config, ctx)) {
            if (event.type === "text") fullText += event.content;
        }

        expect(fullText).toContain("部分1");
        expect(fullText).toContain("部分2");
    });

    it("done 事件应包含 usage 统计", async () => {
        const provider = createMockProvider([
            { type: "text", content: "test" },
            { type: "stop", usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20 } },
        ]);

        const config: AgentConfig = {
            model: "test",
            provider,
            maxToolRounds: 5,
            maxTokensPerTurn: 4096,
            systemPrompt: "test",
            tools: [],
            thinkingEnabled: false,
        };

        const ctx: AgentLoopContext = {
            permissionManager: createMockPermissionManager(true),
            sessionId: "test",
            workingDirectory: "/test",
            appendMessage: vi.fn().mockResolvedValue(undefined),
        };

        const loop = new AgentLoop();
        const events: unknown[] = [];

        for await (const event of loop.run("hello", config, ctx)) {
            events.push(event);
        }

        const doneEvent = events.find((e) => (e as Record<string, unknown>).type === "done") as Record<string, unknown>;
        expect(doneEvent).toBeDefined();
        const usage = doneEvent.usage as Record<string, number>;
        expect(usage.inputTokens).toBe(100);
        expect(usage.outputTokens).toBe(50);
        expect(usage.cacheReadInputTokens).toBe(20);
    });

    it("LLM 返回错误时应产出 error 事件", async () => {
        const provider = createMockProvider([
            { type: "error", error: new Error("LLM 调用失败") },
            { type: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
        ]);

        const config: AgentConfig = {
            model: "test",
            provider,
            maxToolRounds: 5,
            maxTokensPerTurn: 4096,
            systemPrompt: "test",
            tools: [],
            thinkingEnabled: false,
        };

        const ctx: AgentLoopContext = {
            permissionManager: createMockPermissionManager(true),
            sessionId: "test",
            workingDirectory: "/test",
            appendMessage: vi.fn().mockResolvedValue(undefined),
        };

        const loop = new AgentLoop();
        const events: unknown[] = [];

        for await (const event of loop.run("hello", config, ctx)) {
            events.push(event);
        }

        const errorEvent = events.find((e) => (e as Record<string, unknown>).type === "error");
        expect(errorEvent).toBeDefined();
    });
});

describe("AgentLoop 集成测试 — 工具调用", () => {
    it("应识别 tool_use 并转换为 tool_call 事件", async () => {
        const provider = createMockProvider([
            {
                type: "tool_use",
                id: "toolu_001",
                name: "Read",
                input: { file_path: "/test/file.ts" },
            },
            { type: "stop", usage: { inputTokens: 10, outputTokens: 5, cacheTokens: 0, durationMs: 100 } },
        ]);

        const config: AgentConfig = {
            model: "test",
            provider,
            maxToolRounds: 5,
            maxTokensPerTurn: 4096,
            systemPrompt: "test",
            tools: [],
            thinkingEnabled: false,
        };

        const ctx: AgentLoopContext = {
            permissionManager: createMockPermissionManager(true),
            sessionId: "test",
            workingDirectory: "/test",
            appendMessage: vi.fn().mockResolvedValue(undefined),
            toolContextFactory: () => createMockToolContext(),
        };

        const loop = new AgentLoop();
        const events: unknown[] = [];

        for await (const event of loop.run("读取文件", config, ctx)) {
            events.push(event);
        }

        const toolCallEvent = events.find((e) => (e as Record<string, unknown>).type === "tool_call");
        expect(toolCallEvent).toBeDefined();
        expect((toolCallEvent as Record<string, unknown>).tool).toBeDefined();
    });
});

describe("AgentLoop 集成测试 — 空配置边界", () => {
    it("空 tools 数组不应抛出异常", async () => {
        const provider = createMockProvider([
            { type: "text", content: "ok" },
            { type: "stop", usage: { inputTokens: 1, outputTokens: 1, cacheTokens: 0, durationMs: 10 } },
        ]);

        const config: AgentConfig = {
            model: "test",
            provider,
            maxToolRounds: 0,
            maxTokensPerTurn: 100,
            systemPrompt: "",
            tools: [],
            thinkingEnabled: false,
        };

        const ctx: AgentLoopContext = {
            permissionManager: createMockPermissionManager(true),
            sessionId: "test",
            workingDirectory: "/test",
            appendMessage: vi.fn().mockResolvedValue(undefined),
        };

        const loop = new AgentLoop();
        const events: unknown[] = [];

        await expect(
            (async () => {
                for await (const event of loop.run("", config, ctx)) {
                    events.push(event);
                }
            })(),
        ).resolves.toBeUndefined();
    });

    it("极长用户输入不应崩溃", async () => {
        const provider = createMockProvider([
            { type: "text", content: "received" },
            { type: "stop", usage: { inputTokens: 1, outputTokens: 1, cacheTokens: 0, durationMs: 10 } },
        ]);

        const longInput = "a".repeat(10000);

        const config: AgentConfig = {
            model: "test",
            provider,
            maxToolRounds: 1,
            maxTokensPerTurn: 4096,
            systemPrompt: "test",
            tools: [],
            thinkingEnabled: false,
        };

        const ctx: AgentLoopContext = {
            permissionManager: createMockPermissionManager(true),
            sessionId: "test",
            workingDirectory: "/test",
            appendMessage: vi.fn().mockResolvedValue(undefined),
        };

        const loop = new AgentLoop();
        const events: unknown[] = [];

        await expect(
            (async () => {
                for await (const event of loop.run(longInput, config, ctx)) {
                    events.push(event);
                }
            })(),
        ).resolves.toBeUndefined();
    });
});
