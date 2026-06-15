// ─── packages/core/src/context/monitor.ts ───
// 上下文窗口监控器 — Token 使用率追踪 + 阈值告警 + 自动压缩建议
//
// 解决问题:
//   1. LLM 上下文窗口有限（如 200K tokens），需要实时监控使用率防止溢出
//   2. 在接近窗口上限时主动告警，避免 API 调用失败
//   3. 提供压缩建议，帮助用户决策何时触发 compact
//
// 阈值设计（为什么是这个比例）:
//   - WARN (70%): 还有空间但需要用户注意，可在此时主动压缩旧消息
//   - CRITICAL (85%): 接近窗口上限，强烈建议立即压缩
//   - DANGER (95%): 随时可能超限导致 API 错误，必须压缩

import type { TokenUsage } from "../types/messages";

// ─── 监控配置 ───

export interface ContextMonitorConfig {
    /** 上下文窗口总大小（token 数），默认 200000 */
    contextWindow: number;
    /** 警告阈值（占窗口的比例），默认 0.70 */
    warnThreshold: number;
    /** 严重阈值，默认 0.85 */
    criticalThreshold: number;
    /** 危险阈值，默认 0.95 */
    dangerThreshold: number;
    /** 是否启用自动监控，默认 true */
    enabled: boolean;
}

export const DEFAULT_MONITOR_CONFIG: ContextMonitorConfig = {
    contextWindow: 200_000,
    warnThreshold: 0.70,
    criticalThreshold: 0.85,
    dangerThreshold: 0.95,
    enabled: true,
};

// ─── 监控状态 ───

export type ContextHealth = "healthy" | "warning" | "critical" | "danger";

export interface ContextStatus {
    /** 当前健康状态 */
    health: ContextHealth;
    /** 当前总 token 使用量 */
    usedTokens: number;
    /** 上下文窗口总容量 */
    totalTokens: number;
    /** 使用率百分比 (0-100) */
    usagePercent: number;
    /** 剩余可用 token */
    remainingTokens: number;
    /** 输入 token 数 */
    inputTokens: number;
    /** 输出 token 数 */
    outputTokens: number;
    /** 是否建议压缩 */
    shouldCompact: boolean;
    /** 距警告阈值还差多少 token */
    tokensUntilWarn: number;
    /** 距危险阈值还差多少 token */
    tokensUntilDanger: number;
}

/**
 * ContextMonitor — 上下文窗口实时监控器
 *
 * 职责:
 *   1. 追踪 token 使用量并与窗口大小比较
 *   2. 按阈值分级告警
 *   3. 生成人类可读的状态信息
 */
export class ContextMonitor {
    private config: ContextMonitorConfig;
    private currentInputTokens: number = 0;
    private currentOutputTokens: number = 0;

    constructor(config?: Partial<ContextMonitorConfig>) {
        this.config = { ...DEFAULT_MONITOR_CONFIG, ...config };
    }

    /**
     * 更新 token 使用量
     *
     * @param usage — 当前累计的 token 用量
     */
    update(usage: TokenUsage): void {
        this.currentInputTokens = usage.inputTokens;
        this.currentOutputTokens = usage.outputTokens;
    }

    /**
     * 获取当前上下文健康状态
     */
    getHealth(): ContextHealth {
        if (!this.config.enabled) return "healthy";

        const usagePercent = this.getUsagePercent();
        if (usagePercent >= this.config.dangerThreshold * 100) return "danger";
        if (usagePercent >= this.config.criticalThreshold * 100) return "critical";
        if (usagePercent >= this.config.warnThreshold * 100) return "warning";
        return "healthy";
    }

    /**
     * 获取使用率百分比
     */
    getUsagePercent(): number {
        const total = this.currentInputTokens + this.currentOutputTokens;
        if (this.config.contextWindow === 0) return 0;
        return Math.round((total / this.config.contextWindow) * 100);
    }

    /**
     * 获取完整状态快照
     */
    getStatus(): ContextStatus {
        const total = this.currentInputTokens + this.currentOutputTokens;
        const usedTokens = total;
        const totalTokens = this.config.contextWindow;
        const usagePercent = this.getUsagePercent();
        const remainingTokens = totalTokens - usedTokens;
        const health = this.getHealth();

        return {
            health,
            usedTokens,
            totalTokens,
            usagePercent,
            remainingTokens,
            inputTokens: this.currentInputTokens,
            outputTokens: this.currentOutputTokens,
            shouldCompact: health === "critical" || health === "danger",
            tokensUntilWarn: Math.max(0, Math.floor(totalTokens * this.config.warnThreshold) - usedTokens),
            tokensUntilDanger: Math.max(0, Math.floor(totalTokens * this.config.dangerThreshold) - usedTokens),
        };
    }

    /**
     * 获取告警信息（如果需要告警）
     * 解决问题: 生成人类可读的告警文本，供 CLI 展示
     *
     * @returns 告警信息字符串，健康状态返回 null
     */
    getAlert(): string | null {
        const status = this.getStatus();
        switch (status.health) {
            case "warning":
                return `上下文使用率 ${status.usagePercent}%，建议执行 /compact 释放空间`;
            case "critical":
                return `上下文使用率 ${status.usagePercent}%，强烈建议立即执行 /compact`;
            case "danger":
                return `上下文使用率 ${status.usagePercent}%，即将超限！请立即执行 /compact 或减少输入`;
            default:
                return null;
        }
    }

    /**
     * 获取状态栏文本（简洁格式）
     * 解决问题: 供 CLI 状态栏展示，一行内显示关键指标
     */
    getStatusBarText(): string {
        const status = this.getStatus();
        const healthIcon = {
            healthy: "✓",
            warning: "⚠",
            critical: "🔴",
            danger: "💀",
        }[status.health];

        return `[${healthIcon} ${status.usagePercent}% | ${this.formatTokens(status.usedTokens)}/${this.formatTokens(status.totalTokens)}]`;
    }

    /**
     * 重置监控状态
     */
    reset(): void {
        this.currentInputTokens = 0;
        this.currentOutputTokens = 0;
    }

    /**
     * 更新上下文窗口大小（模型切换时）
     */
    setContextWindow(tokens: number): void {
        this.config.contextWindow = tokens;
    }

    private formatTokens(tokens: number): string {
        if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
        if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
        return tokens.toString();
    }
}
