// ─── packages/core/src/agent/__tests__/loop.test.ts ───
// AgentLoop 集成测试

import { describe, it, expect, vi } from "vitest";
import { AgentLoop } from "../loop";
import type { AgentLoopContext } from "../loop";
import { AgentState } from "../../types/agent";
import type { AgentConfig } from "../../types/agent";
import { createMockProvider, createMockPermissionManager } from "../../../__tests__/helpers";
import { ReadTool } from "../../tools/builtin/read";
import type { Tool } from "../../types/tools";

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
    return {
        model: "test",
        provider: createMockProvider([{ type: "text", content: "hello" }, { type: "stop", reason: "end_turn" }]),
        maxToolRounds: 5,
        maxTokensPerTurn: 1000,
        systemPrompt: "test",
        tools: [],
        thinkingEnabled: false,
        ...overrides,
    };
}

function makeLoopCtx(overrides?: Partial<AgentLoopContext>): AgentLoopContext {
    return {
        permissionManager: createMockPermissionManager(),
        sessionId: "test",
        workingDirectory: "/project",
        appendMessage: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe("AgentLoop", () => {
    // ─── 简单文本对话 ───
    it("单轮纯文本应产出 text + done 事件", async () => {
        const config = makeConfig({
            provider: createMockProvider([
                { type: "text", content: "你好，有什么可以帮你的？" },
                { type: "stop", reason: "end_turn" },
            ]),
        });
        const loop = new AgentLoop();
        const events: Array<{ type: string; content?: string }> = [];

        for await (const event of loop.run("hello", config, makeLoopCtx())) {
            if (event.type === "text") events.push({ type: "text", content: event.content });
            if (event.type === "done") events.push({ type: "done" });
        }

        expect(events).toContainEqual({ type: "text", content: "你好，有什么可以帮你的？" });
        expect(events).toContainEqual({ type: "done" });
    });

    // ─── 工具调用循环 ───
    it("应完成 text → tool_use → tool_result → done 完整循环", async () => {
        const readTool = new ReadTool();
        const config = makeConfig({
            provider: createMockProvider([
                { type: "text", content: "让我读取文件" },
                { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/nonexistent" } },
                { type: "stop", reason: "end_turn" },
            ]),
            tools: [readTool as unknown as Tool],
        });
        const loop = new AgentLoop();
        const eventTypes: string[] = [];

        for await (const event of loop.run("读取 /nonexistent", config, makeLoopCtx())) {
            eventTypes.push(event.type);
        }

        expect(eventTypes).toContain("text");
        expect(eventTypes).toContain("tool_call");
        expect(eventTypes).toContain("tool_result");
        expect(eventTypes).toContain("done");
    });

    // ─── 停止条件 ───
    it("无工具调用时应结束", async () => {
        const config = makeConfig({
            provider: createMockProvider([{ type: "stop", reason: "end_turn" }]),
        });
        const loop = new AgentLoop();
        const events: Array<{ type: string }> = [];

        for await (const event of loop.run("test", config, makeLoopCtx())) {
            events.push({ type: event.type });
        }

        expect(events).toContainEqual({ type: "done" });
    });

    it("达到 maxToolRounds 应强制停止", async () => {
        const config = makeConfig({
            provider: createMockProvider([
                { type: "tool_use", id: "1", name: "Read", input: { file_path: "/x" } },
                { type: "stop", reason: "end_turn" },
            ]),
            tools: [new ReadTool() as unknown as Tool],
            maxToolRounds: 2,
        });
        const loop = new AgentLoop();
        let errorCount = 0;

        for await (const event of loop.run("test", config, makeLoopCtx())) {
            if (event.type === "error") errorCount++;
        }

        expect(errorCount).toBeGreaterThan(0);
    });

    // ─── LLM 错误处理 ───
    it("LLM 返回 error chunk 应产出 error 事件并终止", async () => {
        const config = makeConfig({
            provider: createMockProvider([
                { type: "error", code: "test_error", message: "模拟错误" },
            ]),
        });
        const loop = new AgentLoop();
        const errors: Array<{ type: string }> = [];

        for await (const event of loop.run("test", config, makeLoopCtx())) {
            if (event.type === "error") errors.push({ type: "error" });
        }

        expect(errors.length).toBeGreaterThan(0);
    });

    // ─── 状态 ───
    it("初始状态应为 IDLE", () => {
        const loop = new AgentLoop();
        expect(loop.getState()).toBe(AgentState.IDLE);
    });

    it("run 结束后状态应为 DONE 或 ERROR", async () => {
        const config = makeConfig();
        const loop = new AgentLoop();

        for await (const _event of loop.run("test", config, makeLoopCtx())) {
            // 消费所有事件
        }

        expect([AgentState.DONE, AgentState.ERROR]).toContain(loop.getState());
    });

    // ─── 消息历史 ───
    it("loadHistory 应恢复历史消息", () => {
        const loop = new AgentLoop();
        loop.loadHistory([{ role: "user", content: "test" }]);
        expect(loop.getMessages()).toHaveLength(1);
    });

    // ─── 多轮对话场景 ───
    it("多轮工具调用应正确累积消息历史", async () => {
        const readTool = new ReadTool();
        const config = makeConfig({
            provider: createMockProvider([
                // 第 1 轮：工具调用
                { type: "tool_use", id: "1", name: "Read", input: { file_path: "/project/a.ts" } },
                { type: "stop", reason: "end_turn" },
                // 第 2 轮：文本回复
                { type: "text", content: "文件内容如上" },
                { type: "stop", reason: "end_turn" },
            ]),
            tools: [readTool as unknown as Tool],
            maxToolRounds: 5,
        });
        const loop = new AgentLoop();
        const eventTypes: string[] = [];

        for await (const event of loop.run("读取文件", config, makeLoopCtx())) {
            eventTypes.push(event.type);
        }

        // 应包含所有阶段的事件类型
        expect(eventTypes).toContain("tool_call");
        expect(eventTypes).toContain("tool_result");
        expect(eventTypes).toContain("text");
        expect(eventTypes).toContain("done");
        // 消息历史应包含 user + tool_use + tool_result + assistant
        const messages = loop.getMessages();
        expect(messages.length).toBeGreaterThanOrEqual(3);
    });

    // ─── 工具执行错误恢复 ───
    it("工具执行出错时应产出 error 事件但继续运行", async () => {
        const config = makeConfig({
            provider: createMockProvider([
                { type: "tool_use", id: "err1", name: "Read", input: { file_path: "/etc/passwd" } },
                { type: "stop", reason: "end_turn" },
            ]),
            tools: [new ReadTool() as unknown as Tool],
            maxToolRounds: 3,
        });
        const loop = new AgentLoop();
        let hasToolCall = false;
        let hasToolResult = false;

        for await (const event of loop.run("读系统文件", config, makeLoopCtx())) {
            if (event.type === "tool_call") hasToolCall = true;
            if (event.type === "tool_result" && event.result.is_error) hasToolResult = true;
        }

        expect(hasToolCall).toBe(true);
        // 读取 /etc/passwd 不在工作目录内，应返回错误
        expect(hasToolResult).toBe(true);
    });

    // ─── thinking 事件 ───
    it("扩展思考模型应产出 thinking 事件", async () => {
        const config = makeConfig({
            provider: createMockProvider([
                { type: "thinking", content: "分析用户意图中..." },
                { type: "text", content: "答案" },
                { type: "stop", reason: "end_turn" },
            ]),
            thinkingEnabled: true,
        });
        const loop = new AgentLoop();
        let hasThinking = false;

        for await (const event of loop.run("问题", config, makeLoopCtx())) {
            if (event.type === "thinking") hasThinking = true;
        }

        expect(hasThinking).toBe(true);
    });

    // ─── 空输入处理 ───
    it("空消息应快速返回 done", async () => {
        const config = makeConfig();
        const loop = new AgentLoop();
        const events: string[] = [];

        for await (const event of loop.run("", config, makeLoopCtx())) {
            events.push(event.type);
        }

        expect(events).toContain("done");
    });

    // ─── 连续多次 run 应重置状态 ───
    it("连续 run 应能正确处理多次独立对话", async () => {
        const config = makeConfig({
            provider: createMockProvider([
                { type: "text", content: "第一次" },
                { type: "stop", reason: "end_turn" },
            ]),
        });
        const loop = new AgentLoop();

        // 第一次对话
        const results1: string[] = [];
        for await (const event of loop.run("msg1", config, makeLoopCtx())) {
            if (event.type === "text") results1.push(event.content);
        }
        expect(results1).toContain("第一次");

        // 第二次对话
        const results2: string[] = [];
        for await (const event of loop.run("msg2", config, makeLoopCtx())) {
            if (event.type === "text") results2.push(event.content);
        }
        expect(results2).toContain("第一次");
    });
});
