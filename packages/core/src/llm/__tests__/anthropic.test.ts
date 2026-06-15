// ─── packages/core/src/llm/__tests__/anthropic.test.ts ───
// Anthropic Provider 单元测试 — 覆盖 contextWindow、supportsFeature、countTokens

import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "../anthropic";
import type { Message } from "../../types";

// ─── 辅助：创建测试消息 ───

function msg(role: "user" | "assistant" | "system", content: string): Message {
    return { role, content } as Message;
}

// ═══════════════════════════════════════════════════════════════════════════════
// contextWindow — 上下文窗口查询
// ═══════════════════════════════════════════════════════════════════════════════

describe("AnthropicProvider — contextWindow", () => {
    const provider = new AnthropicProvider("sk-ant-test");

    it("已知模型应返回正确的窗口大小", () => {
        expect(provider.contextWindow("claude-sonnet-4-6")).toBe(200_000);
        expect(provider.contextWindow("claude-opus-4-7")).toBe(1_000_000);
        expect(provider.contextWindow("claude-haiku-4-5")).toBe(200_000);
    });

    it("未知模型应返回默认值 200000", () => {
        expect(provider.contextWindow("unknown-model")).toBe(200_000);
    });

    it("空模型名应返回默认值", () => {
        expect(provider.contextWindow("")).toBe(200_000);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// supportsFeature — 特性检测
// ═══════════════════════════════════════════════════════════════════════════════

describe("AnthropicProvider — supportsFeature", () => {
    const provider = new AnthropicProvider("sk-ant-test");

    it("应支持 thinking", () => {
        expect(provider.supportsFeature("thinking")).toBe(true);
    });

    it("应支持 caching", () => {
        expect(provider.supportsFeature("caching")).toBe(true);
    });

    it("应支持 vision", () => {
        expect(provider.supportsFeature("vision")).toBe(true);
    });

    it("应支持 tools", () => {
        expect(provider.supportsFeature("tools")).toBe(true);
    });

    it("不支持的 feature 应返回 false", () => {
        expect(provider.supportsFeature("streaming")).toBe(false);
        expect(provider.supportsFeature("batch")).toBe(false);
        expect(provider.supportsFeature("")).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// countTokens — Token 估算
// ═══════════════════════════════════════════════════════════════════════════════

describe("AnthropicProvider — countTokens", () => {
    const provider = new AnthropicProvider("sk-ant-test");

    it("空消息数组应返回 0", async () => {
        const count = await provider.countTokens([]);
        expect(count).toBe(0);
    });

    it("单条消息应合理估算 token 数", async () => {
        const count = await provider.countTokens([
            msg("user", "hello"),
        ]);
        expect(count).toBeGreaterThan(0);
        // "hello" = 5 字符 / 4 ≈ 2 tokens
        expect(count).toBe(2);
    });

    it("多条消息应累加 token 数", async () => {
        const count = await provider.countTokens([
            msg("user", "hello"),
            msg("assistant", "hi there"),
        ]);
        // "hello"=2 + "hi there"=2 = 4
        expect(count).toBe(4);
    });

    it("较长消息应正确估算", async () => {
        const count = await provider.countTokens([
            msg("user", "The quick brown fox jumps over the lazy dog"), // 43 chars / 4 = 11
        ]);
        expect(count).toBe(11);
    });

    it("系统消息也应计入 token", async () => {
        const count = await provider.countTokens([
            msg("system", "You are a helpful assistant."), // 30 chars / 4 = 8
            msg("user", "Hi"), // 2 chars / 4 = 1
        ]);
        expect(count).toBe(8);
    });

    it("包含多模态 content（数组格式）也应正确估算", async () => {
        const count = await provider.countTokens([
            {
                role: "user",
                content: [
                    { type: "text", text: "describe this" }, // 14 chars / 4 = 4
                    { type: "image", source: { type: "base64", media_type: "image/png", data: "base64datahere" } },
                ],
            },
        ]);
        // text "describe this" = 4 + image block JSON = longer
        expect(count).toBeGreaterThan(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 构造与基础属性
// ═══════════════════════════════════════════════════════════════════════════════

describe("AnthropicProvider — 构造", () => {
    it("name 属性应为 anthropic", () => {
        const provider = new AnthropicProvider("sk-ant-test");
        expect(provider.name).toBe("anthropic");
    });

    it("应接受 baseURL 参数", () => {
        const provider = new AnthropicProvider("sk-ant-test", "https://api.example.com");
        expect(provider.name).toBe("anthropic");
    });
});
