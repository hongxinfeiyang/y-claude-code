// ─── packages/core/src/context/__tests__/builder.test.ts ───
// ContextBuilder 单元测试

import { describe, it, expect } from "vitest";
import { ContextBuilder } from "../builder";
import type { LLMProvider } from "../../types/agent";

function makeProvider(ctxWindow = 200_000): LLMProvider {
    return {
        name: "test",
        contextWindow: () => ctxWindow,
        countTokens: async (msgs) => {
            let total = 0;
            for (const m of msgs) {
                const c = typeof m.content === "string" ? m.content : "";
                total += 4 + Math.ceil(c.length / 4);
            }
            return total;
        },
        supportsFeature: () => true,
        async *chat() { yield { type: "stop", reason: "end_turn" }; },
    };
}

describe("ContextBuilder", () => {
    it("应构建包含 system + user 的消息数组", async () => {
        const builder = new ContextBuilder(makeProvider());
        const result = await builder.build({
            systemPrompt: "你是一个助手",
            tools: [],
            history: [],
            userInput: "你好",
            model: "gpt-4o",
        });

        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].role).toBe("system");
        expect(result.messages[0].content).toContain("你是一个助手");
        expect(result.messages[1].role).toBe("user");
        expect(result.messages[1].content).toBe("你好");
    });

    it("应保留已有历史消息", async () => {
        const builder = new ContextBuilder(makeProvider());
        const result = await builder.build({
            systemPrompt: "助手",
            tools: [],
            history: [
                { role: "user", content: "之前的问题" },
                { role: "assistant", content: "之前的回答" },
            ],
            userInput: "新问题",
            model: "gpt-4o",
        });

        expect(result.messages.length).toBeGreaterThanOrEqual(4);
    });

    it("应记录 token 用量", async () => {
        const builder = new ContextBuilder(makeProvider());
        const result = await builder.build({
            systemPrompt: "助手",
            tools: [],
            history: [],
            userInput: "测试",
            model: "gpt-4o",
        });

        expect(result.usage.inputTokens).toBeGreaterThan(0);
    });
});
