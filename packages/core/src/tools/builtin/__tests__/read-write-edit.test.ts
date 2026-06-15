// ─── packages/core/src/tools/builtin/__tests__/read-write-edit.test.ts ───
// Read/Write/Edit 工具单元测试

import { describe, it, expect } from "vitest";
import { ReadTool } from "../read";
import { WriteTool } from "../write";
import { EditTool } from "../edit";
import { createMockToolContext, createTempFile } from "../../../../__tests__/helpers";

describe("ReadTool", () => {
    const tool = new ReadTool();

    it("应能读取文件并返回带行号的内容", async () => {
        const content = "line1\nline2\nline3\nline4\nline5";
        const { filePath, cleanup } = await createTempFile(content, 'test.txt');
        const ctx = createMockToolContext({ workingDirectory: "/" });

        const result = await tool.execute({ file_path: filePath } as Record<string, unknown>, ctx);
        expect(result.is_error).toBeFalsy();
        expect(result.content).toContain("1\tline1");
        expect(result.content).toContain("5\tline5");

        await cleanup();
    });

    it("offset 和 limit 应正确截取内容", async () => {
        const content = "a\nb\nc\nd\ne\nf\ng\nh";
        const { filePath, cleanup } = await createTempFile(content, 'test.txt');
        const ctx = createMockToolContext({ workingDirectory: "/" });

        const result = await tool.execute({ file_path: filePath, offset: 2, limit: 3 } as Record<string, unknown>, ctx);
        expect(result.content as string).toContain("3\tc");
        expect(result.content as string).toContain("5\te");
        expect(result.content as string).not.toContain("1\ta");

        await cleanup();
    });

    it("应拒绝工作目录外的文件", async () => {
        const ctx = createMockToolContext({ workingDirectory: "/project" });
        const result = await tool.execute({ file_path: "/etc/passwd" } as Record<string, unknown>, ctx);
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("安全限制");
    });

    it("requiresApproval 应返回 false", () => {
        expect(tool.requiresApproval()).toBe(false);
    });
});

describe("WriteTool", () => {
    const tool = new WriteTool();

    it("应能创建新文件", async () => {
        const { filePath, cleanup } = await createTempFile("", "new-file.ts");
        const ctx = createMockToolContext({ workingDirectory: "/" });

        const result = await tool.execute({ file_path: filePath, content: "export const x = 1;" } as Record<string, unknown>, ctx);
        expect(result.is_error).toBeFalsy();
        expect(result.content).toContain("成功");

        // 验证文件实际写入
        const fs = await import("node:fs/promises");
        const written = await fs.readFile(filePath, "utf-8");
        expect(written).toBe("export const x = 1;");

        await cleanup();
    });

    it("应禁止覆盖敏感文件", async () => {
        const { filePath, cleanup } = await createTempFile("", "test.txt");
        const dotEnvPath = filePath.replace("test.txt", ".env");
        const ctx = createMockToolContext({ workingDirectory: "/" });

        const result = await tool.execute({ file_path: dotEnvPath, content: "SECRET=xxx" } as Record<string, unknown>, ctx);
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("敏感文件");

        await cleanup();
    });

    it("requiresApproval 应返回 true", () => {
        expect(tool.requiresApproval()).toBe(true);
    });
});

describe("EditTool", () => {
    const tool = new EditTool();

    it("应能替换文件中唯一的匹配", async () => {
        const content = "const x = 1;\nconst y = 2;";
        const { filePath, cleanup } = await createTempFile(content, 'test.txt');
        const ctx = createMockToolContext({ workingDirectory: "/" });

        const result = await tool.execute({
            file_path: filePath,
            old_string: "const x = 1;",
            new_string: "const x = 10;",
        } as Record<string, unknown>, ctx);

        expect(result.is_error).toBeFalsy();
        expect(result.content).toContain("替换了 1 处");

        const fs = await import("node:fs/promises");
        const after = await fs.readFile(filePath, "utf-8");
        expect(after).toBe("const x = 10;\nconst y = 2;");

        await cleanup();
    });

    it("不唯一匹配且非 replace_all 应报错", async () => {
        const content = "const a = 1;\nconst b = 2;";
        const { filePath, cleanup } = await createTempFile(content, 'test.txt');
        const ctx = createMockToolContext({ workingDirectory: "/" });

        const result = await tool.execute({
            file_path: filePath,
            old_string: "const",
            new_string: "let",
        } as Record<string, unknown>, ctx);

        expect(result.is_error).toBe(true);
        expect(result.content).toContain("不唯一");

        await cleanup();
    });

    it("replace_all=true 应替换所有匹配", async () => {
        const content = "const a = 1;\nconst b = 2;";
        const { filePath, cleanup } = await createTempFile(content, 'test.txt');
        const ctx = createMockToolContext({ workingDirectory: "/" });

        const result = await tool.execute({
            file_path: filePath,
            old_string: "const",
            new_string: "let",
            replace_all: true,
        } as Record<string, unknown>, ctx);

        expect(result.is_error).toBeFalsy();
        expect(result.content).toContain("替换了 2 处");

        const fs = await import("node:fs/promises");
        const after = await fs.readFile(filePath, "utf-8");
        expect(after).toBe("let a = 1;\nlet b = 2;");

        await cleanup();
    });

    it("匹配不存在应报错", async () => {
        const content = "hello world";
        const { filePath, cleanup } = await createTempFile(content, 'test.txt');
        const ctx = createMockToolContext({ workingDirectory: "/" });

        const result = await tool.execute({
            file_path: filePath,
            old_string: "nonexistent",
            new_string: "X",
        } as Record<string, unknown>, ctx);

        expect(result.is_error).toBe(true);
        expect(result.content).toContain("未找到匹配");

        await cleanup();
    });

    it("requiresApproval 应返回 true", () => {
        expect(tool.requiresApproval()).toBe(true);
    });
});
