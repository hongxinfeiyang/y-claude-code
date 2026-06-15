// ─── packages/vscode/src/__tests__/panel.test.ts ───
// 聊天面板 Provider 单元测试
// 覆盖消息管理、流式缓冲、postMessage 事件路由、pending 消息处理

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── mock vscode ───

const mockPostMessage = vi.fn();
const mockOnDidReceiveMessage = vi.fn();
let receiveHandler: ((data: unknown) => void) | null = null;

const mockWebview = {
    postMessage: mockPostMessage,
    onDidReceiveMessage: (cb: (data: unknown) => void) => {
        receiveHandler = cb;
        return { dispose: vi.fn() };
    },
    options: {} as Record<string, unknown>,
    html: "",
};

const mockWebviewView = {
    webview: mockWebview,
};

vi.mock("vscode", () => ({
    Uri: {
        file: (p: string) => ({ fsPath: p, scheme: "file" }),
        parse: (p: string) => ({ fsPath: p, scheme: "file" }),
    },
    ExtensionContext: {},
    WebviewViewProvider: {},
    WebviewView: {},
    commands: {
        executeCommand: vi.fn(),
    },
    window: {
        showInformationMessage: vi.fn(),
    },
    env: {
        clipboard: {
            writeText: vi.fn(),
        },
    },
    EventEmitter: vi.fn(),
}));

import { ChatPanelProvider } from "../webview/panel";
import * as vscode from "vscode";

// ─── 辅助：创建 provider 并 resolve ───

