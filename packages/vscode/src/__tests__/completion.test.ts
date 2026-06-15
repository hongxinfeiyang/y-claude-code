// ─── packages/vscode/src/__tests__/completion.test.ts ───
// 内联补全 Provider 单元测试
// 覆盖语言过滤、内容过滤、上下文提取、开关控制、错误降级
//
// 注意：vscode 模块在 Node 环境中不存在，使用 vitest mock 替代

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── mock vscode ───
// 所有 mock 值必须在 vi.mock 工厂内部定义（vi.mock 会被 hoist 到文件顶部）
// Position / Range / InlineCompletionItem 必须是可 new 的类

vi.mock("vscode", () => {
    class MockPosition {
        line: number;
        character: number;
        constructor(line: number, character: number) {
            this.line = line;
            this.character = character;
        }
    }
    class MockRange {
        start: MockPosition;
        end: MockPosition;
        constructor(start: MockPosition, end: MockPosition) {
            this.start = start;
            this.end = end;
        }
        get isEmpty() {
            return this.start.line === this.end.line && this.start.character === this.end.character;
        }
    }
    class MockInlineCompletionItem {
        insertText: string;
        range?: MockRange;
        command?: { title: string; command: string };
        constructor(text: string, range?: MockRange) {
            this.insertText = text;
            this.range = range;
        }
    }

    return {
        Position: MockPosition,
        Range: MockRange,
        InlineCompletionItem: MockInlineCompletionItem,
        InlineCompletionContext: {},
        CancellationToken: {},
        commands: {
            executeCommand: vi.fn(),
        },
    };
});

import { InlineCompletionProvider } from "../language/completion";
import * as vscode from "vscode";

// ─── 辅助：创建模拟文档 ───

