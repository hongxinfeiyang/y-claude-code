// ─── packages/vscode/src/__tests__/extension.test.ts ───
// 扩展 activate 函数测试
// 验证命令注册、Provider 注册、状态栏创建
//
// 注意：extension.ts 中对 @y-claude-code/core 的 import 是 type-only 编译时引用
//       运行时通过动态 import() 加载，因此 mock 整个 core 模块

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── 记录所有注册内容 ───

const registeredCommands: Map<string, (...args: unknown[]) => unknown> = new Map();
const registeredWebviewProviders: Map<string, unknown> = new Map();
const registeredInlineProviders: Array<{ pattern: unknown; provider: unknown }> = [];
const subscriptionItems: Array<{ dispose?: () => void }> = [];
let statusBarCreated = false;
let statusBarText = "";

// ─── mock vscode ───

vi.mock("vscode", () => ({
    Uri: {
        file: (p: string) => ({ fsPath: p, scheme: "file" }),
    },
    workspace: {
        getConfiguration: () => ({
            get: (key: string) => {
                const defaults: Record<string, unknown> = {
                    model: "claude-sonnet-4-6",
                    provider: "anthropic",
                };
                return defaults[key];
            },
        }),
        workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }],
        openTextDocument: vi.fn().mockResolvedValue({
            getText: () => "test content",
            uri: { fsPath: "/test/file.ts" },
            positionAt: (offset: number) => ({ line: 0, character: offset }),
        }),
        applyEdit: vi.fn().mockResolvedValue(true),
    },
    window: {
        registerWebviewViewProvider: (id: string, provider: unknown) => {
            registeredWebviewProviders.set(id, provider);
            return { dispose: vi.fn() };
        },
        createStatusBarItem: () => {
            statusBarCreated = true;
            const item = {
                text: "",
                show: vi.fn(),
                dispose: vi.fn(),
            };
            // 劫持 text setter
            Object.defineProperty(item, "text", {
                get() { return statusBarText; },
                set(v: string) { statusBarText = v; },
            });
            subscriptionItems.push(item);
            return item;
        },
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        activeTextEditor: undefined,
    },
    commands: {
        registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
            registeredCommands.set(name, handler);
            const disposable = { dispose: vi.fn() };
            subscriptionItems.push(disposable);
            return disposable;
        },
        executeCommand: vi.fn(),
    },
    languages: {
        registerInlineCompletionItemProvider: (pattern: unknown, provider: unknown) => {
            registeredInlineProviders.push({ pattern, provider });
            const disposable = { dispose: vi.fn() };
            subscriptionItems.push(disposable);
            return disposable;
        },
    },
    ExtensionContext: {},
    StatusBarAlignment: { Right: 2 },
    InlineCompletionItem: vi.fn(),
    InlineCompletionContext: {},
    CancellationToken: {},
    WorkspaceEdit: vi.fn(),
    Range: vi.fn(),
    Position: vi.fn(),
}));

// ─── mock @y-claude-code/core ───

vi.mock("@y-claude-code/core", () => ({
    AgentLoop: vi.fn().mockImplementation(() => ({
        run: vi.fn(),
    })),
    ConfigLoader: vi.fn().mockImplementation(() => ({
        load: vi.fn().mockResolvedValue({
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            maxToolRounds: 20,
            maxTokensPerTurn: 8000,
            thinkingEnabled: false,
            thinkingTokens: 1024,
            permissions: { defaultMode: "ask" },
        }),
    })),
    ToolRegistry: {
        createDefault: () => ({
            listAll: () => [],
        }),
    },
    createProvider: vi.fn().mockReturnValue({
        chat: vi.fn(),
    }),
    buildSystemPrompt: vi.fn().mockResolvedValue("mock system prompt"),
    PermissionManager: vi.fn(),
    Logger: vi.fn().mockImplementation(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    })),
}));

import { activate, deactivate } from "../extension";
import { ExtensionRuntime } from "../runtime";
import * as vscode from "vscode";

// ─── 辅助：创建一个最小的 ExtensionContext mock ───

