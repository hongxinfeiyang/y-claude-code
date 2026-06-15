// ─── packages/core/src/context/__tests__/summarizer.test.ts ───
// 渐进式摘要生成器测试 — 覆盖阈值判断、分块摘要、渐进式合并、自压缩、降级回退

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Summarizer, DEFAULT_SUMMARIZE_CONFIG } from "../summarizer";
import type { Message, LLMProvider, ResponseChunk } from "../../types";

// ─── 辅助：创建 Mock LLM Provider ───

function createMockProvider(chunks: ResponseChunk[]): LLMProvider {
    return {
        name: "mock",
        async *chat() {
            for (const chunk of chunks) {
                yield chunk;
            }
        },
        contextWindow: () => 200_000,
        countTokens: async () => 100,
        supportsFeature: () => true,
    } as unknown as LLMProvider;
}

function createTextChunk(content: string): ResponseChunk {
    return { type: "text", content } as ResponseChunk;
}

function createStopChunk(): ResponseChunk {
    return { type: "stop", reason: "end_turn" } as ResponseChunk;
}

function createMessages(count: number): Message[] {
    const msgs: Message[] = [];
    for (let i = 0; i < count; i++) {
        msgs.push({ role: "user", content: `问题 ${i + 1}: 请帮我写一段代码` });
        msgs.push({ role: "assistant", content: `回答 ${i + 1}: 好的，这是代码:\n\`\`\`typescript\nconst x = ${i};\n\`\`\`` });
    }
    return msgs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// shouldSummarize — 阈值判断
// ═══════════════════════════════════════════════════════════════════════════════

describe("Summarizer — shouldSummarize", () => {
    let summarizer: Summarizer;

    beforeEach(() => {
        summarizer = new Summarizer();
    });

    it("token 占比低于阈值时应返回 false", () => {
        const result = summarizer.shouldSummarize(50_000, 200_000); // 25% < 70%
        expect(result).toBe(false);
    });

    it("token 占比达到阈值时应返回 true", () => {
        const result = summarizer.shouldSummarize(140_000, 200_000); // 70% >= 70%
        expect(result).toBe(true);
    });

    it("token 占比超过阈值时应返回 true", () => {
        const result = summarizer.shouldSummarize(180_000, 200_000); // 90% >= 70%
        expect(result).toBe(true);
    });

    it("禁用摘要时应始终返回 false", () => {
        summarizer = new Summarizer({ enabled: false });
        expect(summarizer.shouldSummarize(180_000, 200_000)).toBe(false);
        expect(summarizer.shouldSummarize(50_000, 200_000)).toBe(false);
    });

    it("自定义阈值应生效", () => {
        summarizer = new Summarizer({ threshold: 0.50 });
        expect(summarizer.shouldSummarize(100_000, 200_000)).toBe(true); // 50% >= 50%
        expect(summarizer.shouldSummarize(80_000, 200_000)).toBe(false); // 40% < 50%
    });

    it("零 token 时应返回 false", () => {
        expect(summarizer.shouldSummarize(0, 200_000)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// summarize — 消息太少不需摘要
// ═══════════════════════════════════════════════════════════════════════════════

describe("Summarizer — 消息太少不需摘要", () => {
    it("非 system 消息 <= recentPreserveCount 时应直接返回原消息", async () => {
        const summarizer = new Summarizer({ recentPreserveCount: 10 });
        const provider = createMockProvider([]);
        const messages: Message[] = [
            { role: "system", content: "system prompt" },
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
        ];

        const result = await summarizer.summarize(messages, provider, "test-model");
        // 消息太少，应原样返回
        expect(result).toBe(messages);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// summarize — 首次摘要（分块）
// ═══════════════════════════════════════════════════════════════════════════════

describe("Summarizer — 首次摘要分块处理", () => {
    it("应保留最近 N 条消息并摘要旧消息", async () => {
        const summarizer = new Summarizer({ chunkSize: 10, recentPreserveCount: 4, progressiveMerge: false });
        const provider = createMockProvider([
            createTextChunk("- 用户询问了多个代码编写问题"),
            createStopChunk(),
        ]);

        const messages = createMessages(12); // 24 条（12 轮问答）
        const result = await summarizer.summarize(messages, provider, "test-model");

        // 结果应包含: system消息(0) + 摘要消息(1) + 最近消息(4)
        // system 消息为 0 条，摘要 1 条，最近保留 4 条
        expect(result.length).toBeLessThan(messages.length);
        // 应有一条摘要消息
        expect(result.some((m) => m.content.toString().includes("对话历史摘要"))).toBe(true);
    });

    it("摘要完成后应更新 summarizedCount", async () => {
        const summarizer = new Summarizer({ chunkSize: 10, recentPreserveCount: 4, progressiveMerge: false });
        const provider = createMockProvider([
            createTextChunk("- 摘要内容"),
            createStopChunk(),
        ]);

        const messages = createMessages(12); // 24 条
        await summarizer.summarize(messages, provider, "test-model");

        // summarizedCount 应更新（旧消息数 = 24 - 4 = 20）
        expect(summarizer["summarizedCount"]).toBe(20);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fallbackTextSummary — 降级回退
// ═══════════════════════════════════════════════════════════════════════════════

describe("Summarizer — LLM 失败时降级为文本摘要", () => {
    it("LLM 返回 error chunk 时应降级为文本截断", async () => {
        const summarizer = new Summarizer({ chunkSize: 5, recentPreserveCount: 2, progressiveMerge: false });
        const provider = createMockProvider([
            { type: "error" as const, code: "api_error", message: "API 错误" },
        ]);

        const messages = createMessages(5); // 10 条
        const result = await summarizer.summarize(messages, provider, "test-model");

        // 应降级成功，包含摘要消息
        expect(result.some((m) => m.content.toString().includes("对话历史摘要"))).toBe(true);
    });

    it("LLM 抛出异常时应降级为文本截断", async () => {
        const summarizer = new Summarizer({ chunkSize: 5, recentPreserveCount: 2, progressiveMerge: false });
        const throwingProvider = {
            name: "mock",
            async *chat() { throw new Error("网络超时"); },
            contextWindow: () => 200_000,
            countTokens: async () => 100,
            supportsFeature: () => true,
        } as unknown as LLMProvider;

        const messages = createMessages(5); // 10 条
        const result = await summarizer.summarize(messages, throwingProvider, "test-model");

        // 降级成功
        expect(result.some((m) => m.content.toString().includes("对话历史摘要"))).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// reset / getAccumulatedSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe("Summarizer — 状态管理", () => {
    it("reset 应清空累积摘要和计数", async () => {
        const summarizer = new Summarizer({ chunkSize: 10, recentPreserveCount: 2, progressiveMerge: false });
        const provider = createMockProvider([
            createTextChunk("- 摘要"),
            createStopChunk(),
        ]);

        await summarizer.summarize(createMessages(10), provider, "test-model");
        expect(summarizer["summarizedCount"]).toBeGreaterThan(0);
        expect(summarizer["accumulatedSummary"]).toBeTruthy();

        summarizer.reset();
        expect(summarizer["summarizedCount"]).toBe(0);
        expect(summarizer["accumulatedSummary"]).toBe("");
    });

    it("getAccumulatedSummary 应返回当前摘要文本", () => {
        const summarizer = new Summarizer();
        expect(summarizer.getAccumulatedSummary()).toBe("");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT_SUMMARIZE_CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

describe("DEFAULT_SUMMARIZE_CONFIG", () => {
    it("应有合理的默认值", () => {
        expect(DEFAULT_SUMMARIZE_CONFIG.enabled).toBe(true);
        expect(DEFAULT_SUMMARIZE_CONFIG.threshold).toBe(0.70);
        expect(DEFAULT_SUMMARIZE_CONFIG.chunkSize).toBeGreaterThan(0);
        expect(DEFAULT_SUMMARIZE_CONFIG.recentPreserveCount).toBeGreaterThan(0);
        expect(DEFAULT_SUMMARIZE_CONFIG.summaryMaxTokens).toBeGreaterThan(0);
        expect(DEFAULT_SUMMARIZE_CONFIG.progressiveMerge).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// chunkMessages — 消息分块
// ═══════════════════════════════════════════════════════════════════════════════

describe("Summarizer — 消息分块", () => {
    it("应正确按 chunkSize 分割消息", () => {
        const summarizer = new Summarizer({ chunkSize: 5 });
        const messages = createMessages(10); // 20 条消息
        const chunks = summarizer["chunkMessages"](messages, 5);

        expect(chunks.length).toBe(4); // 20 / 5 = 4
        expect(chunks[0].length).toBe(5);
        expect(chunks[3].length).toBe(5);
    });

    it("消息数不能被 chunkSize 整除时最后一块应较小", () => {
        const summarizer = new Summarizer({ chunkSize: 7 });
        const messages = createMessages(5); // 10 条
        const chunks = summarizer["chunkMessages"](messages, 7);

        expect(chunks.length).toBe(2);
        expect(chunks[0].length).toBe(7);
        expect(chunks[1].length).toBe(3);
    });

    it("空消息列表应返回空数组", () => {
        const summarizer = new Summarizer();
        expect(summarizer["chunkMessages"]([], 5)).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// messagesToText — 消息转文本
// ═══════════════════════════════════════════════════════════════════════════════

describe("Summarizer — 消息转文本", () => {
    it("应正确格式化字符串类型 content", () => {
        const summarizer = new Summarizer();
        const text = summarizer["messagesToText"]([
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" },
        ]);

        expect(text).toContain("[user]: hello");
        expect(text).toContain("[assistant]: hi there");
    });

    it("应处理数组类型 content（多模态消息）", () => {
        const summarizer = new Summarizer();
        const text = summarizer["messagesToText"]([
            {
                role: "user",
                content: [
                    { type: "text", text: "这是什么" },
                    { type: "image", source: {} as never },
                ],
            },
        ]);

        expect(text).toContain("[user]: 这是什么[图片]");
    });

    it("应处理工具调用和工具结果", () => {
        const summarizer = new Summarizer();
        const text = summarizer["messagesToText"]([
            {
                role: "assistant",
                content: [{ id: "1", name: "read", input: {} }],
            },
            {
                role: "user",
                content: [{ type: "tool_result" as const, tool_use_id: "1", content: "file content here" }],
            },
        ]);

        expect(text).toContain("[工具调用: read]");
        expect(text).toContain("[工具结果: file content here]");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fallbackTextSummary — 降级文本格式
// ═══════════════════════════════════════════════════════════════════════════════

describe("Summarizer — 降级文本摘要格式", () => {
    it("应包含 role 和截断内容", () => {
        const summarizer = new Summarizer();
        const text = summarizer["fallbackTextSummary"]([
            { role: "user", content: "A".repeat(500) },
            { role: "assistant", content: "B".repeat(300) },
        ]);

        expect(text).toContain("[user]");
        expect(text).toContain("[assistant]");
        // 应截断到 200 字符
        expect(text.length).toBeLessThan(500);
    });
});
