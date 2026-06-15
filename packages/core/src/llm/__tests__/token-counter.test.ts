// ─── packages/core/src/llm/__tests__/token-counter.test.ts ───
// TokenCounter 单元测试

import { describe, it, expect } from "vitest";
import { TokenCounter } from "../token-counter";

describe("TokenCounter", () => {
    const counter = new TokenCounter();

    // ─── 字符估算 ───
    it("estimateTokens 应为非负数", () => {
        const tokens = counter.estimateTokens([{ role: "user", content: "hello" }]);
        expect(tokens).toBeGreaterThan(0);
    });

    it("空消息应返回基础开销", () => {
        const tokens = counter.estimateTokens([{ role: "user", content: "" }]);
        expect(tokens).toBeGreaterThan(0); // 4 tokens 角色开销
    });

    it("多条消息应递增", () => {
        const single = counter.estimateTokens([{ role: "user", content: "hello" }]);
        const double = counter.estimateTokens([
            { role: "user", content: "hello" },
            { role: "assistant", content: "world" },
        ]);
        expect(double).toBeGreaterThan(single);
    });

    // ─── 上下文窗口 ───
    it("应返回已知模型的正确窗口大小", () => {
        expect(counter.getContextWindow("gpt-4o")).toBe(128_000);
        expect(counter.getContextWindow("claude-opus-4-7")).toBe(1_000_000);
        expect(counter.getContextWindow("deepseek-chat")).toBe(128_000);
    });

    it("未知模型应返回默认窗口大小", () => {
        expect(counter.getContextWindow("unknown-model")).toBe(128_000);
    });

    // ─── 剩余 Token ───
    it("应正确计算剩余 Token", () => {
        const remaining = counter.remainingTokens(10_000, "gpt-4o");
        // 128000 - 10000 - 0.15 * 128000 = 128000 - 10000 - 19200 = 98800
        expect(remaining).toBeCloseTo(98_800, -2);
    });
});

// ─── cache.test — Prompt Cache ───
import { calculateCacheHitRate, markCacheable } from "../token-counter";

describe("Prompt Cache", () => {
    it("markCacheable 应附加 cache_control", () => {
        const block = { type: "text", text: "test" };
        const cached = markCacheable(block);
        expect(cached.cache_control).toEqual({ type: "ephemeral" });
        expect(cached.text).toBe("test");
    });

    it("calculateCacheHitRate 50% 读写应返回 50", () => {
        expect(calculateCacheHitRate(1000, 1000)).toBe(50);
    });

    it("全是 write 命中率应为 0", () => {
        expect(calculateCacheHitRate(1000, 0)).toBe(0);
    });

    it("全是 read 命中率应为 100", () => {
        expect(calculateCacheHitRate(0, 1000)).toBe(100);
    });

    it("空值应返回 0", () => {
        expect(calculateCacheHitRate(0, 0)).toBe(0);
    });
});
