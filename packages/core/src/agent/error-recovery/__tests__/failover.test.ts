// ─── packages/core/src/agent/error-recovery/__tests__/failover.test.ts ───
// ProviderFailoverManager 单元测试 — 验证 Provider 故障切换链

import { describe, it, expect } from "vitest";
import { ProviderFailoverManager } from "../failover";
import type { LLMProvider } from "../../../types/agent";

function createMockProvider(name: string): LLMProvider {
    return {
        name,
        chat: async function* () {},
        contextWindow: () => 200000,
        countTokens: async () => 0,
        supportsFeature: () => true,
    };
}

describe("ProviderFailoverManager", () => {
    const providers = [
        createMockProvider("deepseek"),
        createMockProvider("anthropic"),
        createMockProvider("openai"),
    ];

    it("构造时 providers 不得为空", () => {
        expect(() => new ProviderFailoverManager({ providers: [] })).toThrow("不能为空");
    });

    it("初始 currentIndex 应为 0", () => {
        const fm = new ProviderFailoverManager({ providers });
        expect(fm.getCurrentIndex()).toBe(0);
        expect(fm.getCurrentProviderName()).toBe("deepseek");
    });

    it("switchToNext 应切换到下一个 Provider", () => {
        const fm = new ProviderFailoverManager({ providers });
        const next = fm.switchToNext();
        expect(next?.name).toBe("anthropic");
        expect(fm.getCurrentIndex()).toBe(1);
    });

    it("回退链耗尽时 switchToNext 应返回 null", () => {
        const fm = new ProviderFailoverManager({ providers });
        fm.switchToNext(); // → anthropic
        fm.switchToNext(); // → openai
        const exhausted = fm.switchToNext(); // → null
        expect(exhausted).toBeNull();
    });

    it("hasNext 应正确反映是否还有备用 Provider", () => {
        const fm = new ProviderFailoverManager({ providers });
        expect(fm.hasNext()).toBe(true);
        fm.switchToNext(); // → anthropic
        expect(fm.hasNext()).toBe(true);
        fm.switchToNext(); // → openai
        expect(fm.hasNext()).toBe(false);
    });

    it("reset 应重置到第一个 Provider", () => {
        const fm = new ProviderFailoverManager({ providers });
        fm.switchToNext();
        fm.switchToNext();
        expect(fm.getCurrentIndex()).toBe(2);
        fm.reset();
        expect(fm.getCurrentIndex()).toBe(0);
    });

    it("getTotalProviders 应返回总数", () => {
        const fm = new ProviderFailoverManager({ providers });
        expect(fm.getTotalProviders()).toBe(3);
    });

    it("getRemainingCount 应返回剩余数量", () => {
        const fm = new ProviderFailoverManager({ providers });
        expect(fm.getRemainingCount()).toBe(2); // 3 - 0 - 1
        fm.switchToNext();
        expect(fm.getRemainingCount()).toBe(1); // 3 - 1 - 1
    });

    it("getProviders 应返回完整列表", () => {
        const fm = new ProviderFailoverManager({ providers });
        expect(fm.getProviders()).toHaveLength(3);
    });

    // ─── 模型名映射 ───
    it("mapModel 无映射时应返回原模型名", () => {
        const fm = new ProviderFailoverManager({ providers });
        expect(fm.mapModel("claude-sonnet-4-6", "openai")).toBe("claude-sonnet-4-6");
    });

    it("mapModel 应从当前 Provider 的映射表查找", () => {
        const fm = new ProviderFailoverManager({
            providers,
            modelMapping: {
                deepseek: { "deepseek-v4": "claude-opus-4-7" },
            },
        });
        expect(fm.mapModel("deepseek-v4", "anthropic")).toBe("claude-opus-4-7");
    });

    it("mapModel 应从目标 Provider 的映射表查找", () => {
        const fm = new ProviderFailoverManager({
            providers,
            modelMapping: {
                anthropic: { "deepseek-v4": "gpt-4o" },
            },
        });
        // 当前是 deepseek，目标映射在 anthropic 里
        expect(fm.mapModel("deepseek-v4", "anthropic")).toBe("gpt-4o");
    });

    it("getCurrentProvider 应返回正确的 Provider 实例", () => {
        const fm = new ProviderFailoverManager({ providers });
        expect(fm.getCurrentProvider().name).toBe("deepseek");
    });
});
