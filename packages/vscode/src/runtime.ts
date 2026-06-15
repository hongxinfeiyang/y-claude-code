// ─── packages/vscode/src/runtime.ts ───
// ExtensionRuntime — VS Code 扩展运行时单例，缓存核心引擎实例
// 解决问题：每次 processMessage / provideCompletion 调用都重复创建 ConfigLoader、
// LLMProvider、ToolRegistry 等对象，浪费文件 I/O 和内存分配。
// 通过单例缓存这些实例，跨命令调用共享，提升响应速度。

import * as vscode from "vscode";
import { ChatPanelProvider } from "./webview/panel";
import { InlineCompletionProvider } from "./language/completion";
import * as core from "@y-claude-code/core";
import type {
    AgentLoop, AgentConfig, AgentLoopContext, ToolRegistry,
    ConfigLoader, LLMProvider, Logger, PermissionManager,
} from "@y-claude-code/core";

// ─── ExtensionRuntime 单例 ───
// 包装 VS Code 扩展的完整生命周期，提供对核心引擎的缓存访问
export class ExtensionRuntime {
    private static _instance?: ExtensionRuntime;

    // ─── UI 组件（每个扩展上下文创建一次）───
    private _chatProvider?: ChatPanelProvider;
    private _completionProvider?: InlineCompletionProvider;
    private _completionEnabled = true;
    private _statusBarItem?: vscode.StatusBarItem;

    // ─── 核心引擎缓存（跨命令调用共享）───
    private _configLoader?: ConfigLoader;
    private _toolRegistry?: ToolRegistry;
    private _provider?: LLMProvider;
    private _loadedConfig: Record<string, unknown> | null = null;
    private _configHash = "";
    private _agentLoop?: AgentLoop;
    private _sessionId = "";

    // ─── 上下文 ───
    private _extensionUri?: vscode.Uri;
    private _workingDir = "";
    private _skillSection = "";

    private constructor() {}

    /** 获取单例实例 */
    static getInstance(): ExtensionRuntime {
        if (!ExtensionRuntime._instance) {
            ExtensionRuntime._instance = new ExtensionRuntime();
        }
        return ExtensionRuntime._instance;
    }

    /** 重置单例（仅用于测试） */
    static resetInstance(): void {
        ExtensionRuntime._instance = undefined;
    }

    /** 重置 AgentLoop（清空对话时调用） */
    resetAgentLoop(): void {
        this._agentLoop = undefined;
        this._sessionId = "";
    }

    // ─── 公开访问器 ───

    get chatProvider(): ChatPanelProvider | undefined { return this._chatProvider; }
    get completionEnabled(): boolean { return this._completionEnabled; }
    get workingDir(): string { return this._workingDir; }

    // ══════════════════════════════════════════════════════════════════
    // 生命周期
    // ══════════════════════════════════════════════════════════════════

    /** 激活扩展 — 注册所有命令、视图、状态栏 */
    async activate(context: vscode.ExtensionContext): Promise<void> {
        console.log("[y-claude-code] 正在激活扩展...");
        this._extensionUri = context.extensionUri;
        this._workingDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        console.log("[y-claude-code] 工作目录:", this._workingDir);

        // 预加载 core 模块（异步 import 只执行一次，后续 import 走模块缓存）
        this._configLoader = new core.ConfigLoader();
        this._toolRegistry = core.ToolRegistry.createDefault();

        // 加载技能（项目级 + 内置）
        try {
            const skillLoader = new core.SkillLoader();
            await skillLoader.loadAll(this._workingDir);
            this._skillSection = skillLoader.buildSystemPromptSection();
        } catch {
            this._skillSection = "";
        }

        // ─── 1. 聊天面板 ───
        this._chatProvider = new ChatPanelProvider(context.extensionUri, context);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider("y-claude-code.chat", this._chatProvider, {
                webviewOptions: { retainContextWhenHidden: true },
            }),
        );

        // ─── 2. 打开聊天 ───
        context.subscriptions.push(
            vscode.commands.registerCommand("y-claude-code.openChat", () => {
                vscode.commands.executeCommand("workbench.view.extension.y-claude-code");
            }),
        );

        // ─── 2.5. 清空对话（重置 AgentLoop 保持会话连续性）───
        context.subscriptions.push(
            vscode.commands.registerCommand("y-claude-code.clearChat", () => {
                this.resetAgentLoop();
            }),
        );

        // ─── 3. 切换内联补全 ───
        context.subscriptions.push(
            vscode.commands.registerCommand("y-claude-code.toggleCompletion", () => {
                this._completionEnabled = !this._completionEnabled;
                vscode.window.showInformationMessage(
                    `内联补全: ${this._completionEnabled ? "已开启" : "已关闭"}`,
                );
            }),
        );

