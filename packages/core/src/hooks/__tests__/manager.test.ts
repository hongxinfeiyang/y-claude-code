// ─── packages/core/src/hooks/__tests__/manager.test.ts ───
// HookManager 单元测试

import { describe, it, expect, beforeEach, vi } from "vitest";
import { HookManager } from "../manager";

describe("HookManager", () => {
    let hm: HookManager;

    beforeEach(() => {
        hm = new HookManager();
    });

    it("无注册 Handler 时 trigger 应返回 true", async () => {
        expect(await hm.trigger("before:tool:execute")).toBe(true);
    });

    it("注册 Handler 时应被调用", async () => {
        const handler = vi.fn().mockResolvedValue(undefined);
        hm.on("before:tool:execute", handler);
        await hm.trigger("before:tool:execute", { toolName: "Read" });
        expect(handler).toHaveBeenCalled();
    });

    it("Handler 返回 false 应阻止操作", async () => {
        hm.on("before:tool:execute", () => false);
        const allowed = await hm.trigger("before:tool:execute");
        expect(allowed).toBe(false);
    });

    it("多个 Handler 任一返回 false 应短路", async () => {
        const h1 = vi.fn().mockResolvedValue(true);
        const h2 = vi.fn().mockResolvedValue(false);
        const h3 = vi.fn().mockResolvedValue(true);
        hm.on("before:tool:execute", h1);
        hm.on("before:tool:execute", h2);
        hm.on("before:tool:execute", h3);

        const allowed = await hm.trigger("before:tool:execute");

        expect(allowed).toBe(false);
        expect(h1).toHaveBeenCalled();
        expect(h2).toHaveBeenCalled();
        // h3 不应被调用（h2 返回 false 后短路）
        expect(h3).not.toHaveBeenCalled();
    });

    it("matcher 应过滤不匹配的工具", async () => {
        const handler = vi.fn().mockResolvedValue(undefined);
        hm.on("before:tool:execute", handler, "Bash");
        await hm.trigger("before:tool:execute", { toolName: "Read" });
        // matcher 不匹配 "Read"，handler 不应被调用
        expect(handler).not.toHaveBeenCalled();
    });

    it("matcher 应匹配正确的工具", async () => {
        const handler = vi.fn().mockResolvedValue(undefined);
        hm.on("before:tool:execute", handler, "Write*");
        await hm.trigger("before:tool:execute", { toolName: "Write" });
        expect(handler).toHaveBeenCalled();
    });

    it("Handler 异常不应中断流程", async () => {
        hm.on("before:tool:execute", () => { throw new Error("oops"); });
        hm.on("before:tool:execute", () => true);
        const allowed = await hm.trigger("before:tool:execute");
        // 不应崩溃，第二个 handler 正常执行
        expect(allowed).toBe(true);
    });

    it("off 应移除指定事件的所有 Handler", async () => {
        const handler = vi.fn();
        hm.on("before:tool:execute", handler);
        hm.off("before:tool:execute");
        await hm.trigger("before:tool:execute");
        expect(handler).not.toHaveBeenCalled();
    });

    it("clear 应移除所有事件", async () => {
        hm.on("before:tool:execute", () => true);
        hm.on("after:tool:execute", () => true);
        hm.clear();
        expect(await hm.trigger("before:tool:execute")).toBe(true);
        expect(await hm.trigger("after:tool:execute")).toBe(true);
    });
});
