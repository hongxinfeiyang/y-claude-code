// ─── packages/core/src/config/__tests__/loader.test.ts ───
// 配置加载器测试 — 覆盖多级加载、合并、Provider 管理、环境变量注入

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigLoader, configLoader } from "../loader";
import { DEFAULT_USER_CONFIG } from "../../types/config";
import type { UserConfig } from "../../types/config";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";

// ─── 辅助：保存并恢复原始环境变量 ───

function saveEnv() {
    return {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        Y_CLAUDE_CODE_MODEL: process.env.Y_CLAUDE_CODE_MODEL,
        Y_CLAUDE_CODE_PROVIDER: process.env.Y_CLAUDE_CODE_PROVIDER,
        Y_CLAUDE_CODE_MAX_ROUNDS: process.env.Y_CLAUDE_CODE_MAX_ROUNDS,
        Y_CLAUDE_CODE_THINKING: process.env.Y_CLAUDE_CODE_THINKING,
        Y_CLAUDE_CODE_SHOW_THINKING: process.env.Y_CLAUDE_CODE_SHOW_THINKING,
    };
}

function restoreEnv(saved: ReturnType<typeof saveEnv>) {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 构造函数与默认值
// ═══════════════════════════════════════════════════════════════════════════════

describe("ConfigLoader — 构造函数与默认值", () => {
    it("构造后 get() 应返回 DEFAULT_USER_CONFIG 的深拷贝", () => {
        const loader = new ConfigLoader();
        const config = loader.get();

        expect(config.model).toBe(DEFAULT_USER_CONFIG.model);
        expect(config.provider).toBe(DEFAULT_USER_CONFIG.provider);
        expect(config.maxToolRounds).toBe(DEFAULT_USER_CONFIG.maxToolRounds);
        expect(config.maxTokensPerTurn).toBe(DEFAULT_USER_CONFIG.maxTokensPerTurn);
        expect(config.thinkingEnabled).toBe(DEFAULT_USER_CONFIG.thinkingEnabled);
        expect(config.thinkingTokens).toBe(DEFAULT_USER_CONFIG.thinkingTokens);
        expect(config.permissions.defaultMode).toBe(DEFAULT_USER_CONFIG.permissions.defaultMode);
    });

    it("get() 返回的引用修改不应影响 DEFAULT_USER_CONFIG", () => {
        const loader = new ConfigLoader();
        const config = loader.get();
        config.maxToolRounds = 999;

        // DEFAULT_USER_CONFIG 应保持不变（深拷贝）
        expect(DEFAULT_USER_CONFIG.maxToolRounds).toBe(50);
    });

    it("每次 new ConfigLoader() 应创建独立实例", () => {
        const loader1 = new ConfigLoader();
        const loader2 = new ConfigLoader();

        loader1.set("model", "custom-model-1");
        expect(loader1.getKey("model")).toBe("custom-model-1");
        expect(loader2.getKey("model")).toBe(DEFAULT_USER_CONFIG.model);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// set / get / getKey
// ═══════════════════════════════════════════════════════════════════════════════

describe("ConfigLoader — set / get / getKey", () => {
    let loader: ConfigLoader;

    beforeEach(() => {
        loader = new ConfigLoader();
    });

    it("set + getKey 应正确读写简单值", () => {
        loader.set("model", "gpt-5");
        expect(loader.getKey("model")).toBe("gpt-5");
    });

    it("set 应修改 get() 返回对象中的值", () => {
        loader.set("maxToolRounds", 100);
        expect(loader.get().maxToolRounds).toBe(100);
    });

    it("set 多次同一 key 应保留最后一次的值", () => {
        loader.set("theme", "light");
        loader.set("theme", "dark");
        expect(loader.getKey("theme")).toBe("dark");
    });

    it("getKey 应能读取嵌套对象", () => {
        const permissions = loader.getKey("permissions");
        expect(permissions.defaultMode).toBe("ask");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// setProvider / setCurrentProvider
// ═══════════════════════════════════════════════════════════════════════════════

describe("ConfigLoader — Provider 管理", () => {
    let loader: ConfigLoader;

    beforeEach(() => {
        loader = new ConfigLoader();
    });

    it("setProvider 应添加 Provider 配置", () => {
        loader.setProvider("anthropic", { apiKey: "sk-ant-test" });
        expect(loader.getKey("providers")["anthropic"]).toBeDefined();
        expect(loader.getKey("providers")["anthropic"].apiKey).toBe("sk-ant-test");
    });

    it("首个 Provider 应自动设为当前 Provider", () => {
        loader.setProvider("anthropic", { apiKey: "sk-ant-test" });
        expect(loader.getKey("provider")).toBe("anthropic");
    });

    it("setProvider 多次调用不应覆盖已有 Provider", () => {
        loader.setProvider("anthropic", { apiKey: "sk-ant-test" });
        loader.setProvider("openai", { apiKey: "sk-openai-test" });

        expect(loader.getKey("providers")["anthropic"]).toBeDefined();
        expect(loader.getKey("providers")["openai"]).toBeDefined();
        // 首个 Provider 保持为 current
        expect(loader.getKey("provider")).toBe("anthropic");
    });

    it("setProvider 应保留已有配置并合并新字段", () => {
        loader.setProvider("anthropic", { apiKey: "sk-ant-test", baseURL: "https://api.anthropic.com" });
        loader.setProvider("anthropic", { apiKey: "sk-ant-new" }); // 只更新 apiKey

        const provider = loader.getKey("providers")["anthropic"];
        expect(provider.apiKey).toBe("sk-ant-new");
        expect(provider.baseURL).toBe("https://api.anthropic.com"); // 保留旧值
    });

    it("setCurrentProvider 应切换 Provider 和模型", () => {
        loader.setProvider("anthropic", { apiKey: "sk-ant-test", defaultModel: "claude-opus-4-7" });
        loader.setProvider("openai", { apiKey: "sk-openai-test", defaultModel: "gpt-5" });

        loader.setCurrentProvider("openai");
        expect(loader.getKey("provider")).toBe("openai");
        expect(loader.getKey("model")).toBe("gpt-5");
    });

    it("setCurrentProvider 在 Provider 不存在时应抛异常", () => {
        expect(() => loader.setCurrentProvider("nonexistent")).toThrow("未配置");
    });

    it("setCurrentProvider 在 Provider 无 defaultModel 时应保持模型不变", () => {
        loader.set("model", "my-model");
        loader.setProvider("anthropic", { apiKey: "sk-ant-test" });
        // defaultModel 未设置
        loader.setCurrentProvider("anthropic");
        expect(loader.getKey("model")).toBe("my-model");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 环境变量覆盖
// ═══════════════════════════════════════════════════════════════════════════════

describe("ConfigLoader — 环境变量覆盖", () => {
    let loader: ConfigLoader;
    let savedEnv: ReturnType<typeof saveEnv>;

    beforeEach(() => {
        savedEnv = saveEnv();
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
        delete process.env.Y_CLAUDE_CODE_MODEL;
        delete process.env.Y_CLAUDE_CODE_PROVIDER;
        delete process.env.Y_CLAUDE_CODE_MAX_ROUNDS;
        delete process.env.Y_CLAUDE_CODE_THINKING;
        delete process.env.Y_CLAUDE_CODE_SHOW_THINKING;
        loader = new ConfigLoader();
    });

    afterEach(() => {
        restoreEnv(savedEnv);
    });

    it("Y_CLAUDE_CODE_MODEL 应覆盖 model 字段", async () => {
        process.env.Y_CLAUDE_CODE_MODEL = "env-model";
        await loader.load("/nonexistent/path");
        expect(loader.getKey("model")).toBe("env-model");
    });

    it("ANTHROPIC_API_KEY 应注入 anthropic provider", async () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
        await loader.load("/nonexistent/path");
        expect(loader.getKey("providers")["anthropic"].apiKey).toBe("sk-ant-from-env");
    });

    it("OPENAI_API_KEY 应注入 openai provider", async () => {
        process.env.OPENAI_API_KEY = "sk-openai-from-env";
        await loader.load("/nonexistent/path");
        expect(loader.getKey("providers")["openai"].apiKey).toBe("sk-openai-from-env");
    });

    it("Y_CLAUDE_CODE_PROVIDER 应覆盖 provider 字段", async () => {
        process.env.Y_CLAUDE_CODE_PROVIDER = "openai";
        await loader.load("/nonexistent/path");
        expect(loader.getKey("provider")).toBe("openai");
    });

    it("Y_CLAUDE_CODE_MAX_ROUNDS 应覆盖 maxToolRounds", async () => {
        process.env.Y_CLAUDE_CODE_MAX_ROUNDS = "30";
        await loader.load("/nonexistent/path");
        expect(loader.getKey("maxToolRounds")).toBe(30);
    });

    it("Y_CLAUDE_CODE_THINKING=1 应开启 thinking", async () => {
        process.env.Y_CLAUDE_CODE_THINKING = "1";
        await loader.load("/nonexistent/path");
        expect(loader.getKey("thinkingEnabled")).toBe(true);
    });

    it("Y_CLAUDE_CODE_SHOW_THINKING=1 应开启 showThinking", async () => {
        process.env.Y_CLAUDE_CODE_SHOW_THINKING = "1";
        await loader.load("/nonexistent/path");
        expect(loader.getKey("showThinking")).toBe(true);
    });

    it("无环境变量时应保持默认值", async () => {
        await loader.load("/nonexistent/path");
        expect(loader.getKey("model")).toBe(DEFAULT_USER_CONFIG.model);
        expect(loader.getKey("thinkingEnabled")).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// load — 配置文件加载
// ═══════════════════════════════════════════════════════════════════════════════

describe("ConfigLoader — load 配置文件加载", () => {
    let loader: ConfigLoader;
    let testDir: string;
    let savedEnv: ReturnType<typeof saveEnv>;

    beforeEach(() => {
        savedEnv = saveEnv();
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.Y_CLAUDE_CODE_MODEL;
        delete process.env.Y_CLAUDE_CODE_PROVIDER;
        delete process.env.Y_CLAUDE_CODE_MAX_ROUNDS;
        delete process.env.Y_CLAUDE_CODE_THINKING;
        delete process.env.Y_CLAUDE_CODE_SHOW_THINKING;

        testDir = join(tmpdir(), `y-claude-config-test-${Date.now()}`);
        mkdirSync(join(testDir, ".y-claude"), { recursive: true });
        loader = new ConfigLoader();
    });

    afterEach(() => {
        restoreEnv(savedEnv);
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("load 应使用项目 settings.json 覆盖默认值", async () => {
        writeFileSync(
            join(testDir, ".y-claude", "settings.json"),
            JSON.stringify({ model: "project-model", maxToolRounds: 20 }),
        );

        await loader.load(testDir);
        expect(loader.getKey("model")).toBe("project-model");
        expect(loader.getKey("maxToolRounds")).toBe(20);
        // 未覆盖的字段保持默认值
        expect(loader.getKey("theme")).toBe("dark");
    });

    it("settings.local.json 应覆盖 settings.json", async () => {
        writeFileSync(
            join(testDir, ".y-claude", "settings.json"),
            JSON.stringify({ model: "shared-model", maxTokensPerTurn: 8000 }),
        );
        writeFileSync(
            join(testDir, ".y-claude", "settings.local.json"),
            JSON.stringify({ model: "local-model" }),
        );

        await loader.load(testDir);
        expect(loader.getKey("model")).toBe("local-model"); // local 覆盖
        expect(loader.getKey("maxTokensPerTurn")).toBe(8000); // shared 保留
    });

    it("仅 settings.local.json 存在时也应被正常加载", async () => {
        writeFileSync(
            join(testDir, ".y-claude", "settings.local.json"),
            JSON.stringify({ model: "only-local", maxToolRounds: 30 }),
        );

        await loader.load(testDir);
        // 只有 settings.local.json，settings.json 不存在
        expect(loader.getKey("model")).toBe("only-local");
        expect(loader.getKey("maxToolRounds")).toBe(30);
        // 未覆盖的字段保持默认值
        expect(loader.getKey("theme")).toBe("dark");
    });

    it("仅 settings.local.json 存在时，环境变量仍应覆盖", async () => {
        writeFileSync(
            join(testDir, ".y-claude", "settings.local.json"),
            JSON.stringify({ model: "only-local" }),
        );
        process.env.Y_CLAUDE_CODE_MODEL = "env-wins";

        await loader.load(testDir);
        expect(loader.getKey("model")).toBe("env-wins");
    });

    it("无效 JSON 配置文件时 load 应 reject", async () => {
        writeFileSync(
            join(testDir, ".y-claude", "settings.json"),
            "{ not valid json",
        );

        // cosmiconfig 遇到无效 JSON 会抛出 JSONError
        await expect(loader.load(testDir)).rejects.toThrow();
    });

    it("无配置文件时应返回默认值", async () => {
        const emptyDir = join(tmpdir(), `y-claude-empty-${Date.now()}`);
        mkdirSync(emptyDir, { recursive: true });

        try {
            await loader.load(emptyDir);
            expect(loader.getKey("model")).toBe(DEFAULT_USER_CONFIG.model);
        } finally {
            rmSync(emptyDir, { recursive: true, force: true });
        }
    });

    it("多次 load 应重置为默认值再重新合并", async () => {
        // 两个不同的目录来避免 cosmiconfig 缓存
        const dir1 = join(tmpdir(), `y-claude-cfg-multi1-${Date.now()}`);
        const dir2 = join(tmpdir(), `y-claude-cfg-multi2-${Date.now()}`);
        mkdirSync(join(dir1, ".y-claude"), { recursive: true });
        mkdirSync(join(dir2, ".y-claude"), { recursive: true });

        try {
            writeFileSync(
                join(dir1, ".y-claude", "settings.json"),
                JSON.stringify({ model: "model-1" }),
            );
            writeFileSync(
                join(dir2, ".y-claude", "settings.json"),
                JSON.stringify({ model: "model-2", maxToolRounds: 30 }),
            );

            await loader.load(dir1);
            expect(loader.getKey("model")).toBe("model-1");

            await loader.load(dir2);
            expect(loader.getKey("model")).toBe("model-2");
            // 第二个目录未设置的字段应回到默认值（load 先重置）
            expect(loader.getKey("maxToolRounds")).toBe(30);
        } finally {
            rmSync(dir1, { recursive: true, force: true });
            rmSync(dir2, { recursive: true, force: true });
        }
    });

    it("环境变量应覆盖配置文件中的值", async () => {
        writeFileSync(
            join(testDir, ".y-claude", "settings.json"),
            JSON.stringify({ model: "file-model" }),
        );
        process.env.Y_CLAUDE_CODE_MODEL = "env-model";

        await loader.load(testDir);
        expect(loader.getKey("model")).toBe("env-model");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════════════════════════

describe("configLoader 单例", () => {
    it("应导出 configLoader 实例", () => {
        expect(configLoader).toBeInstanceOf(ConfigLoader);
    });

    it("多次引用应为同一实例", async () => {
        const mod = await import("../loader");
        expect(mod.configLoader).toBe(configLoader);
    });
});
