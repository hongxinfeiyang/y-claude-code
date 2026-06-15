// ─── packages/core/src/router/__tests__/intent-router.test.ts ───
// IntentRouter 单元测试

import { describe, it, expect } from "vitest";
import { IntentRouter, IntentType } from "../intent-router";

describe("IntentRouter", () => {
    const router = new IntentRouter();

    // ─── 内置命令 ───
    it("应识别 /help 为内置命令", () => {
        const r = router.route("/help");
        expect(r.type).toBe(IntentType.BUILTIN_COMMAND);
        expect(r.command).toBe("/help");
    });

    it("应识别 /model claude-opus-4-7 并提取参数", () => {
        const r = router.route("/model claude-opus-4-7");
        expect(r.type).toBe(IntentType.BUILTIN_COMMAND);
        expect(r.command).toBe("/model");
        expect(r.commandArgs).toBe("claude-opus-4-7");
    });

    it("应识别别名 /h 为 /help", () => {
        const r = router.route("/h");
        expect(r.type).toBe(IntentType.BUILTIN_COMMAND);
        expect(r.command).toBe("/help");
    });

    it("应识别 /exit 及其变体", () => {
        expect(router.route("/exit").type).toBe(IntentType.BUILTIN_COMMAND);
        expect(router.route("/quit").type).toBe(IntentType.BUILTIN_COMMAND);
        expect(router.route("/q").type).toBe(IntentType.BUILTIN_COMMAND);
    });

    it("非 / 开头不应识别为命令", () => {
        const r = router.route("help me");
        expect(r.type).not.toBe(IntentType.BUILTIN_COMMAND);
    });

    // ─── 直接工具调用 ───
    it("应识别 '读取 test.ts' 为 Read 工具", () => {
        const r = router.route("读取 test.ts");
        expect(r.type).toBe(IntentType.DIRECT_TOOL);
        expect(r.toolName).toBe("Read");
        expect(r.toolParams?.file_path).toBe("test.ts");
    });

    it("应识别 '查看 src/app.ts' 为 Read 工具", () => {
        const r = router.route("查看 src/app.ts");
        expect(r.type).toBe(IntentType.DIRECT_TOOL);
        expect(r.toolName).toBe("Read");
    });

    it("应识别 '搜索 useState' 为 Grep 工具", () => {
        const r = router.route("搜索 useState");
        expect(r.type).toBe(IntentType.DIRECT_TOOL);
        expect(r.toolName).toBe("Grep");
        expect(r.toolParams?.pattern).toBe("useState");
    });

    it("应识别 '列出文件' 为 Glob 工具", () => {
        const r = router.route("列出文件");
        expect(r.type).toBe(IntentType.DIRECT_TOOL);
        expect(r.toolName).toBe("Glob");
    });

    it("应识别 '执行 npm test' 为 Bash 工具", () => {
        const r = router.route("执行 npm test");
        expect(r.type).toBe(IntentType.DIRECT_TOOL);
        expect(r.toolName).toBe("Bash");
    });

    it("应识别 npm/yarn/git/curl 为 Bash 工具", () => {
        expect(router.route("npm install react").toolName).toBe("Bash");
        expect(router.route("git status").toolName).toBe("Bash");
        expect(router.route("curl https://api.example.com").toolName).toBe("Bash");
    });

    // ─── 自然语言（兜底） ───
    it("复杂自然语言应识别为 NATURAL_LANGUAGE", () => {
        const r = router.route("帮我修复 src/utils.ts 中的 bug");
        expect(r.type).toBe(IntentType.NATURAL_LANGUAGE);
    });

    it("空输入应返回 NATURAL_LANGUAGE", () => {
        const r = router.route("");
        expect(r.type).toBe(IntentType.NATURAL_LANGUAGE);
    });

    it("纯空格输入应返回 NATURAL_LANGUAGE", () => {
        const r = router.route("   ");
        expect(r.type).toBe(IntentType.NATURAL_LANGUAGE);
    });
});