        // ─── 4. 解释选中代码 ───
        context.subscriptions.push(
            vscode.commands.registerCommand("y-claude-code.explainSelection", async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) return;
                const selection = editor.document.getText(editor.selection);
                if (!selection) {
                    vscode.window.showWarningMessage("请先选中要解释的代码");
                    return;
                }
                this._chatProvider?.sendMessage(
                    `请解释以下代码:\n\`\`\`\n${selection}\n\`\`\``,
                );
            }),
        );

        // ─── 5. 审查文件 ───
        context.subscriptions.push(
            vscode.commands.registerCommand("y-claude-code.reviewFile", async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) return;
                const filePath = editor.document.uri.fsPath;
                this._chatProvider?.sendMessage(`请审查文件 ${filePath}`);
            }),
        );

        // ─── 6. processMessage — AI 对话核心 ───
        context.subscriptions.push(
            vscode.commands.registerCommand(
                "y-claude-code.processMessage",
                async (userMessage: string) => this._handleProcessMessage(userMessage),
            ),
        );

        // ─── 7. provideCompletion — 内联补全后端 ───
        context.subscriptions.push(
            vscode.commands.registerCommand(
                "y-claude-code.provideCompletion",
                async (params: {
                    filePath: string; language: string; precedingText: string;
                    linePrefix: string; line: number; character: number;
                }): Promise<string | null> => this._handleProvideCompletion(params),
            ),
        );

        // ─── 8. applyEdit — 应用 AI 编辑 ───
        context.subscriptions.push(
            vscode.commands.registerCommand(
                "y-claude-code.applyEdit",
                async (filePath: string, oldText: string, newText: string) => {
                    const uri = vscode.Uri.file(filePath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const edit = new vscode.WorkspaceEdit();
                    const fullText = doc.getText();
                    const idx = fullText.indexOf(oldText);
                    if (idx === -1) {
                        vscode.window.showErrorMessage("未找到匹配文本，无法应用编辑");
                        return;
                    }
                    const range = new vscode.Range(
                        doc.positionAt(idx),
                        doc.positionAt(idx + oldText.length),
                    );
                    edit.replace(uri, range, newText);
                    await vscode.workspace.applyEdit(edit);
                    vscode.window.showInformationMessage("编辑已应用");
                },
            ),
        );

        // ─── 9. showDiff — 显示差异 ───
        context.subscriptions.push(
            vscode.commands.registerCommand(
                "y-claude-code.showDiff",
                async (title: string, _filePath: string, original: string, modified: string) => {
                    const origDoc = await vscode.workspace.openTextDocument({
                        content: original, language: "plaintext",
                    });
                    const modDoc = await vscode.workspace.openTextDocument({
                        content: modified, language: "plaintext",
                    });
                    await vscode.commands.executeCommand(
                        "vscode.diff", origDoc.uri, modDoc.uri, `${title} — 原始 ↔ 修改`,
                    );
                },
            ),
        );

        // ─── 10. 内联补全 Provider ───
        this._completionProvider = new InlineCompletionProvider(
            () => this._completionEnabled,
        );
        context.subscriptions.push(
            vscode.languages.registerInlineCompletionItemProvider(
                { pattern: "**" }, this._completionProvider,
            ),
        );

        // ─── 11. 状态栏 ───
        this._statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right, 100,
        );
        this._statusBarItem.text = "$(hubot) y-claude-code";
        this._statusBarItem.tooltip = "y-claude-code — AI 编程助手";
        this._statusBarItem.command = "y-claude-code.openChat";
        this._statusBarItem.show();
        context.subscriptions.push(this._statusBarItem);

        console.log("[y-claude-code] 扩展激活完成，已注册所有命令和视图");
        vscode.window.showInformationMessage("y-claude-code 已激活");
    }

    /** 停用扩展 — 清理缓存 */
    deactivate(): void {
        this._configLoader = undefined;
        this._toolRegistry = undefined;
        this._provider = undefined;
        this._loadedConfig = null;
        this._chatProvider = undefined;
        this._completionProvider = undefined;
    }

    // ══════════════════════════════════════════════════════════════════
    // 命令处理（使用缓存的引擎实例）
    // ══════════════════════════════════════════════════════════════════

    /** processMessage 命令处理 — AI 对话核心 */
    private async _handleProcessMessage(userMessage: string): Promise<void> {
        const chatProvider = this._chatProvider;
        if (!chatProvider) {
            console.error("[y-claude-code] _handleProcessMessage: chatProvider 未初始化");
            return;
        }

        console.log("[y-claude-code] _handleProcessMessage 开始, 消息:", userMessage.substring(0, 100));
        chatProvider.setProcessing(true);

        try {
            console.log("[y-claude-code] 正在加载配置...");
            const config = await this._getOrRefreshConfig();
            console.log("[y-claude-code] 配置已加载, provider:", config.provider, "model:", config.model);

            console.log("[y-claude-code] 正在创建 LLM Provider...");
            const provider = await this._getOrCreateProvider(config);
            console.log("[y-claude-code] LLM Provider 已创建");
            const tools = this._toolRegistry!.listAll();

            const systemPrompt = await core.buildSystemPrompt({
                env: { workingDir: this._workingDir },
                skillSection: this._skillSection,
            });

            const agentConfig: AgentConfig = {
                model: config.model as string,
                provider,
                maxToolRounds: config.maxToolRounds as number,
                maxTokensPerTurn: config.maxTokensPerTurn as number,
                systemPrompt,
                tools,
                thinkingEnabled: config.thinkingEnabled as boolean,
                thinkingTokens: config.thinkingTokens as number,
                planningEnforcement: "soft",
            };

            // 复用 AgentLoop 实例以保持会话连续性
            if (!this._agentLoop) {
                this._agentLoop = new core.AgentLoop();
                this._sessionId = `vscode-${Date.now()}`;
            }

            const loop: AgentLoop = this._agentLoop;
            const permissionManager: PermissionManager = new core.PermissionManager(
                (config.permissions as Record<string, unknown>)?.defaultMode as "ask" | "allow" | "deny" | undefined,
            );

            // 注入 webview 审批回调 — permissionManager 需要用户确认时通过 webview 弹出同意/拒绝按钮
            permissionManager.setPromptCallback(async (toolUse) => {
                return chatProvider.showApprovalRequest(toolUse);
            });
            const logger: Logger = new core.Logger({ level: "info" });

            const loopCtx: AgentLoopContext = {
                permissionManager: permissionManager as AgentLoopContext["permissionManager"],
                logger: logger as AgentLoopContext["logger"],
                sessionId: this._sessionId,
                workingDirectory: this._workingDir,
                appendMessage: async () => {},
            };

            const stream = loop.run(userMessage, agentConfig, loopCtx);

            for await (const event of stream) {
                switch (event.type) {
                    case "text":
                        chatProvider.appendToLastMessage(event.content);
                        break;
                    case "tool_call":
                        chatProvider.appendToolCall(event.tool.name, event.tool.input);
                        break;
                    case "error":
                        chatProvider.appendError(event.error.message);
                        break;
                    case "approval_request":
                        // promptCallback 已处理审批 UI 和阻塞等待，此处不重复渲染
                        break;
                }
            }

            chatProvider.finalizeMessage();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error("[y-claude-code] _handleProcessMessage 失败:", msg, error);
            // 诊断：dump 当前配置状态到错误消息中
            let diagInfo = "";
            try {
                const loadedConfig = this._loadedConfig;
                if (loadedConfig) {
                    const providers = loadedConfig.providers as Record<string, unknown> | undefined;
                    diagInfo = `\n\n【诊断】当前 provider: ${loadedConfig.provider}, model: ${loadedConfig.model}`;
                    diagInfo += `\nproviders keys: ${providers ? Object.keys(providers).join(", ") || "(空)" : "undefined"}`;
                    if (providers) {
                        for (const [k, v] of Object.entries(providers)) {
                            const pc = v as Record<string, unknown> | undefined;
                            diagInfo += `\n  ${k}: apiKey=${pc?.apiKey ? "***" + String(pc.apiKey).slice(-4) : "缺失"}, baseURL=${pc?.baseURL || "缺失"}`;
                        }
                    }
                } else {
                    diagInfo = "\n\n【诊断】_loadedConfig 为 null（配置未加载）";
                }
                diagInfo += `\n工作目录: ${this._workingDir}`;
            } catch (diagError) {
                diagInfo = `\n\n【诊断失败】${diagError}`;
            }
            chatProvider.appendError(`处理失败: ${msg}${diagInfo}`);
        } finally {
            chatProvider.setProcessing(false);
        }
    }

    /** provideCompletion 命令处理 — 内联补全 */
    private async _handleProvideCompletion(params: {
        filePath: string; language: string; precedingText: string;
        linePrefix: string; line: number; character: number;
    }): Promise<string | null> {
        // core is statically imported, always available

        try {
            const config = await this._getOrRefreshConfig();
            const provider = await this._getOrCreateProvider(config);

            const messages = [
                {
                    role: "system" as const,
                    content: `你是代码补全助手。根据上下文续写代码。只输出补全代码，不要解释。语言: ${params.language}`,
                },
                {
                    role: "user" as const,
                    content: `请补全以下代码:\n\`\`\`${params.language}\n${params.precedingText}\n\`\`\``,
                },
            ];

            const chunks: string[] = [];
            for await (const chunk of provider.chat(messages, {
                model: config.model as string,
                maxTokens: 256,
                temperature: 0.2,
            })) {
                if (chunk.type === "text") chunks.push(chunk.content);
            }
            return chunks.join("").trim() || null;
        } catch {
            return null;
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // 缓存管理
    // ══════════════════════════════════════════════════════════════════

    /** 获取配置（带缓存，VS Code 显式设置优先级高于配置文件） */
    private async _getOrRefreshConfig(): Promise<Record<string, unknown>> {
        const cfg = vscode.workspace.getConfiguration("y-claude-code");
        // 仅检测 VS Code 设置中显式变更的字段，避免 hash 噪声
        const settingsSnapshot: Record<string, unknown> = {};
        for (const key of ["model", "provider", "maxToolRounds", "maxTokensPerTurn", "thinkingEnabled", "thinkingTokens", "permissions", "apiKey", "baseURL"]) {
            const inspect = cfg.inspect(key);
            settingsSnapshot[key] = inspect?.globalValue ?? inspect?.workspaceValue ?? inspect?.workspaceFolderValue ?? null;
        }
        const newHash = JSON.stringify(settingsSnapshot);

        if (!this._loadedConfig || this._configHash !== newHash) {
            const config = await this._configLoader!.load(this._workingDir);
            // 仅当用户在 VS Code 设置中显式设置了值时，才覆盖配置文件中的值
            // （cfg.inspect().globalValue/workspaceValue 有值 = 用户设置过，否则为 package.json 默认值应忽略）
            for (const key of ["model", "provider", "maxToolRounds", "maxTokensPerTurn", "thinkingEnabled", "thinkingTokens", "permissions"] as const) {
                const explicit = settingsSnapshot[key];
                if (explicit !== null && explicit !== undefined) {
                    (config as Record<string, unknown>)[key] = explicit;
                }
            }
            // ─── VS Code 设置中的 apiKey / baseURL 注入到 providers ───
            // 解决问题: 用户通过 VS Code 设置界面配置了 apiKey 和 baseURL，
            //         但 providers 对象可能为空（如项目无 settings.local.json），
            //         需将这些设置注入到当前 provider 的配置中以使 createProvider 可用
            const cfg = config as unknown as Record<string, unknown>;
            const providerName = cfg.provider as string;
            if (providerName) {
                const providers = cfg.providers as Record<string, { apiKey?: string; baseURL?: string }> | undefined;
                const existing = providers?.[providerName] ?? {};
                const apiKey = settingsSnapshot["apiKey"] as string | null;
                const baseURL = settingsSnapshot["baseURL"] as string | null;
                if (apiKey || baseURL) {
                    const merged = { ...existing };
                    if (apiKey) merged.apiKey = apiKey;
                    if (baseURL) merged.baseURL = baseURL;
                    cfg.providers = {
                        ...providers,
                        [providerName]: merged,
                    };
                }
            }
            this._loadedConfig = config as unknown as Record<string, unknown>;
            this._configHash = newHash;
            console.log("[y-claude-code] 配置已合并, provider:", (this._loadedConfig as Record<string, unknown>).provider, "model:", (this._loadedConfig as Record<string, unknown>).model);
            console.log("[y-claude-code] config.providers keys:", Object.keys((this._loadedConfig as Record<string, unknown>).providers as Record<string, unknown> || {}));
            // 配置变更时使 Provider 缓存失效
            this._provider = undefined;
        }

        return this._loadedConfig;
    }

    /** 获取 LLMProvider（带缓存） */
    private async _getOrCreateProvider(
        config: Record<string, unknown>,
    ): Promise<LLMProvider> {
        if (!this._provider) {
            const providerName = (config.provider as string) || "anthropic";
            console.log("[y-claude-code] 创建 Provider, 名称:", providerName);
            console.log("[y-claude-code] config.providers keys:", Object.keys(config.providers as Record<string, unknown> || {}));
            console.log("[y-claude-code] config.providers[deepseek]:", (config.providers as Record<string, unknown>)?.["deepseek"] ? "存在" : "不存在");
            const providerConfig = {
                ...config,
                provider: providerName,
            };
            this._provider = core.createProvider(providerConfig);
        }
        return this._provider;
    }
}
