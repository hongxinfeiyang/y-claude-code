// ─── packages/vscode/src/extension.ts ───
// VS Code 插件入口 — 委托给 ExtensionRuntime 单例管理完整的生命周期
// 解决问题：原先 activate() 函数将所有逻辑内联，每次命令调用重复创建核心引擎实例。
// 现在通过 ExtensionRuntime 单例缓存 ConfigLoader、LLMProvider、ToolRegistry，
// 避免跨命令调用的重复 I/O 和对象分配。

import * as vscode from "vscode";
import { ExtensionRuntime } from "./runtime";

export function activate(context: vscode.ExtensionContext): Promise<void> {
    return ExtensionRuntime.getInstance().activate(context);
}

export function deactivate(): void {
    ExtensionRuntime.getInstance().deactivate();
}
