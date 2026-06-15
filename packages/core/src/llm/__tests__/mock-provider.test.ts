// ─── packages/core/src/llm/__tests__/mock-provider.test.ts ───
// LLM Mock Provider 测试 — 验证各种响应模式的模拟行为

import { describe, it, expect, vi } from "vitest";
import { createMockProvider } from "../../../__tests__/helpers";
import type { ResponseChunk } from "../../types/messages";

describe("Mock LLM Provider", () => {
    // ─── 基础文本响应 ───
    it("应能产出文本 chunk 序列", async () => {
        const provider = createMockProvider([
            { type: "text", content: "Hello" },
            { type: "text", content: " World" },
            { type: "stop", reason: "end_turn" },
        ]);

        const chunks: ResponseChunk[] = [];
        for await (const chunk of provider.chat([{ role: "user", content: "hi" }], { model: "test", maxTokens: 100 })) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(3);
        expect(chunks[0]).toEqual({ type: "text", content: "Hello" });
        expect(chunks[1]).toEqual({ type: "text", content: " World" });
        expect(chunks[2]).toEqual({ type: "stop", reason: "end_turn" });
    });

    // ─── 工具调用响应 ───
    it("应能产出 tool_use chunk", async () => {
        const provider = createMockProvider([
            { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/test.ts" } },
            { type: "stop", reason: "tool_use" },
        ]);

        const chunks: ResponseChunk[] = [];
        for await (const chunk of provider.chat([{ role: "user", content: "read file" }], { model: "test", maxTokens: 100 })) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(2);
        expect(chunks[0].type).toBe("tool_use");
        if (chunks[0].type === "tool_use") {
            expect(chunks[0].name).toBe("Read");
            expect(chunks[0].input).toEqual({ file_path: "/test.ts" });
        }
    });

    // ─── 错误 chunk ───
    it("应能产出 error chunk", async () => {
        const provider = createMockProvider([
            { type: "error", code: "rate_limit", message: "请求过于频繁" },
        ]);

        const chunks: ResponseChunk[] = [];
        for await (const chunk of provider.chat([{ role: "user", content: "test" }], { model: "test", maxTokens: 100 })) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(1);
        expect(chunks[0].type).toBe("error");
        if (chunks[0].type === "error") {
            expect(chunks[0].code).toBe("rate_limit");
        }
    });

    // ─── 多轮工具调用 ───
    it("应能模拟多轮工具调用序列", async () => {
        const provider = createMockProvider([
            // 第 1 轮
            { type: "text", content: "分析中..." },
            { type: "tool_use", id: "1", name: "Read", input: { file_path: "/a.ts" } },
            { type: "stop", reason: "tool_use" },
            // 第 2 轮
            { type: "text", content: "需要修改" },
            { type: "tool_use", id: "2", name: "Edit", input: { file_path: "/a.ts", old_string: "x", new_string: "y" } },
            { type: "stop", reason: "tool_use" },
            // 第 3 轮（最终回复）
            { type: "text", content: "修改完成" },
            { type: "stop", reason: "end_turn" },
        ]);

        const allChunks: ResponseChunk[] = [];
        for await (const chunk of provider.chat([{ role: "user", content: "refactor" }], { model: "test", maxTokens: 100 })) {
            allChunks.push(chunk);
        }

        const toolCalls = allChunks.filter((c) => c.type === "tool_use");
        const texts = allChunks.filter((c) => c.type === "text");

        expect(toolCalls).toHaveLength(2);
        // mock 按顺序产出全部 chunk，包含 3 段文本
        expect(texts).toHaveLength(3);
    });

    // ─── 空响应 ───
    it("空 chunk 序列应正确结束", async () => {
        const provider = createMockProvider([
            { type: "stop", reason: "end_turn" },
        ]);

        const chunks: ResponseChunk[] = [];
        for await (const chunk of provider.chat([{ role: "user", content: "test" }], { model: "test", maxTokens: 100 })) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(1);
        expect(chunks[0].type).toBe("stop");
    });

    // ─── Thinking 响应 ───
    it("应能产出 thinking chunk", async () => {
        const provider = createMockProvider([
            { type: "thinking", content: "让我分析这个问题..." },
            { type: "text", content: "分析结果: ..." },
            { type: "stop", reason: "end_turn" },
        ]);

        const chunks: ResponseChunk[] = [];
        for await (const chunk of provider.chat([{ role: "user", content: "complex question" }], { model: "test", maxTokens: 100 })) {
            chunks.push(chunk);
        }

        expect(chunks[0].type).toBe("thinking");
        expect(chunks[1].type).toBe("text");
        expect(chunks[2].type).toBe("stop");
    });

    // ─── 上下文窗口大小 ───
    it("应报告正确的上下文窗口大小", () => {
        const provider = createMockProvider([], 128_000);
        expect(provider.contextWindow("test-model")).toBe(128_000);
    });

    // ─── Token 计数模拟 ───
    it("countTokens 应返回预设值", async () => {
        const provider = createMockProvider([], 200_000);
        const count = await provider.countTokens([{ role: "user", content: "hello world" }]);
        expect(count).toBe(100); // mock 默认返回值
    });
});