function createProvider(): ChatPanelProvider {
    const provider = new ChatPanelProvider(
        { fsPath: "/test", scheme: "file" } as vscode.Uri,
        {} as vscode.ExtensionContext,
    );
    provider["_view"] = mockWebviewView as unknown as vscode.WebviewView;
    // 触发 resolveWebviewView 以注册消息处理器
    provider.resolveWebviewView(mockWebviewView as unknown as vscode.WebviewView);
    return provider;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 消息历史管理
// ═══════════════════════════════════════════════════════════════════════════════

describe("ChatPanelProvider — 消息管理", () => {
    let provider: ChatPanelProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        receiveHandler = null;
        provider = createProvider();
    });

    it("sendMessage 应添加用户消息到历史并 postMessage", () => {
        provider.sendMessage("hello");

        const messages = provider["messages"];
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe("user");
        expect(messages[0].content).toBe("hello");

        expect(mockPostMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "newMessage",
                message: { role: "user", content: "hello" },
            }),
        );
    });

    it("sendMessage 在 _view 未就绪时应缓存为 pending", () => {
        const p = new ChatPanelProvider(
            { fsPath: "/test", scheme: "file" } as vscode.Uri,
            {} as vscode.ExtensionContext,
        );
        // _view 未设置
        p.sendMessage("pending hello");
        expect(p["pendingMessages"]).toContain("pending hello");
    });

    it("finalizeMessage 应把缓冲文本保存为助手消息", () => {
        provider.appendToLastMessage("Hello ");
        provider.appendToLastMessage("World");
        provider.finalizeMessage();

        const messages = provider["messages"];
        const assistantMsg = messages.find((m) => m.role === "assistant");
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg!.content).toBe("Hello World");
        expect(provider["currentStreamContent"]).toBe("");
    });

    it("finalizeMessage 在无缓冲内容时不应添加消息", () => {
        const prevCount = provider["messages"].length;
        provider.finalizeMessage();
        expect(provider["messages"].length).toBe(prevCount);
    });

    it("多次 sendMessage 应累积所有用户消息", () => {
        provider.sendMessage("msg1");
        provider.sendMessage("msg2");
        provider.sendMessage("msg3");

        const userMessages = provider["messages"].filter((m) => m.role === "user");
        expect(userMessages).toHaveLength(3);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 流式缓冲测试
// ═══════════════════════════════════════════════════════════════════════════════

describe("ChatPanelProvider — 流式缓冲", () => {
    let provider: ChatPanelProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        receiveHandler = null;
        provider = createProvider();
    });

    it("appendToLastMessage 应累积文本到缓冲区", () => {
        provider.appendToLastMessage("chunk1");
        provider.appendToLastMessage("chunk2");
        expect(provider["currentStreamContent"]).toBe("chunk1chunk2");
    });

    it("appendToLastMessage 应通过 postMessage 发送 chunk", () => {
        provider.appendToLastMessage("test-chunk");
        expect(mockPostMessage).toHaveBeenCalledWith({
            type: "appendText",
            chunk: "test-chunk",
        });
    });

    it("appendToolCall 应通过 postMessage 发送工具名", () => {
        provider.appendToolCall("ReadTool");
        expect(mockPostMessage).toHaveBeenCalledWith({
            type: "toolCall",
            name: "ReadTool",
        });
    });

    it("appendError 应通过 postMessage 发送错误信息", () => {
        provider.appendError("something went wrong");
        expect(mockPostMessage).toHaveBeenCalledWith({
            type: "error",
            content: "something went wrong",
        });
    });

    it("setProcessing(true) 应发送激活状态", () => {
        provider.setProcessing(true);
        expect(mockPostMessage).toHaveBeenCalledWith({
            type: "processing",
            active: true,
        });
    });

    it("setProcessing(false) 应发送未激活状态", () => {
        provider.setProcessing(false);
        expect(mockPostMessage).toHaveBeenCalledWith({
            type: "processing",
            active: false,
        });
    });

    it("showDiffInPanel 应发送差异数据", () => {
        provider.showDiffInPanel("Test Diff", "original", "modified");
        expect(mockPostMessage).toHaveBeenCalledWith({
            type: "showDiff",
            title: "Test Diff",
            original: "original",
            modified: "modified",
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Webview 消息路由测试
// ═══════════════════════════════════════════════════════════════════════════════

describe("ChatPanelProvider — Webview 消息路由", () => {
    let provider: ChatPanelProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        receiveHandler = null;
        provider = createProvider();
        // resolveWebviewView 在 createProvider 中已调用，此时 receiveHandler 应已设置
    });

    it("userInput 消息应添加用户消息并触发 processMessage 命令", () => {
        expect(receiveHandler).not.toBeNull();
        receiveHandler!({ type: "userInput", content: "user question" });

        expect(provider["messages"]).toContainEqual(
            expect.objectContaining({ role: "user", content: "user question" }),
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            "y-claude-code.processMessage",
            "user question",
        );
    });

    it("clearChat 消息应清空消息列表并发送确认", () => {
        provider.sendMessage("test");
        expect(provider["messages"].length).toBeGreaterThan(0);

        mockPostMessage.mockClear();
        receiveHandler!({ type: "clearChat" });

        expect(provider["messages"]).toEqual([]);
        expect(mockPostMessage).toHaveBeenCalledWith({ type: "clearChat" });
    });

    it("ready 消息应发送历史消息和 pending 消息", () => {
        // 先添加一个 pending 消息
        const p = new ChatPanelProvider(
            { fsPath: "/test", scheme: "file" } as vscode.Uri,
            {} as vscode.ExtensionContext,
        );
        p["pendingMessages"] = ["pending-msg"];
        // 手动设置 view 并 resolve
        p["_view"] = mockWebviewView as unknown as vscode.WebviewView;
        mockPostMessage.mockClear();
        receiveHandler = null;
        p.resolveWebviewView(mockWebviewView as unknown as vscode.WebviewView);

        // resolveWebviewView 内的 onDidReceiveMessage 被调用并设置了 receiveHandler
        expect(receiveHandler).not.toBeNull();
        receiveHandler!({ type: "ready" });

        // 应发送 history
        expect(mockPostMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "history" }),
        );
        // 应发送 pending 消息
        expect(mockPostMessage).toHaveBeenCalledWith({
            type: "newMessage",
            message: { role: "user", content: "pending-msg" },
        });
        // pending 应被清空
        expect(p["pendingMessages"]).toEqual([]);
    });

    it("applyEdit 消息应触发 applyEdit 命令", () => {
        receiveHandler!({
            type: "applyEdit",
            filePath: "/test/file.ts",
            oldText: "old",
            newText: "new",
        });

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            "y-claude-code.applyEdit",
            "/test/file.ts",
            "old",
            "new",
        );
    });

    it("showDiffCommand 消息应触发 showDiff 命令", () => {
        receiveHandler!({
            type: "showDiffCommand",
            title: "diff title",
            filePath: "/test/f.ts",
            original: "orig",
            modified: "mod",
        });

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            "y-claude-code.showDiff",
            "diff title",
            "/test/f.ts",
            "orig",
            "mod",
        );
    });

    it("copyCode 消息应写剪贴板并弹通知", () => {
        receiveHandler!({ type: "copyCode", code: "console.log(1)" });

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("console.log(1)");
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("代码已复制");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HTML 模板测试
// ═══════════════════════════════════════════════════════════════════════════════

describe("ChatPanelProvider — HTML 模板", () => {
    it("getHtmlContent 应返回包含关键结构的 HTML", () => {
        const provider = new ChatPanelProvider(
            { fsPath: "/test", scheme: "file" } as vscode.Uri,
            {} as vscode.ExtensionContext,
        );
        // 直接调用私有方法
        const html = provider["getHtmlContent"]();

        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain('id="messages"');
        expect(html).toContain('id="input-area"');
        expect(html).toContain('id="loading"');
        expect(html).toContain("acquireVsCodeApi()");
        expect(html).toContain("renderMarkdown");
        expect(html).toContain("renderDiff");
        expect(html).toContain("y-claude-code");
    });
});
