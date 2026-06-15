// ─── packages/core/src/tools/builtin/__tests__/tool-combination.test.ts ───
// 工具组合场景测试 — 验证多个工具协同工作的正确性

import { describe, it, expect, vi } from "vitest";
import { ReadTool } from "../read";
import { WriteTool } from "../write";
import { EditTool } from "../edit";
import { BashTool } from "../bash";
import { GlobTool } from "../glob";
import { GrepTool } from "../grep";
import { createMockToolContext, createTempFile } from "../../../../__tests__/helpers";
import * as path from "node:path";

describe("工具组合场景", () => {
    // ─── Read → Edit 管道 ───
    it("Read 后 Edit 应能修改同一文件", async () => {
        const { filePath, cleanup } = await createTempFile("const x = 1;\nconst y = 2;\n");
        try {
            const readTool = new ReadTool();
            const editTool = new EditTool();
            const workDir = path.dirname(filePath);
            const ctx = createMockToolContext({ workingDirectory: workDir });

            // 1. 先读取文件
            const readResult = await readTool.execute({ file_path: filePath }, ctx);
            expect(readResult.is_error).toBeFalsy();
            expect(readResult.content).toContain("const x = 1");

            // 2. 再编辑文件
            const editResult = await editTool.execute(
                { file_path: filePath, old_string: "const x = 1;", new_string: "const x = 42;" },
                ctx,
            );
            expect(editResult.is_error).toBeFalsy();

            // 3. 再次读取验证修改
            const verify = await readTool.execute({ file_path: filePath }, ctx);
            expect(verify.content).toContain("const x = 42;");
            expect(verify.content).not.toContain("const x = 1;");
        } finally {
            await cleanup();
        }
    });

    // ─── Bash → Read 管道 ───
    it("Bash 创建文件后 Read 应能读取", async () => {
        const bashTool = new BashTool();
        const readTool = new ReadTool();
        const testFile = "/tmp/y-claude-code-test-output.txt";
        const ctx = createMockToolContext({ workingDirectory: "/tmp" });

        // 1. 用 echo 创建文件
        const bashResult = await bashTool.execute(
            { command: `echo "hello world" > ${testFile}`, timeout: 5000 },
            ctx,
        );
        expect(bashResult.is_error).toBeFalsy();

        // 2. 用 Read 读取文件
        const readResult = await readTool.execute({ file_path: testFile }, ctx);
        expect(readResult.is_error).toBeFalsy();
        expect(readResult.content).toContain("hello world");
    });

    // ─── Grep → Read 管道 ───
    it("Grep 找到匹配后 Read 应能精确定位读取", async () => {
        const { filePath, cleanup } = await createTempFile(
            "line1: nothing\nline2: TARGET\nline3: nothing\nline4: TARGET2\nline5: end\n",
        );
        try {
            const grepTool = new GrepTool();
            const readTool = new ReadTool();
            const workDir = path.dirname(filePath);
            const ctx = createMockToolContext({ workingDirectory: workDir });

            // 1. 用 Grep 搜索
            const grepResult = await grepTool.execute(
                { pattern: "TARGET", path: filePath },
                ctx,
            );
            expect(grepResult.is_error).toBeFalsy();

            // 2. 用 Read 读取上下文
            const readResult = await readTool.execute(
                { file_path: filePath, offset: 0, limit: 10 },
                ctx,
            );
            expect(readResult.is_error).toBeFalsy();
            expect(readResult.content).toContain("TARGET");
        } finally {
            await cleanup();
        }
    });

    // ─── Glob → Read 管道 ───
    it("Glob 发现文件后 Read 多个文件", async () => {
        const readTool = new ReadTool();
        const ctx = createMockToolContext({ workingDirectory: "/tmp" });

        // 1. 用 Glob 搜索 .json 文件
        const globTool = new GlobTool();
        const globResult = await globTool.execute(
            { pattern: "/tmp/*.json" },
            ctx,
        );
        // Glob 可能找到也可能找不到，但不应报错
        expect(globResult.is_error).toBeFalsy();

        // 2. Read 应能处理不存在的文件（错误路径验证）
        const readResult = await readTool.execute(
            { file_path: "/tmp/nonexistent-file-xyz.json" },
            ctx,
        );
        expect(readResult.is_error).toBeTruthy();
    });

    // ─── 安全约束：路径穿越防护 ───
    it("所有工具均应拒绝工作目录外的路径", async () => {
        const ctx = createMockToolContext({ workingDirectory: "/home/user/project" });
        const tools = [new ReadTool(), new WriteTool(), new EditTool()];

        for (const tool of tools) {
            const result = await tool.execute(
                { file_path: "/etc/passwd", content: "", old_string: "", new_string: "" } as Record<string, unknown>,
                ctx,
            );
            // 所有工具都应拒绝越权路径
            expect(result.is_error).toBeTruthy();
            expect(result.content).toContain("安全限制");
        }
    });

    // ─── 大文件分段读取 ───
    it("Read offset/limit 应能分段读取大文件", async () => {
        const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
        const { filePath, cleanup } = await createTempFile(lines.join("\n"));
        try {
            const readTool = new ReadTool();
            const workDir = path.dirname(filePath);
            const ctx = createMockToolContext({ workingDirectory: workDir });

            // 读取前 10 行
            const page1 = await readTool.execute(
                { file_path: filePath, offset: 0, limit: 10 },
                ctx,
            );
            expect(page1.content).toContain("line 1");
            expect(page1.content).toContain("line 10");

            // 读取第 41-50 行
            const page5 = await readTool.execute(
                { file_path: filePath, offset: 40, limit: 10 },
                ctx,
            );
            expect(page5.content).toContain("line 41");
            expect(page5.content).toContain("line 50");
        } finally {
            await cleanup();
        }
    });
});