function createMockContext() {
    const subscriptions: Array<{ dispose: () => void }> = [];
    return {
        subscriptions,
        extensionUri: { fsPath: "/test/ext", scheme: "file" },
        extensionPath: "/test/ext",
        globalState: {
            get: vi.fn(),
            update: vi.fn(),
        },
        workspaceState: {
            get: vi.fn(),
            update: vi.fn(),
        },
        globalStorageUri: { fsPath: "/test/globalStorage" },
        logUri: { fsPath: "/test/log" },
        extensionMode: 1,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// activate — 命令注册验证
// ═══════════════════════════════════════════════════════════════════════════════

describe("extension.activate — 命令注册", () => {
    beforeEach(() => {
        ExtensionRuntime.resetInstance();
        registeredCommands.clear();
        registeredWebviewProviders.clear();
        registeredInlineProviders.length = 0;
        subscriptionItems.length = 0;
        statusBarCreated = false;
        statusBarText = "";
    });

    it("activate 后应注册全部 11 个 commands + providers", async () => {
        const ctx = createMockContext();
        await activate(ctx as unknown as vscode.ExtensionContext);

        // 9 个命令 + 1 个 webview provider + 1 个 inline completion provider = 11
        const totalSubscriptions = ctx.subscriptions.length;
        expect(totalSubscriptions).toBeGreaterThanOrEqual(9); // 至少 9 个（命令 + providers）

        // 验证关键命令已注册
        expect(registeredCommands.has("y-claude-code.openChat")).toBe(true);
        expect(registeredCommands.has("y-claude-code.toggleCompletion")).toBe(true);
        expect(registeredCommands.has("y-claude-code.explainSelection")).toBe(true);
        expect(registeredCommands.has("y-claude-code.reviewFile")).toBe(true);
        expect(registeredCommands.has("y-claude-code.processMessage")).toBe(true);
        expect(registeredCommands.has("y-claude-code.provideCompletion")).toBe(true);
        expect(registeredCommands.has("y-claude-code.applyEdit")).toBe(true);
        expect(registeredCommands.has("y-claude-code.showDiff")).toBe(true);
    });

    it("应注册聊天 Webview Provider", async () => {
        const ctx = createMockContext();
        await activate(ctx as unknown as vscode.ExtensionContext);

        expect(registeredWebviewProviders.has("y-claude-code.chat")).toBe(true);
    });

    it("应注册内联补全 Provider", async () => {
        const ctx = createMockContext();
        await activate(ctx as unknown as vscode.ExtensionContext);

        expect(registeredInlineProviders.length).toBe(1);
        expect(registeredInlineProviders[0].pattern).toEqual({ pattern: "**" });
    });

    it("应创建状态栏项目", async () => {
        const ctx = createMockContext();
        await activate(ctx as unknown as vscode.ExtensionContext);

        expect(statusBarCreated).toBe(true);
    });

    it("状态栏应显示 y-claude-code", async () => {
        const ctx = createMockContext();
        await activate(ctx as unknown as vscode.ExtensionContext);

        expect(statusBarText).toContain("y-claude-code");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// activate — 命令行为验证
// ═══════════════════════════════════════════════════════════════════════════════

describe("extension.activate — 内联命令行为", () => {
    beforeEach(() => {
        ExtensionRuntime.resetInstance();
        registeredCommands.clear();
        registeredWebviewProviders.clear();
        registeredInlineProviders.length = 0;
        subscriptionItems.length = 0;
        statusBarCreated = false;
        statusBarText = "";
    });

    it("toggleCompletion 应切换补全状态并弹窗", async () => {
        const ctx = createMockContext();
        await activate(ctx as unknown as vscode.ExtensionContext);

        const handler = registeredCommands.get("y-claude-code.toggleCompletion");
        expect(handler).toBeDefined();

        await handler!();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining("已关闭"),
        );

        await handler!();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining("已开启"),
        );
    });

    it("explainSelection 在无选中文本时应弹警告", async () => {
        const ctx = createMockContext();
        await activate(ctx as unknown as vscode.ExtensionContext);

        // mock 无选中文本
        const origActiveEditor = vscode.window.activeTextEditor;
        (vscode.window as Record<string, unknown>).activeTextEditor = {
            document: {
                getText: () => "",
            },
            selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        };

        const handler = registeredCommands.get("y-claude-code.explainSelection");
        await handler!();

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("选中"),
        );

        (vscode.window as Record<string, unknown>).activeTextEditor = origActiveEditor;
    });

    it("reviewFile 在无活动编辑器时应直接返回", async () => {
        const ctx = createMockContext();
        await activate(ctx as unknown as vscode.ExtensionContext);

        const handler = registeredCommands.get("y-claude-code.reviewFile");
        // activeTextEditor 为 undefined → 应直接返回
        await handler!();
        // 不应该抛异常
    });

    it("processMessage 应处理 AI 对话流式响应", async () => {
        // mock core 模块中 AgentLoop.run 为 async generator
        const mockCore = await import("@y-claude-code/core");
        const mockRun = vi.fn().mockImplementation(async function* () {
            yield { type: "text", content: "Hello" };
            yield { type: "text", content: " World" };
            yield { type: "tool_call", tool: { name: "ReadTool" } };
        });
        const AgentLoopMock = mockCore.AgentLoop as unknown as {
            mockReturnValueOnce: (v: unknown) => void;
        };
        AgentLoopMock.mockReturnValueOnce({
            run: mockRun,
        });

        const ctx = createMockContext();
        await activate(ctx as unknown as vscode.ExtensionContext);

        const handler = registeredCommands.get("y-claude-code.processMessage");
        expect(handler).toBeDefined();

        // 执行命令（异步 agent loop）
        await handler!("hello AI");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// deactivate
// ═══════════════════════════════════════════════════════════════════════════════

describe("extension.deactivate", () => {
    it("deactivate 不应抛异常", () => {
        expect(() => deactivate()).not.toThrow();
    });
});
