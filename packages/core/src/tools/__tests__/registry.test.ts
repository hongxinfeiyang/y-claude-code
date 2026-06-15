// ─── packages/core/src/tools/__tests__/registry.test.ts ───
// ToolRegistry 单元测试

import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../registry";
import { ReadTool, WriteTool } from "../builtin/index";
import { Tool } from "../../types/tools";
import type { ToolResult } from "../../types/messages";

describe("ToolRegistry", () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        registry = new ToolRegistry();
    });

    it("应能注册工具", () => {
        registry.register(new ReadTool());
        expect(registry.has("Read")).toBe(true);
    });

    it("注册同名工具应抛出异常", () => {
        registry.register(new ReadTool());
        expect(() => registry.register(new ReadTool())).toThrow("已注册");
    });

    it("批量注册应全部生效", () => {
        registry.registerAll([new ReadTool(), new WriteTool()]);
        expect(registry.listNames()).toHaveLength(2);
    });

    it("get 应返回已注册工具", () => {
        registry.register(new ReadTool());
        expect(registry.get("Read")).toBeDefined();
    });

    it("get 未注册工具应返回 undefined", () => {
        expect(registry.get("NONEXISTENT")).toBeUndefined();
    });

    it("has 应正确判断是否存在", () => {
        expect(registry.has("Read")).toBe(false);
        registry.register(new ReadTool());
        expect(registry.has("Read")).toBe(true);
    });

    it("listNames 应返回所有名称", () => {
        registry.registerAll([new ReadTool(), new WriteTool()]);
        const names = registry.listNames();
        expect(names).toContain("Read");
        expect(names).toContain("Write");
    });

    it("toLLMDefinitions 应为每个工具生成正确的定义", () => {
        registry.register(new ReadTool());
        const defs = registry.toLLMDefinitions();
        expect(defs).toHaveLength(1);
        expect(defs[0].name).toBe("Read");
        expect(defs[0].description).toBeTruthy();
        expect(defs[0].input_schema.type).toBe("object");
    });

    it("createDefault 应注册所有内置工具", () => {
        const defaultRegistry = ToolRegistry.createDefault();
        const names = defaultRegistry.listNames();
        expect(names).toContain("Read");
        expect(names).toContain("Write");
        expect(names).toContain("Edit");
        expect(names).toContain("Bash");
        expect(names).toContain("Glob");
        expect(names).toContain("Grep");
        expect(names).toContain("WebFetch");
        expect(names).toContain("WebSearch");
        expect(names).toContain("Agent");
        expect(names).toContain("AskUserQuestion");
        // 随着新工具不断加入，仅校验核心工具存在，不限定精确数量
        expect(names.length).toBeGreaterThanOrEqual(10);
    });
});
