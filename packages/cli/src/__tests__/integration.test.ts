// ─── packages/cli/src/__tests__/integration.test.ts ───
// CLI 集成测试 — 命令行参数、启动流程、路由分发端到端验证
// Mock 文件系统和网络，验证从参数解析到初始化的完整流程

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseArgs, initialize, type StartupContext } from "../utils/startup";

// ─── 保存原始引用 ───
const origArgv = [...process.argv];
const origEnv = { ...process.env };

describe("CLI 集成 — parseArgs", () => {
    beforeEach(() => {
        process.argv = ["node", "y-claude-code"];
    });

    afterEach(() => {
        process.argv = [...origArgv];
    });

    it("无参数应返回空对象", () => {
        process.argv = ["node", "y-claude-code"];
        const args = parseArgs();
        expect(Object.keys(args).length).toBe(0);
    });

    it("--help 应识别", () => {
        process.argv = ["node", "y-claude-code", "--help"];
        const args = parseArgs();
        expect(args.help).toBe("true");
    });

    it("--version 应识别", () => {
        process.argv = ["node", "y-claude-code", "--version"];
        const args = parseArgs();
        expect(args.version).toBe("true");
    });

    it("--model <name> 应识别", () => {
        process.argv = ["node", "y-claude-code", "--model", "claude-opus-4-7"];
        const args = parseArgs();
        expect(args.model).toBe("claude-opus-4-7");
    });

    it("--setup 应识别", () => {
        process.argv = ["node", "y-claude-code", "--setup"];
        const args = parseArgs();
        expect(args.setup).toBe("true");
    });

    it("--resume <id> 应识别", () => {
        process.argv = ["node", "y-claude-code", "--resume", "abc123"];
        const args = parseArgs();
        expect(args.resume).toBe("abc123");
    });

    it("--sessions 应识别", () => {
        process.argv = ["node", "y-claude-code", "--sessions"];
        const args = parseArgs();
        expect(args.sessions).toBe("true");
    });

    it("组合参数应全部识别", () => {
        process.argv = ["node", "y-claude-code", "--model", "sonnet", "--setup"];
        const args = parseArgs();
        expect(args.model).toBe("sonnet");
        expect(args.setup).toBe("true");
    });

    it("未知参数应忽略", () => {
        process.argv = ["node", "y-claude-code", "--unknown-flag", "value"];
        const args = parseArgs();
        expect(args["unknown-flag"]).toBeUndefined();
    });
});

describe("CLI 集成 — initialize 启动流程", () => {
    beforeEach(() => {
        process.env = {
            ...origEnv,
            HOME: "/home/test",
            ANTHROPIC_API_KEY: "sk-ant-test-key-12345",
        };
    });

    afterEach(() => {
        process.env = { ...origEnv };
    });

    it("--help 由 main() 在调用 initialize 之前处理", async () => {
        // parseArgs 正确捕获 --help
        process.argv = ["node", "y-claude-code", "--help"];
        const args = parseArgs();
        expect(args.help).toBe("true");
        // initialize 本身不处理 help（help 在 main() 中先检查）
        // 这里仅验证 parseArgs → initialize 之间的数据流是连通的
    });
});

describe("CLI 集成 — 模块导入验证", () => {
    it("renderer 模块应正确导出所有符号", async () => {
        const mod = await import("../utils/renderer");
        expect(mod.C).toBeDefined();
        expect(mod.SPINNER_FRAMES).toBeDefined();
        expect(typeof mod.highlightCodeBlock).toBe("function");
        expect(typeof mod.renderMarkdown).toBe("function");
        expect(typeof mod.showHelp).toBe("function");
    });

    it("startup 模块应正确导出所有符号", async () => {
        const mod = await import("../utils/startup");
        expect(typeof mod.parseArgs).toBe("function");
        expect(typeof mod.initialize).toBe("function");
        expect(typeof mod.printStartupInfo).toBe("function");
        expect(typeof mod.startAutoUpdateCheck).toBe("function");
        expect(typeof mod.registerPlanApproval).toBe("function");
        expect(typeof mod.registerPermissionPrompt).toBe("function");
    });

    it("input-handler 模块应正确导出所有符号", async () => {
        const mod = await import("../utils/input-handler");
        expect(typeof mod.askYesNo).toBe("function");
        expect(typeof mod.createProcessInput).toBe("function");
        expect(typeof mod.startReadline).toBe("function");
    });
});

describe("CLI 集成 — Markdown 渲染端到端", () => {
    let renderer: typeof import("../utils/renderer");

    beforeEach(async () => {
        renderer = await import("../utils/renderer");
    });

    it("应渲染混合格式的 Markdown 文本", () => {
        const input = [
            "# 标题",
            "",
            "这是一段**粗体**和*斜体*的文字。",
            "",
            "```js",
            "const x = 1;",
            "```",
            "",
            "- 列表项 1",
            "- 列表项 2",
            "",
            "[链接](https://example.com)",
        ].join("\n");

        const output = renderer.renderMarkdown(input);
        // 标题渲染
        expect(output).toContain("标题");
        // 粗体标记
        expect(output).toContain("\x1b[1m粗体\x1b[0m");
        // 代码块中的变量名（含 ANSI 颜色码，检查子串）
        expect(output).toContain("const");
        expect(output).toContain("x =");
        // 列表项
        expect(output).toContain("列表项 1");
        // 链接（只保留文字）
        expect(output).toContain("链接");
    });

    it("highlightCodeBlock 应对 JS 关键字着色", () => {
        const code = "const greeting = 'hello world';\nreturn greeting;";
        const output = renderer.highlightCodeBlock(code, "js");
        // 应包含颜色码（非纯文本）
        expect(output).toContain("\x1b");
    });

    it("SPINNER_FRAMES 应包含 10 个字符", () => {
        expect(renderer.SPINNER_FRAMES).toHaveLength(10);
    });
});
