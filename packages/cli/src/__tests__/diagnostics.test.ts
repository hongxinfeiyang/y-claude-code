// ─── packages/cli/src/__tests__/diagnostics.test.ts ───
// 配置诊断测试 — 覆盖 diagnoseConfig、formatDiagnostics、runDiagnostics

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    diagnoseConfig,
    formatDiagnostics,
    runDiagnostics,
    type DiagnosticResult,
} from "../utils/diagnostics";
import type { UserConfig } from "@y-claude-code/core";
import { DEFAULT_USER_CONFIG } from "@y-claude-code/core";

function makeConfig(overrides: Partial<UserConfig> = {}): UserConfig {
    return {
        ...structuredClone(DEFAULT_USER_CONFIG),
        ...overrides,
    };
}

// ─── 辅助：保存并恢复环境变量 ───

function saveEnv() {
    return {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    };
}

function restoreEnv(saved: ReturnType<typeof saveEnv>) {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// diagnoseConfig
// ═══════════════════════════════════════════════════════════════════════════════

describe("diagnoseConfig", () => {
    let savedEnv: ReturnType<typeof saveEnv>;

    beforeEach(() => {
        savedEnv = saveEnv();
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
        delete process.env.DEEPSEEK_API_KEY;
    });

    afterEach(() => {
        restoreEnv(savedEnv);
    });

    it("无 Provider 时应返回 error 级别问题", () => {
        const config = makeConfig({ providers: {} });
        const results = diagnoseConfig(config);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].level).toBe("error");
        expect(results[0].message).toContain("未配置任何 LLM Provider");
    });

    it("无 Provider 时应提供修复步骤", () => {
        const config = makeConfig({ providers: {} });
        const results = diagnoseConfig(config);
        expect(results[0].fix.length).toBeGreaterThan(0);
        expect(results[0].fix.some((f) => f.includes("--setup"))).toBe(true);
    });

    it("有已配置 Provider 时不应报无 Provider 错误", () => {
        const config = makeConfig({
            provider: "anthropic",
            providers: { anthropic: { apiKey: "sk-ant-test" } },
        });
        const results = diagnoseConfig(config);
        const hasNoProvider = results.some((r) => r.message.includes("未配置任何"));
        expect(hasNoProvider).toBe(false);
    });

    it("当前 Provider 未配置时应报错", () => {
        const config = makeConfig({
            provider: "anthropic",
            providers: { openai: { apiKey: "sk-openai-test" } },
        });
        const results = diagnoseConfig(config);
        const hasUnconfigured = results.some((r) => r.message.includes("未配置"));
        expect(hasUnconfigured).toBe(true);
    });

    it("Provider 缺少 API Key 时应报错", () => {
        const config = makeConfig({
            provider: "anthropic",
            providers: {
                anthropic: { apiKey: "" },
                openai: { apiKey: "sk-openai-test" },
            },
        });
        const results = diagnoseConfig(config);
        const hasMissingKey = results.some((r) => r.message.includes("API Key"));
        expect(hasMissingKey).toBe(true);
    });

    it("API Key 缺少时应提示环境变量", () => {
        const config = makeConfig({
            provider: "anthropic",
            providers: {
                anthropic: { apiKey: "" },
                openai: { apiKey: "sk-openai-test" },
            },
        });
        const results = diagnoseConfig(config);
        const keyError = results.find((r) => r.message.includes("API Key"));
        expect(keyError?.fix.some((f) => f.includes("ANTHROPIC_API_KEY"))).toBe(true);
    });

    it("模型名无 - 时应警告", () => {
        const config = makeConfig({
            provider: "anthropic",
            model: "weirdmodel",
            providers: { anthropic: { apiKey: "sk-ant-test" } },
        });
        const results = diagnoseConfig(config);
        const hasWarn = results.some((r) => r.message.includes("格式异常"));
        expect(hasWarn).toBe(true);
    });

    it("模型名正常时不应警告", () => {
        const config = makeConfig({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            providers: { anthropic: { apiKey: "sk-ant-test" } },
        });
        const results = diagnoseConfig(config);
        const hasModelWarn = results.some((r) => r.message.includes("格式异常"));
        expect(hasModelWarn).toBe(false);
    });

    it("baseURL 末尾多余斜杠应警告", () => {
        const config = makeConfig({
            provider: "openai",
            providers: {
                openai: { apiKey: "sk-test", baseURL: "https://api.openai.com/v1/" },
            },
        });
        const results = diagnoseConfig(config);
        const hasUrlWarn = results.some((r) => r.message.includes("斜杠"));
        expect(hasUrlWarn).toBe(true);
    });

    it("baseURL 缺少协议头应警告", () => {
        const config = makeConfig({
            provider: "openai",
            providers: {
                openai: { apiKey: "sk-test", baseURL: "api.example.com" },
            },
        });
        const results = diagnoseConfig(config);
        const hasProtocolWarn = results.some((r) => r.message.includes("协议头"));
        expect(hasProtocolWarn).toBe(true);
    });

    it("baseURL 正常时不应有 URL 相关警告", () => {
        const config = makeConfig({
            provider: "openai",
            providers: {
                openai: { apiKey: "sk-test", baseURL: "https://api.openai.com/v1" },
            },
        });
        const results = diagnoseConfig(config);
        const hasUrlWarn = results.some((r) => r.message.includes("斜杠") || r.message.includes("协议头"));
        expect(hasUrlWarn).toBe(false);
    });

    it("仅环境变量有 Key 但无 Provider 配置时应报无 Provider 错误", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
        const config = makeConfig({ providers: {} });
        const results = diagnoseConfig(config);
        // env var 检测在 "未配置任何 Provider" 的 return 之后，实际无法到达
        // 当前行为是直接返回 "未配置任何 LLM Provider" 错误
        expect(results.length).toBe(1);
        expect(results[0].message).toContain("未配置任何 LLM Provider");
    });

    it("配置完全正确时不应有 error", () => {
        const config = makeConfig({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            providers: { anthropic: { apiKey: "sk-ant-test" } },
        });
        const results = diagnoseConfig(config);
        const errors = results.filter((r) => r.level === "error");
        expect(errors.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatDiagnostics
// ═══════════════════════════════════════════════════════════════════════════════

describe("formatDiagnostics", () => {
    it("空结果应返回空字符串", () => {
        expect(formatDiagnostics([])).toBe("");
    });

    it("应包含严重级别统计", () => {
        const results: DiagnosticResult[] = [
            { level: "error", message: "test error", fix: ["fix it"] },
            { level: "warn", message: "test warning", fix: [] },
        ];
        const output = formatDiagnostics(results);
        expect(output).toContain("1 个错误");
        expect(output).toContain("1 个警告");
    });

    it("应包含修复指引", () => {
        const results: DiagnosticResult[] = [
            { level: "error", message: "broken", fix: ["step 1", "step 2"] },
        ];
        const output = formatDiagnostics(results);
        expect(output).toContain("step 1");
        expect(output).toContain("step 2");
    });

    it("应包含问题消息", () => {
        const results: DiagnosticResult[] = [
            { level: "error", message: "something is wrong", fix: [] },
        ];
        const output = formatDiagnostics(results);
        expect(output).toContain("something is wrong");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runDiagnostics — 一站式
// ═══════════════════════════════════════════════════════════════════════════════

describe("runDiagnostics", () => {
    it("无 Provider 时应返回诊断字符串", () => {
        const config = makeConfig({ providers: {} });
        const output = runDiagnostics(config);
        expect(output).toContain("未配置任何 LLM Provider");
    });

    it("配置正常时应返回空字符串", () => {
        const config = makeConfig({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            providers: { anthropic: { apiKey: "sk-ant-test" } },
        });
        const output = runDiagnostics(config);
        expect(output).toBe("");
    });
});
