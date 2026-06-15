// ─── packages/vscode/src/webview/panel.ts ───
// Webview 聊天面板 — VS Code 侧边栏中的 AI 对话界面
// 解决问题：VS Code 扩展需要在侧边栏提供一个类似 ChatGPT 的对话界面，
// 用户输入问题后由 AI 回答，支持历史记录、流式输出、Markdown 渲染、
// 差异视图、代码复制和进度指示。

import * as vscode from "vscode";

interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: number;
}

export class ChatPanelProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private messages: ChatMessage[] = [];
    private pendingMessages: string[] = [];

    /** 当前流式消息的文本缓冲区 */
    private currentStreamContent = "";

    /** 待处理的审批 — approvalId → { resolve } */
    private _pendingApprovals = new Map<string, (approved: boolean) => void>();
    private _approvalIdCounter = 0;

    constructor(extensionUri: vscode.Uri, private context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
    }

    sendMessage(content: string): void {
        if (this._view) {
            this.messages.push({ role: "user", content, timestamp: Date.now() });
            this._view.webview.postMessage({ type: "newMessage", message: { role: "user", content } });
        } else {
            this.pendingMessages.push(content);
        }
    }

    /**
     * 通知 Webview 进入处理状态（显示加载指示器）
     */
    setProcessing(active: boolean): void {
        this._view?.webview.postMessage({ type: "processing", active });
    }

    /**
     * 追加流式文本到当前助手消息
     */
    appendToLastMessage(chunk: string): void {
        this.currentStreamContent += chunk;
        this._view?.webview.postMessage({ type: "appendText", chunk });
    }

    /**
     * 追加工具调用信息（含参数，用于 webview 展示具体文件路径/命令等）
     */
    appendToolCall(toolName: string, params?: Record<string, unknown>): void {
        this._view?.webview.postMessage({ type: "toolCall", name: toolName, params });
    }

    /**
     * 向 webview 发送审批请求（由 permissionManager.promptCallback 调用）
     * 返回 Promise，在用户点击同意/拒绝后 resolve
     */
    showApprovalRequest(toolUse: { id?: string; name: string; input: Record<string, unknown> }): Promise<boolean> {
        return new Promise((resolve) => {
            const approvalId = `a-${++this._approvalIdCounter}`;
            this._pendingApprovals.set(approvalId, resolve);
            this._view?.webview.postMessage({
                type: "approvalRequest",
                approvalId,
                tool: { name: toolUse.name, input: toolUse.input },
            });
        });
    }

    /**
     * 追加错误信息
     */
    appendError(error: string): void {
        this._view?.webview.postMessage({ type: "error", content: error });
    }

    /**
     * 流式消息完成，保存到历史
     */
    finalizeMessage(): void {
        if (this.currentStreamContent) {
            this.messages.push({
                role: "assistant",
                content: this.currentStreamContent,
                timestamp: Date.now(),
            });
            this.currentStreamContent = "";
        }
        this._view?.webview.postMessage({ type: "finalize" });
    }

    /**
     * 展示差异视图
     */
    showDiffInPanel(title: string, original: string, modified: string): void {
        this._view?.webview.postMessage({
            type: "showDiff",
            title,
            original,
            modified,
        });
    }

    // ─── WebviewViewProvider ───

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this.getHtmlContent();

        webviewView.webview.onDidReceiveMessage((data) => {
            switch (data.type) {
                case "userInput": {
                    const userMessage = data.content as string;
                    this.messages.push({ role: "user", content: userMessage, timestamp: Date.now() });
                    try {
                        vscode.commands.executeCommand("y-claude-code.processMessage", userMessage);
                    } catch (e) {
                        console.error("processMessage 命令执行失败:", e);
                        vscode.window.showErrorMessage(`处理消息失败: ${e}`);
                    }
                    break;
                }
                case "clearChat": {
                    this.messages = [];
                    webviewView.webview.postMessage({ type: "clearChat" });
                    vscode.commands.executeCommand("y-claude-code.clearChat");
                    break;
                }
                case "ready": {
                    webviewView.webview.postMessage({ type: "history", messages: this.messages });
                    for (const msg of this.pendingMessages) {
                        webviewView.webview.postMessage({ type: "newMessage", message: { role: "user", content: msg } });
                    }
                    this.pendingMessages = [];
                    break;
                }
                case "applyEdit": {
                    vscode.commands.executeCommand("y-claude-code.applyEdit", data.filePath, data.oldText, data.newText);
                    break;
                }
                case "showDiffCommand": {
                    vscode.commands.executeCommand("y-claude-code.showDiff", data.title, data.filePath, data.original, data.modified);
                    break;
                }
                case "copyCode": {
                    vscode.env.clipboard.writeText(data.code);
                    vscode.window.showInformationMessage("代码已复制");
                    break;
                }
                case "approvalResponse": {
                    const resolve = this._pendingApprovals.get(data.approvalId);
                    if (resolve) {
                        resolve(data.approved as boolean);
                        this._pendingApprovals.delete(data.approvalId);
                    }
                    break;
                }
            }
        });
    }

    // ─── HTML 模板 ───

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>y-claude-code Chat</title>
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --border: var(--vscode-panel-border);
            --input-bg: var(--vscode-input-background);
            --accent: var(--vscode-focusBorder);
            --user-color: #4FC1FF;
            --tool-color: #FFD700;
            --error-color: #FF4444;
            --diff-add-bg: rgba(0, 255, 0, 0.15);
            --diff-remove-bg: rgba(255, 0, 0, 0.15);
            --code-bg: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            color: var(--fg);
            background: var(--bg);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        #messages {
            flex: 1;
            overflow-y: auto;
            padding: 8px;
        }
        .message {
            margin-bottom: 12px;
            padding: 6px 8px;
            border-radius: 4px;
        }
        .message.user {
            color: var(--user-color);
            border-left: 2px solid var(--user-color);
            padding-left: 8px;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .message.assistant {
            color: var(--fg);
            line-height: 1.6;
        }
        .message .tool-call {
            color: var(--tool-color);
            font-size: 11px;
            margin: 4px 0;
            padding: 2px 6px;
            background: rgba(255,215,0,0.1);
            border-radius: 3px;
            display: inline-block;
        }
        .message .approval-block {
            margin: 6px 0;
            padding: 8px;
            border: 1px solid var(--accent);
            border-radius: 4px;
            background: rgba(255,255,255,0.03);
        }
        .message .approval-info {
            font-size: 12px;
            margin-bottom: 6px;
        }
        .message .approval-content-preview {
            background: var(--code-bg);
            padding: 6px 10px;
            border-radius: 3px;
            font-size: 11px;
            max-height: 120px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-all;
            margin: 4px 0 8px;
            border: 1px solid var(--border);
            opacity: 0.85;
        }
        .message .approval-buttons {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }
        .message .approval-buttons button {
            padding: 4px 14px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            font-weight: bold;
        }
        .message .approval-buttons button:disabled {
            opacity: 0.4;
            cursor: default;
        }
        .approval-accept {
            background: #2ea043;
            color: white;
        }
        .approval-accept:hover:not(:disabled) {
            background: #3fb950;
        }
        .approval-reject {
            background: #da3633;
            color: white;
        }
        .approval-reject:hover:not(:disabled) {
            background: #f85149;
        }
        .approval-result {
            font-size: 12px;
            font-weight: bold;
        }
        .approval-result.accepted {
            color: #3fb950;
        }
        .approval-result.rejected {
            color: #f85149;
        }
        .message .error-block {
            color: var(--error-color);
            font-size: 12px;
            margin: 4px 0;
            padding: 4px 8px;
            background: rgba(255,0,0,0.1);
            border-radius: 3px;
        }
        /* ─── Markdown 渲染 ─── */
        .message h1, .message h2, .message h3, .message h4 { margin: 8px 0 4px; font-weight: bold; }
        .message h1 { font-size: 1.3em; }
        .message h2 { font-size: 1.15em; border-bottom: 1px solid var(--border); padding-bottom: 2px; }
        .message h3 { font-size: 1.05em; }
        .message p { margin: 4px 0; }
        .message ul, .message ol { margin: 4px 0; padding-left: 20px; }
        .message li { margin: 2px 0; }
        .message blockquote {
            border-left: 3px solid var(--accent);
            margin: 4px 0;
            padding: 4px 8px;
            opacity: 0.8;
        }
        .message strong { font-weight: bold; }
        .message em { font-style: italic; }
        .message a { color: var(--accent); }
        .message hr { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
        .message table { border-collapse: collapse; margin: 8px 0; width: 100%; table-layout: fixed; }
        .message th, .message td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; word-break: break-word; overflow-wrap: break-word; }
        .message th { background: rgba(255,255,255,0.05); }
        /* ─── 代码块 ─── */
        .code-block-wrapper {
            position: relative;
            margin: 8px 0;
            border-radius: 4px;
            overflow: hidden;
            border: 1px solid var(--border);
        }
        .code-block-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 8px;
            background: rgba(255,255,255,0.05);
            border-bottom: 1px solid var(--border);
            font-size: 11px;
        }
        .code-block-header .lang { opacity: 0.6; }
        .code-block-header button {
            background: none;
            border: 1px solid var(--border);
            color: var(--fg);
            padding: 2px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .code-block-header button:hover { background: rgba(255,255,255,0.1); }
        .code-block-wrapper pre {
            background: var(--code-bg);
            padding: 8px 12px;
            overflow-x: auto;
            margin: 0;
            font-size: 12px;
            line-height: 1.5;
        }
        .code-block-wrapper pre code { background: none; padding: 0; font-family: var(--vscode-editor-font-family); }
        code { background: rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 2px; font-size: 0.95em; }
        /* ─── 差异视图 ─── */
        .diff-view {
            margin: 8px 0;
            border: 1px solid var(--border);
            border-radius: 4px;
            overflow: hidden;
        }
        .diff-header {
            padding: 6px 10px;
            background: rgba(255,255,255,0.05);
            border-bottom: 1px solid var(--border);
            font-weight: bold;
            font-size: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .diff-header button {
            background: var(--accent);
            color: white;
            border: none;
            padding: 3px 10px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .diff-line {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            padding: 1px 8px;
            white-space: pre-wrap;
        }
        .diff-line.add { background: var(--diff-add-bg); color: #4CAF50; }
        .diff-line.remove { background: var(--diff-remove-bg); color: #F44336; }
        .diff-line.context { opacity: 0.7; }
        /* ─── 加载指示器 ─── */
        .loading-indicator {
            display: none;
            align-items: center;
            padding: 8px;
            color: var(--accent);
            font-size: 12px;
        }
        .loading-indicator.active { display: flex; }
        .loading-indicator .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-right: 8px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        /* ─── 输入区域 ─── */
        #input-area {
            display: flex;
            border-top: 1px solid var(--border);
            padding: 8px;
        }
        #input-area textarea {
            flex: 1;
            background: var(--input-bg);
            color: var(--fg);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 8px;
            resize: none;
            font-family: inherit;
            font-size: 13px;
            outline: none;
            min-height: 36px;
            max-height: 120px;
        }
        #input-area textarea:focus { border-color: var(--accent); }
        #input-area button {
            margin-left: 8px;
            padding: 8px 16px;
            background: var(--accent);
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            white-space: nowrap;
        }
        #input-area button:hover { opacity: 0.9; }
        #input-area button:disabled { opacity: 0.5; cursor: default; }
        .empty-state {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: #888;
            font-size: 14px;
            flex-direction: column;
            gap: 8px;
        }
        .empty-state .shortcut { font-size: 11px; opacity: 0.6; }
    </style>
</head>
<body>
    <div id="messages">
        <div class="empty-state">
            <div>输入你的问题开始对话</div>
            <div class="shortcut">Ctrl+Shift+E 解释选中代码</div>
        </div>
    </div>
    <div class="loading-indicator" id="loading">
        <span class="spinner"></span> AI 正在思考...
    </div>
    <div id="input-area">
        <textarea id="user-input" rows="2" placeholder="输入消息... (Shift+Enter 换行, Enter 发送)"></textarea>
        <button id="send-btn">发送</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const messagesEl = document.getElementById('messages');
        const textarea = document.getElementById('user-input');
        const sendBtn = document.getElementById('send-btn');
        const loadingEl = document.getElementById('loading');
        let lastAssistantMsg = null;
        let isProcessing = false;

        function clearEmptyState() {
            const empty = messagesEl.querySelector('.empty-state');
            if (empty) empty.remove();
        }

        // ─── 简单 Markdown 渲染 ───
        function renderMarkdown(text) {
            // ─── 表格解析 ───
            // 解决问题: 自定义 markdown 渲染器未处理表格语法，
            //         导致 LLM 输出的 | col1 | col2 | 格式表格显示为纯文本无换行
            // 行级正则：匹配以 | 开头且有内容的行（允许首尾空格），连续的行组成表格块
            // 注意: 模板字面量中 \\n \\r 需双反斜杠，否则会被转为实际换行符导致 JS 语法错误
            text = text.replace(/((?:^ *\\|[^\\n]+\\| *[\\r\\n]*)+)/gm, function(tableBlock) {
                var rows = tableBlock.trim().split(/[\\r\\n]+/);
                // 至少需要表头 + 分隔行 = 2 行，且第二行只含 |、-、:、空格
                if (rows.length < 2) return tableBlock;
                if (!/^[-|: ]+$/.test(rows[1].trim())) return tableBlock;
                // 第一行为表头
                var headerCells = rows[0].split('|').filter(function(c) { return c.trim(); });
                var thead = '<thead><tr>' + headerCells.map(function(c) { return '<th>' + c.trim() + '</th>'; }).join('') + '</tr></thead>';
                // 跳过分隔行，处理数据行
                var bodyRows = rows.slice(2);
                var tbody = '<tbody>' + bodyRows.map(function(row) {
                    var cells = row.split('|').filter(function(c, i, arr) { return i > 0 && i < arr.length - 1 || c.trim(); });
                    return '<tr>' + cells.map(function(c) { return '<td>' + c.trim() + '</td>'; }).join('') + '</tr>';
                }).join('') + '</tbody>';
                return '\\n\\n<table>' + thead + tbody + '</table>\\n\\n';
            });
            // 清理表格替换可能产生的多余空行
            text = text.replace(/\\n\\n\\n+/g, '\\n\\n');

            // 代码块
            text = text.replace(/\`\`\`(\w*)\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
                var escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                var langLabel = lang || 'code';
                return '<div class="code-block-wrapper">' +
                    '<div class="code-block-header">' +
                    '<span class="lang">' + langLabel + '</span>' +
                    '<button onclick="copyCode(this)">复制</button>' +
                    '</div>' +
                    '<pre><code>' + escaped + '</code></pre>' +
                    '</div>';
            });
            // 行内代码
            text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            // 粗体
            text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
            // 斜体
            text = text.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
            // 标题
            text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
            text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
            text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
            // 链接
            text = text.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
            // 无序列表
            text = text.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
            text = text.replace(/(<li>.*<\\/li>)/s, function(m) { return '<ul>' + m + '</ul>'; });
            // 引用
            text = text.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
            // 水平线
            text = text.replace(/^---$/gm, '<hr>');
            // 段落
            var parts = text.split(/\\n\\n/);
            return parts.map(function(p) {
                if (p.trim().match(/^<(h[1-4]|ul|ol|blockquote|hr|pre|div|table)/)) return p;
                return '<p>' + p.replace(/\\n/g, '<br>') + '</p>';
            }).join('');
        }

        function renderDiff(title, original, modified) {
            var origLines = original.split('\\n');
            var modLines = modified.split('\\n');
            var html = '<div class="diff-view"><div class="diff-header">' +
                '<span>' + (title || '差异') + '</span>' +
                '<button onclick="acceptDiff()">应用修改</button>' +
                '</div>';

            var maxLen = Math.max(origLines.length, modLines.length);
            var diffStart = 0, origEnd = origLines.length - 1, modEnd = modLines.length - 1;
            while (diffStart < origLines.length && diffStart < modLines.length &&
                   origLines[diffStart] === modLines[diffStart]) diffStart++;
            while (origEnd >= diffStart && modEnd >= diffStart &&
                   origLines[origEnd] === modLines[modEnd]) { origEnd--; modEnd--; }

            var ctx = 3;
            var start = Math.max(0, diffStart - ctx);
            var oEnd = Math.min(origLines.length - 1, origEnd + ctx);
            var mEnd = Math.min(modLines.length - 1, modEnd + ctx);

            for (var i = start; i <= oEnd || i <= mEnd; i++) {
                if (i < diffStart) {
                    if (i < origLines.length) html += '<div class="diff-line context"> ' + escHtml(origLines[i]) + '</div>';
                } else if (i <= origEnd && i <= modEnd) {
                    html += '<div class="diff-line remove">- ' + escHtml(origLines[i] || '') + '</div>';
                    html += '<div class="diff-line add">+ ' + escHtml(modLines[i] || '') + '</div>';
                } else if (i <= oEnd && i < origLines.length) {
                    html += '<div class="diff-line remove">- ' + escHtml(origLines[i]) + '</div>';
                } else if (i <= mEnd && i < modLines.length) {
                    html += '<div class="diff-line add">+ ' + escHtml(modLines[i]) + '</div>';
                }
            }
            html += '</div>';
            return html;
        }

        function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

        function addMessage(role, content) {
            clearEmptyState();
            var div = document.createElement('div');
            div.className = 'message ' + role;
            if (role === 'assistant') {
                div.innerHTML = renderMarkdown(content);
                lastAssistantMsg = div;
            } else {
                div.textContent = content;
            }
            messagesEl.appendChild(div);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function appendText(chunk) {
            if (!lastAssistantMsg) {
                // 创建新的助手消息
                clearEmptyState();
                lastAssistantMsg = document.createElement('div');
                lastAssistantMsg.className = 'message assistant';
                messagesEl.appendChild(lastAssistantMsg);
            }
            lastAssistantMsg._rawText = (lastAssistantMsg._rawText || '') + chunk;
            lastAssistantMsg.innerHTML = renderMarkdown(lastAssistantMsg._rawText);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function addToolCall(name, params) {
            if (!lastAssistantMsg) {
                clearEmptyState();
                lastAssistantMsg = document.createElement('div');
                lastAssistantMsg.className = 'message assistant';
                messagesEl.appendChild(lastAssistantMsg);
            }
            var span = document.createElement('span');
            span.className = 'tool-call';
            span.textContent = getToolLabel(name, params || {});
            lastAssistantMsg.appendChild(span);
        }

        function getToolLabel(name, params) {
            params = params || {};
            switch (name) {
                case 'Read':
                    return '\\u{1F4D6} 读取文件: ' + (params.file_path || '未知文件');
                case 'Write':
                    return '\\u270F\\uFE0F 写入文件: ' + (params.file_path || '未知文件');
                case 'Edit':
                    return '\\u270F\\uFE0F 编辑文件: ' + (params.file_path || '未知文件');
                case 'Bash':
                    return '\\u26A1 执行命令: ' + (params.command || '未知命令');
                case 'Glob':
                    return '\\u{1F50D} 查找文件: ' + (params.pattern || '');
                case 'Grep':
                    return '\\u{1F50E} 搜索内容: ' + (params.pattern || '');
                case 'WebFetch':
                    return '\\u{1F310} 获取网页: ' + (params.url || '');
                case 'WebSearch':
                    return '\\u{1F50D} 搜索网络: ' + (params.query || '');
                case 'Agent':
                    return '\\u{1F916} 委派子代理: ' + (params.description || '');
                default:
                    return '\\u{1F527} ' + name;
            }
        }

        function showApproval(approvalId, tool) {
            if (!lastAssistantMsg) {
                clearEmptyState();
                lastAssistantMsg = document.createElement('div');
                lastAssistantMsg.className = 'message assistant';
                messagesEl.appendChild(lastAssistantMsg);
            }
            var div = document.createElement('div');
            div.className = 'approval-block';
            div.id = 'approval-' + approvalId;
            var infoText = getToolLabel(tool.name, tool.input || {});
            var html = '<div class="approval-info">' + infoText + '</div>';
            // Write/Edit/Bash 展示内容预览
            if ((tool.name === 'Write' || tool.name === 'Edit') && tool.input) {
                var content = tool.input.content || tool.input.new_string || '';
                var preview = String(content).substring(0, 500);
                if (preview) html += '<pre class="approval-content-preview">' + escHtml(preview) + '</pre>';
            }
            if (tool.name === 'Bash' && tool.input && tool.input.command) {
                html += '<pre class="approval-content-preview">' + escHtml(String(tool.input.command)) + '</pre>';
            }
            html += '<div class="approval-buttons">' +
                '<button class="approval-accept">\\u2713 同意</button>' +
                '<button class="approval-reject">\\u2717 拒绝</button>' +
                '</div>';
            div.innerHTML = html;
            lastAssistantMsg.appendChild(div);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            div.querySelector('.approval-accept').addEventListener('click', function() {
                cleanupApproval(approvalId, true);
            });
            div.querySelector('.approval-reject').addEventListener('click', function() {
                cleanupApproval(approvalId, false);
            });
        }

        function cleanupApproval(approvalId, approved) {
            var block = document.getElementById('approval-' + approvalId);
            if (block) {
                var buttons = block.querySelector('.approval-buttons');
                if (buttons) {
                    buttons.innerHTML = '<span class="approval-result ' + (approved ? 'accepted' : 'rejected') + '">' + (approved ? '\\u2705 已同意' : '\\u274C 已拒绝') + '</span>';
                }
                // 禁用所有按钮防止二次点击
                var allBtns = block.querySelectorAll('button');
                allBtns.forEach(function(btn) { btn.disabled = true; });
            }
            vscode.postMessage({ type: 'approvalResponse', approvalId: approvalId, approved: approved });
        }

        function addError(content) {
            if (!lastAssistantMsg) {
                clearEmptyState();
                lastAssistantMsg = document.createElement('div');
                lastAssistantMsg.className = 'message assistant';
                messagesEl.appendChild(lastAssistantMsg);
            }
            var span = document.createElement('div');
            span.className = 'error-block';
            span.textContent = content;
            lastAssistantMsg.appendChild(span);
        }

        function setProcessing(active) {
            isProcessing = active;
            loadingEl.className = 'loading-indicator' + (active ? ' active' : '');
            sendBtn.disabled = active;
            textarea.disabled = active;
        }

        function send() {
            var text = textarea.value.trim();
            if (!text || isProcessing) return;
            vscode.postMessage({ type: 'userInput', content: text });
            addMessage('user', text);
            textarea.value = '';
            lastAssistantMsg = null;
        }

        // ─── 全局函数供 onclick 调用 ───
        window.copyCode = function(btn) {
            var wrapper = btn.closest('.code-block-wrapper');
            var code = wrapper.querySelector('code').textContent;
            vscode.postMessage({ type: 'copyCode', code: code });
        };
        window.acceptDiff = function() {
            vscode.postMessage({ type: 'applyEdit', filePath: '', oldText: '', newText: '' });
        };

        // ─── 事件监听 ───
        textarea.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
        sendBtn.addEventListener('click', send);

        window.addEventListener('message', function(e) {
            var data = e.data;
            switch (data.type) {
                case 'newMessage':
                    addMessage(data.message.role, data.message.content);
                    break;
                case 'appendText':
                    appendText(data.chunk);
                    break;
                case 'history':
                    data.messages.forEach(function(m) { addMessage(m.role, m.content); });
                    break;
                case 'clearChat':
                    messagesEl.innerHTML = '<div class="empty-state"><div>对话已清空</div></div>';
                    lastAssistantMsg = null;
                    break;
                case 'toolCall':
                    addToolCall(data.name, data.params);
                    break;
                case 'approvalRequest':
                    showApproval(data.approvalId, data.tool);
                    break;
                case 'error':
                    addError(data.content);
                    break;
                case 'processing':
                    setProcessing(data.active);
                    break;
                case 'finalize':
                    if (lastAssistantMsg) {
                        if (lastAssistantMsg._rawText) {
                            lastAssistantMsg.innerHTML = renderMarkdown(lastAssistantMsg._rawText);
                        }
                    } else {
                        // 流式输出未产生任何文本（如纯工具调用后无输出），
                        // 此时创建一个空消息，避免后续 addError 等信息无处附加
                        clearEmptyState();
                        lastAssistantMsg = document.createElement('div');
                        lastAssistantMsg.className = 'message assistant';
                        messagesEl.appendChild(lastAssistantMsg);
                    }
                    break;
                case 'showDiff':
                    clearEmptyState();
                    var diffDiv = document.createElement('div');
                    diffDiv.className = 'message assistant';
                    diffDiv.innerHTML = renderDiff(data.title, data.original, data.modified);
                    messagesEl.appendChild(diffDiv);
                    messagesEl.scrollTop = messagesEl.scrollHeight;
                    lastAssistantMsg = diffDiv;
                    break;
            }
        });

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
