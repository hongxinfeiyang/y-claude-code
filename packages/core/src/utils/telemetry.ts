// ─── packages/core/src/utils/telemetry.ts ───
// 遥测模块 — 匿名使用数据收集，帮助改进产品
// 解决问题：在不侵犯用户隐私的前提下收集使用数据，支持用户完全关闭
//
// 隐私原则：
//   1. 全匿名：不收集个人身份信息（PII）、文件内容、代码片段
//   2. 可关闭：用户可通过配置或环境变量完全关闭遥测
//   3. 透明：收集的所有数据字段均在此文件中明确定义
//   4. 最小化：只收集对产品改进有实际价值的数据
//   5. 本地优先：数据先在本地聚合，用户可随时查看
//
// 收集的数据类型：
//   - 会话元数据：时长、消息数、工具调用次数（不含具体内容）
//   - 使用模式：最常用的工具、命令类型
//   - 环境信息：OS 类型、Node 版本（不含具体路径、用户名）
//   - 错误统计：错误类型和频率（不含具体错误内容）
//   - 功能使用：plan mode、thinking、worktree、hooks 等功能的开启率

import { randomUUID } from "node:crypto";
import { platform, arch } from "node:os";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * 遥测事件类型
 */
export type TelemetryEventType =
    | "session_start"
    | "session_end"
    | "tool_call"
    | "llm_call"
    | "error"
    | "feature_use"
    | "command_use";

/**
 * 遥测事件
 */
export interface TelemetryEvent {
    /** 事件类型 */
    type: TelemetryEventType;
    /** 事件时间戳 */
    timestamp: number;
    /** 匿名安装 ID（随机生成，不关联任何个人信息） */
    installId: string;
    /** 匿名会话 ID */
    sessionId: string;
    /** 事件数据（仅包含非敏感字段） */
    data: Record<string, string | number | boolean>;
}

/**
 * 遥测配置
 */
export interface TelemetryConfig {
    /** 是否启用遥测（默认 true） */
    enabled: boolean;
    /** 遥测数据存储目录 */
    dataDir: string;
    /** 数据上报端点（可选，不上报时仅本地存储） */
    reportEndpoint?: string;
    /** 本地数据最大保留天数 */
    retentionDays: number;
    /** 匿名安装 ID */
    installId: string;
}

/**
 * 遥测管理器
 *
 * 【是什么】
 * 匿名使用数据收集系统。默认将遥测数据存储在本地文件中，
 * 用户可通过配置或环境变量随时关闭。
 *
 * 【解决什么问题】
 * 1. 了解功能使用情况，指导产品迭代方向
 * 2. 发现高频错误，提前修复
 * 3. 统计用户环境分布，优化兼容性
 */
export class TelemetryManager {
    private config: TelemetryConfig;
    private eventBuffer: TelemetryEvent[] = [];
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private installId: string;

    constructor(config?: Partial<TelemetryConfig>) {
        this.installId = config?.installId ?? this.loadOrCreateInstallId();
        this.config = {
            enabled: true,
            dataDir: join(homedir(), ".y-claude-code", "telemetry"),
            retentionDays: 30,
            installId: this.installId,
            ...config,
        };
    }

    /**
     * 加载或创建匿名安装 ID
     * 解决问题：确保每个安装有唯一标识，但不关联任何个人信息
     */
    private loadOrCreateInstallId(): string {
        try {
            // 尝试从环境变量读取
            if (process.env.Y_CLAUDE_CODE_INSTALL_ID) {
                return process.env.Y_CLAUDE_CODE_INSTALL_ID;
            }
        } catch {
            // 环境变量不可用则生成新的
        }
        return randomUUID();
    }

    /**
     * 检查遥测是否被用户关闭
     */
    isEnabled(): boolean {
        // 环境变量优先
        if (process.env.Y_CLAUDE_CODE_TELEMETRY === "0" ||
            process.env.Y_CLAUDE_CODE_TELEMETRY === "false") {
            return false;
        }
        return this.config.enabled;
    }

    /**
     * 记录事件（异步，不阻塞主流程）
     *
     * @param type 事件类型
     * @param sessionId 匿名会话 ID
     * @param data 事件数据（仅非敏感字段）
     */
    track(type: TelemetryEventType, sessionId: string, data: Record<string, string | number | boolean> = {}): void {
        if (!this.isEnabled()) return;

        const event: TelemetryEvent = {
            type,
            timestamp: Date.now(),
            installId: this.installId,
            sessionId,
            data,
        };

        this.eventBuffer.push(event);

        // 缓冲区达到 10 条或 30 秒后自动刷新
        if (this.eventBuffer.length >= 10) {
            this.flush().catch(() => { /* 静默失败 */ });
        }
    }

