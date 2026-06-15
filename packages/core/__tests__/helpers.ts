// ─── packages/core/__tests__/helpers.ts ───
// 测试辅助工具 — Mock 上下文、Provider、沙箱等

import { vi } from "vitest";
import type { ToolContext } from "../src/types/tools";
import type { LLMProvider } from "../src/types/agent";
import type { PermissionManager } from "../src/permission/manager";
import type { ResponseChunk, ToolResult } from "../src/types/messages";

/**
 * 创建模拟的 ToolContext，用于工具单测
 * 所有字段都有安全的默认值
 */
export function createMockToolContext(overrides?: Partial<ToolContext>): ToolContext {
    return {
        workingDirectory: "/project",
        sessionId: "test-session",
        appendMessage: vi.fn().mockResolvedValue(undefined),
        sandbox: undefined,
        logger: undefined,
        signal: new AbortController().signal,
        ...overrides,
    };
}

/**
 * 创建模拟的 LLMProvider，返回预设的 chunk 序列
 * 用于 AgentLoop 集成测试，避免真实 API 调用
 */
export function createMockProvider(
    chunks: ResponseChunk[],
    contextWindow = 200_000,
): LLMProvider {
    return {
        name: "mock",
        async *chat() {
            for (const chunk of chunks) yield chunk;
        },
        contextWindow: () => contextWindow,
        countTokens: vi.fn().mockResolvedValue(100),
        supportsFeature: () => true,
    };
}

/**
 * 创建模拟的 PermissionManager
 * 默认所有操作都允许
 */
export function createMockPermissionManager(
    defaultDecision = true,
): PermissionManager {
    return {
        check: vi.fn().mockResolvedValue(defaultDecision),
        remember: vi.fn(),
        loadRules: vi.fn(),
        setPromptCallback: vi.fn(),
        clearSessionCache: vi.fn(),
        persistRules: vi.fn().mockResolvedValue(undefined),
        getPermissionLevel: () => "all",
    } as unknown as PermissionManager;
}

/**
 * 为文件系统操作创建临时文件
 * 返回清理函数
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export async function createTempFile(
    content: string,
    filename?: string,
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "y-claude-code-test-"));
    const filePath = path.join(dir, filename ?? "test.txt");
    await fs.writeFile(filePath, content, "utf-8");
    return {
        filePath,
        cleanup: async () => { await fs.rm(dir, { recursive: true, force: true }); },
    };
}
