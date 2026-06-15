// ─── packages/vscode/src/language/completion.ts ───
// 内联补全 Provider — 实现 VS Code InlineCompletionItemProvider 接口，
// 在用户编写代码时光标位置提供 AI 驱动的代码补全建议（灰色幽灵文本）
// 解决问题：传统的基于规则的补全（如 IntelliSense）只能提供 API/变量名补全，
// 而 AI 内联补全可以给出完整的语句甚至多行代码段，显著提升编码效率。
//
// 核心设计：
//   1. 触发条件 — 光标在非空、非注释行时触发
//   2. 上下文构建 — 提取光标前 N 行代码作为 AI 补全的上下文
//   3. 代理模式 — 通过 VS Code 命令委托给 core 引擎处理实际 AI 调用，
//      实现 UI 层与 AI 引擎解耦
//   4. 启用控制 — 通过闭包引用外部 switch 变量，用户可随时开关补全

import * as vscode from "vscode";

// ─── InlineCompletionProvider ───
// 实现 VS Code InlineCompletionItemProvider 接口
// 当用户在编辑器中输入时，VS Code 自动调用 provideInlineCompletionItems

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    /** 补全开关状态（由外部 toggle 命令控制） */
    private enabled: boolean;

    /** 获取当前启用状态的函数引用，通过闭包绑定到 extension.ts 中的变量 */
    private _getEnabled: () => boolean;

    /**
     * @param enabled - 返回当前启用状态的函数（闭包引用外部变量，实现实时的状态感知）
     */
    constructor(enabled: () => boolean) {
        this.enabled = true;
        // 闭包绑定：不直接存储 boolean 值，而是存储函数引用
        // 这样每次检查时获取的是最新的状态值，无需手动同步
        this._getEnabled = enabled;
    }

    // ══════════════════════════════════════════════════════════════════
    // InlineCompletionItemProvider 接口实现
    // ══════════════════════════════════════════════════════════════════

    /**
     * VS Code 调用此方法获取内联补全建议
     *
     * 调用时机：用户在编辑器中输入暂停时（约 200ms 延迟）
     * VS Code 会在每次光标位置变化时调用此方法，频繁调用是正常的
     *
     * @param document - 当前编辑器文档对象
     * @param position - 光标位置
     * @param _context - 补全上下文（触发原因、当前已输入的补全等）
     * @param _token - 取消令牌，用户继续输入时 VS Code 会取消之前的请求
     * @returns 补全项数组（通常为 0 或 1 个元素）
     */
    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        _token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionItem[]> {
        // 补全功能已关闭，直接返回空数组
        if (!this._getEnabled()) return [];

        // ─── 语言过滤：只对支持的编程语言提供补全 ───
        // 目的：避免在 JSON、Markdown 等非代码文件中触发无意义的 AI 调用
        const language = document.languageId;
        const supportedLanguages = [
            "typescript", "javascript", "typescriptreact", "javascriptreact",
            "python", "go", "rust", "java", "kotlin", "swift",
            "c", "cpp", "csharp", "ruby", "php", "vue", "svelte",
        ];
        if (!supportedLanguages.includes(language)) return [];

        // ─── 光标上下文提取 ───
        // 获取当前行光标前的文本，判断是否需要触发补全
        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const trimmedPrefix = linePrefix.trim();

        // 跳过不应触发补全的场景：
        //   1. 空行（无上下文，AI 无法推断意图）
        //   2. 单行注释后（// 开头，补全注释内容意义不大）
        //   3. 块注释中（/* 开头，同上）
        if (!trimmedPrefix || trimmedPrefix.startsWith("//") || trimmedPrefix.startsWith("/*")) {
            return [];
        }

        // ─── 构建补全上下文 ───
        // 提取光标前 10 行代码作为 AI 的上下文窗口
        // 选择 10 行的原因：
        //   1. 足够理解当前代码的语义（函数定义、变量声明、控制流）
        //   2. 避免上下文过长导致 AI 响应延迟
        const precedingText = this.getPrecedingText(document, position, 10);

        try {
            // 调用后端 AI 补全（通过 VS Code 命令委托给 core 引擎处理）
            const completionText = await this.requestCompletion(
                document.fileName,
                language,
                precedingText,
                linePrefix,
                position,
            );

            // AI 未返回有效补全，静默返回空数组
            if (!completionText) return [];

            // 构造 VS Code 内联补全项
            // Range 设置为光标位置到光标位置（不替换任何已有文本）
            const item = new vscode.InlineCompletionItem(
                completionText,
                new vscode.Range(position, position),
            );
            // 绑定接受补全的命令，用户按 Tab 时触发
            item.command = {
                title: "接受 AI 补全",
                command: "editor.action.inlineSuggest.commit",
            };

            return [item];
        } catch {
            // 补全请求失败时静默返回空数组
            // 不抛出异常也不弹窗提示，因为补全失败不应打断用户的编码流程
            return [];
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // 私有方法
    // ══════════════════════════════════════════════════════════════════

    /**
     * 获取光标前的 N 行代码文本作为上下文
     * 从 (position.line - lines) 行开始到光标位置，构建上下文字符串
     * @param document - 当前文档对象
     * @param position - 光标位置
     * @param lines - 向前取多少行
     * @returns 光标前的代码文本片段
     */
    private getPrecedingText(document: vscode.TextDocument, position: vscode.Position, lines: number): string {
        const startLine = Math.max(0, position.line - lines); // 不超出文档开头
        const range = new vscode.Range(new vscode.Position(startLine, 0), position);
        return document.getText(range);
    }

    /**
     * 请求 AI 生成补全文本
     *
     * 通过 VS Code 命令系统委托给 core 引擎处理，实现 UI 层与 AI 引擎的解耦
     * 设计原因：直接调用 AI API 会将 UI 层与 AI 引擎紧耦合，通过命令代理可以：
     *   1. 替换 AI 引擎时无需修改补全 Provider 代码
     *   2. 命令处理器可以统一管理速率限制、缓存、错误重试
     *   3. 便于单元测试（可以 Mock 命令返回值）
     *
     * @param filePath - 当前文件路径
     * @param language - 编程语言 ID
     * @param precedingText - 光标前 10 行代码上下文
     * @param linePrefix - 当前行光标前的文本
     * @param position - 光标位置
     * @returns AI 生成的补全文本，失败时返回 null
     */
    private async requestCompletion(
        filePath: string,
        language: string,
        precedingText: string,
        linePrefix: string,
        position: vscode.Position,
    ): Promise<string | null> {
        try {
            // 通过命令委托给注册的处理器，实际 AI 调用由 @y-claude-code/core 完成
            const result = await vscode.commands.executeCommand(
                "y-claude-code.provideCompletion",
                { filePath, language, precedingText, linePrefix, line: position.line, character: position.character },
            );
            return (result as string) ?? null;
        } catch {
            // 命令未注册或执行失败，返回 null（静默降级，不打断用户工作流）
            return null;
        }
    }
}