    /**
     * 会话开始事件
     */
    trackSessionStart(sessionId: string, data: { model: string; provider: string }): void {
        this.track("session_start", sessionId, {
            model: data.model,
            provider: data.provider,
            platform: platform(),
            arch: arch(),
            nodeVersion: process.version,
        });
    }

    /**
     * 会话结束事件
     */
    trackSessionEnd(sessionId: string, data: {
        durationMs: number;
        messageCount: number;
        toolCallCount: number;
        errorCount: number;
    }): void {
        this.track("session_end", sessionId, {
            durationMs: data.durationMs,
            messageCount: data.messageCount,
            toolCallCount: data.toolCallCount,
            errorCount: data.errorCount,
        });
    }

    /**
     * 工具调用事件
     */
    trackToolCall(sessionId: string, toolName: string, isError: boolean): void {
        this.track("tool_call", sessionId, {
            tool: toolName,
            error: isError ? 1 : 0,
        });
    }

    /**
     * LLM 调用事件
     */
    trackLLMCall(sessionId: string, data: {
        model: string;
        provider: string;
        inputTokens: number;
        outputTokens: number;
        durationMs: number;
    }): void {
        this.track("llm_call", sessionId, {
            model: data.model,
            provider: data.provider,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            durationMs: data.durationMs,
        });
    }

    /**
     * 错误事件
     */
    trackError(sessionId: string, category: string, recovered: boolean): void {
        this.track("error", sessionId, {
            category,
            recovered: recovered ? 1 : 0,
        });
    }

    /**
     * 功能使用事件
     */
    trackFeatureUse(sessionId: string, feature: string): void {
        this.track("feature_use", sessionId, { feature });
    }

    /**
     * 命令使用事件
     */
    trackCommandUse(sessionId: string, command: string): void {
        this.track("command_use", sessionId, { command });
    }

    /**
     * 刷新缓冲区到本地文件
     */
    async flush(): Promise<void> {
        if (this.eventBuffer.length === 0) return;

        const events = this.eventBuffer.splice(0);
        const today = new Date().toISOString().slice(0, 10);
        const logFile = join(this.config.dataDir, `telemetry-${today}.jsonl`);

        try {
            await mkdir(this.config.dataDir, { recursive: true });
            const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
            await writeFile(logFile, lines, { flag: "a" });
        } catch {
            // 写入失败：丢弃这批事件，避免内存泄漏
        }
    }

    /**
     * 启动定时刷新
     */
    startFlushInterval(intervalMs = 30_000): void {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => {
            this.flush().catch(() => {});
        }, intervalMs);
    }

    /**
     * 停止定时刷新并执行最后一次 flush
     */
    async stop(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
    }

    /**
     * 清理过期数据
     */
    async cleanup(): Promise<void> {
        const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
        try {
            const { readdir, unlink } = await import("node:fs/promises");
            const files = await readdir(this.config.dataDir).catch(() => [] as string[]);
            for (const file of files) {
                if (!file.startsWith("telemetry-") || !file.endsWith(".jsonl")) continue;
                const dateStr = file.slice("telemetry-".length, -".jsonl".length);
                const fileDate = new Date(dateStr).getTime();
                if (fileDate < cutoff) {
                    await unlink(join(this.config.dataDir, file)).catch(() => {});
                }
            }
        } catch {
            // 清理失败不影响正常使用
        }
    }

    /**
     * 获取本地遥测统计摘要（供 /stats 命令使用）
     */
    async getLocalStats(): Promise<Record<string, unknown>> {
        try {
            const files = await (await import("node:fs/promises")).readdir(this.config.dataDir).catch(() => [] as string[]);
            const recentFiles = files
                .filter((f) => f.startsWith("telemetry-") && f.endsWith(".jsonl"))
                .sort()
                .slice(-7); // 最近 7 天

            let totalEvents = 0;
            const eventCounts: Record<string, number> = {};
            const toolCounts: Record<string, number> = {};

            for (const file of recentFiles) {
                const content = await readFile(join(this.config.dataDir, file), "utf-8").catch(() => "");
                for (const line of content.split("\n").filter(Boolean)) {
                    try {
                        const event = JSON.parse(line) as TelemetryEvent;
                        totalEvents++;
                        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
                        if (event.type === "tool_call" && event.data.tool) {
                            const toolName = String(event.data.tool);
                            toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
                        }
                    } catch {
                        // 跳过无效行
                    }
                }
            }

            return { totalEvents, eventCounts, toolCounts, daysAnalyzed: recentFiles.length };
        } catch {
            return { error: "无法读取遥测数据" };
        }
    }
}