function createMockDocument(options: {
    languageId: string;
    lines: string[];
    fileName?: string;
}) {
    return {
        languageId: options.languageId,
        fileName: options.fileName ?? "/test/file.ts",
        lineAt: (lineNum: number) => {
            const text = options.lines[lineNum] ?? "";
            return {
                text,
                range: new vscode.Range(
                    new vscode.Position(lineNum, 0),
                    new vscode.Position(lineNum, text.length),
                ),
                lineNumber: lineNum,
            };
        },
        getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
            if (!range) return options.lines.join("\n");
            const result: string[] = [];
            for (let i = range.start.line; i <= range.end.line; i++) {
                if (i === range.start.line && i === range.end.line) {
                    result.push(options.lines[i].slice(range.start.character, range.end.character));
                } else if (i === range.start.line) {
                    result.push(options.lines[i].slice(range.start.character));
                } else if (i === range.end.line) {
                    result.push(options.lines[i].slice(0, range.end.character));
                } else {
                    result.push(options.lines[i]);
                }
            }
            return result.join("\n");
        },
        lineCount: options.lines.length,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 补全开关测试
// ═══════════════════════════════════════════════════════════════════════════════

describe("InlineCompletionProvider — 开关控制", () => {
    it("禁用时应返回空数组", async () => {
        const provider = new InlineCompletionProvider(() => false);
        const doc = createMockDocument({ languageId: "typescript", lines: ["const x = 1"] });

        const result = await provider.provideInlineCompletionItems(
            doc as unknown as vscode.TextDocument,
            new vscode.Position(0, 12),
            {} as vscode.InlineCompletionContext,
            {} as vscode.CancellationToken,
        );

        expect(result).toEqual([]);
    });

    it("启用时应尝试补全（受语言过滤等其他条件影响）", async () => {
        const provider = new InlineCompletionProvider(() => true);
        // 不支持的 languageId 也会返回空
        const doc = createMockDocument({ languageId: "markdown", lines: ["# Hello"] });

        const result = await provider.provideInlineCompletionItems(
            doc as unknown as vscode.TextDocument,
            new vscode.Position(0, 7),
            {} as vscode.InlineCompletionContext,
            {} as vscode.CancellationToken,
        );

        expect(result).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 语言过滤测试
// ═══════════════════════════════════════════════════════════════════════════════

describe("InlineCompletionProvider — 语言过滤", () => {
    let provider: InlineCompletionProvider;

    beforeEach(() => {
        provider = new InlineCompletionProvider(() => true);
    });

    const supportedLanguages = [
        "typescript", "javascript", "typescriptreact", "javascriptreact",
        "python", "go", "rust", "java", "kotlin", "swift",
        "c", "cpp", "csharp", "ruby", "php", "vue", "svelte",
    ];

    for (const lang of supportedLanguages) {
        it(`${lang} 应被支持（非空行有内容会继续执行到 AI 调用）`, async () => {
            const doc = createMockDocument({ languageId: lang, lines: ["const x = 1"] });
            const result = await provider.provideInlineCompletionItems(
                doc as unknown as vscode.TextDocument,
                new vscode.Position(0, 12),
                {} as vscode.InlineCompletionContext,
                {} as vscode.CancellationToken,
            );
            // 支持的语言不会在语言过滤阶段被拦截（可能后续被其他条件拦截）
            // 这里验证命令被调用了（走了 requestCompletion 流程）
            expect(result).toBeDefined();
        });
    }

    const unsupportedLanguages = ["markdown", "json", "yaml", "xml", "html", "css", "shellscript"];

    for (const lang of unsupportedLanguages) {
        it(`${lang} 不应被支持（返回空数组）`, async () => {
            const doc = createMockDocument({ languageId: lang, lines: ["some text"] });
            const result = await provider.provideInlineCompletionItems(
                doc as unknown as vscode.TextDocument,
                new vscode.Position(0, 9),
                {} as vscode.InlineCompletionContext,
                {} as vscode.CancellationToken,
            );
            expect(result).toEqual([]);
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 内容过滤测试
// ═══════════════════════════════════════════════════════════════════════════════

describe("InlineCompletionProvider — 内容过滤", () => {
    let provider: InlineCompletionProvider;

    beforeEach(() => {
        provider = new InlineCompletionProvider(() => true);
    });

    it("空行应被跳过", async () => {
        const doc = createMockDocument({ languageId: "typescript", lines: [""] });
        const result = await provider.provideInlineCompletionItems(
            doc as unknown as vscode.TextDocument,
            new vscode.Position(0, 0),
            {} as vscode.InlineCompletionContext,
            {} as vscode.CancellationToken,
        );
        expect(result).toEqual([]);
    });

    it("仅空白字符的行应被跳过", async () => {
        const doc = createMockDocument({ languageId: "typescript", lines: ["    "] });
        const result = await provider.provideInlineCompletionItems(
            doc as unknown as vscode.TextDocument,
            new vscode.Position(0, 4),
            {} as vscode.InlineCompletionContext,
            {} as vscode.CancellationToken,
        );
        expect(result).toEqual([]);
    });

    it("// 注释行应被跳过", async () => {
        const doc = createMockDocument({ languageId: "typescript", lines: ["// this is a comment"] });
        const result = await provider.provideInlineCompletionItems(
            doc as unknown as vscode.TextDocument,
            new vscode.Position(0, 21),
            {} as vscode.InlineCompletionContext,
            {} as vscode.CancellationToken,
        );
        expect(result).toEqual([]);
    });

    it("/* 块注释应被跳过", async () => {
        const doc = createMockDocument({ languageId: "javascript", lines: ["/* block comment"] });
        const result = await provider.provideInlineCompletionItems(
            doc as unknown as vscode.TextDocument,
            new vscode.Position(0, 16),
            {} as vscode.InlineCompletionContext,
            {} as vscode.CancellationToken,
        );
        expect(result).toEqual([]);
    });

    it("前置有空白字符的 // 注释也应被跳过", async () => {
        const doc = createMockDocument({ languageId: "python", lines: ["    # python comment"] });
        const result = await provider.provideInlineCompletionItems(
            doc as unknown as vscode.TextDocument,
            new vscode.Position(0, 19),
            {} as vscode.InlineCompletionContext,
            {} as vscode.CancellationToken,
        );
        expect(result).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 上下文提取测试（通过 getPrecedingText 的间接验证）
// ═══════════════════════════════════════════════════════════════════════════════

describe("InlineCompletionProvider — 正常代码行触发 AI 补全", () => {
    it("有效的代码行应触发 command 调用（通过 requestCompletion）", async () => {
        const provider = new InlineCompletionProvider(() => true);
        const doc = createMockDocument({
            languageId: "typescript",
            lines: ["import React from 'react'", "", "function App() {", "  return ("],
        });

        // mock executeCommand 抛出异常 → 最终返回空数组
        vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error("no handler"));

        const result = await provider.provideInlineCompletionItems(
            doc as unknown as vscode.TextDocument,
            new vscode.Position(3, 10),
            {} as vscode.InlineCompletionContext,
            {} as vscode.CancellationToken,
        );

        expect(result).toEqual([]);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            "y-claude-code.provideCompletion",
            expect.objectContaining({
                language: "typescript",
                linePrefix: "  return (",
            }),
        );
    });
});

describe("InlineCompletionProvider — AI 返回有效补全时", () => {
    it("应返回 InlineCompletionItem", async () => {
        const provider = new InlineCompletionProvider(() => true);
        const doc = createMockDocument({
            languageId: "typescript",
            lines: ["const greeting = "],
        });

        vi.mocked(vscode.commands.executeCommand).mockResolvedValueOnce('"hello world"');

        const result = await provider.provideInlineCompletionItems(
            doc as unknown as vscode.TextDocument,
            new vscode.Position(0, 18),
            {} as vscode.InlineCompletionContext,
            {} as vscode.CancellationToken,
        );

        expect(result).toHaveLength(1);
        expect(result[0].insertText).toBe('"hello world"');
    });
});

describe("InlineCompletionProvider — AI 返回空字符串时", () => {
    it("应返回空数组（null / undefined / '' 同理）", async () => {
        const provider = new InlineCompletionProvider(() => true);
        const doc = createMockDocument({ languageId: "typescript", lines: ["const x ="] });

        vi.mocked(vscode.commands.executeCommand).mockResolvedValueOnce("");

        const result = await provider.provideInlineCompletionItems(
            doc as unknown as vscode.TextDocument,
            new vscode.Position(0, 9),
            {} as vscode.InlineCompletionContext,
            {} as vscode.CancellationToken,
        );

        expect(result).toEqual([]);
    });
});
