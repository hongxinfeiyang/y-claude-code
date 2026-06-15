// ─── packages/core/src/context/cache-manager.ts ───
// Prompt Cache 管理器 — 缓存断点自动标记 + 命中率统计 + TTL 感知
//
// 解决问题:
//   1. Anthropic Prompt Caching 可在多轮对话中复用 system prompt 和 tool 定义
//      大幅降低输入 Token 成本（缓存读取价格仅为写入的 10%）
//   2. 缓存有 5 分钟 TTL，需要跟踪缓存状态并在到期前续期
//   3. 提供命中率统计帮助评估缓存策略效果
//
// 工作原理:
//   - 在 API 请求中为可缓存的 content block 添加 cache_control: { type: "ephemeral" }
//   - Anthropic 服务器在首次遇到带此标记的 block 时写入缓存（cache_write）
//   - 后续请求中相同 block 命中缓存（cache_read），成本大幅降低
//   - 缓存 TTL 为 5 分钟，每次命中会刷新 TTL

import type { TokenUsage } from "../types/messages";
import type { Logger } from "../types/tools";

// ─── 缓存配置 ───

export interface CacheConfig {
    /** 是否启用缓存管理，默认 true */
    enabled: boolean;
    /** 缓存 TTL 毫秒数（Anthropic 为 5 分钟），默认 270000（4 分 30 秒，留 30 秒缓冲） */
    ttlMs: number;
    /** 是否在 system prompt 上标记缓存断点 */
    cacheSystemPrompt: boolean;
    /** 是否在 tool 定义上标记缓存断点 */
    cacheToolDefinitions: boolean;
    /** 是否在日志中输出缓存统计 */
    logCacheStats: boolean;
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
    enabled: true,
    ttlMs: 270_000, // 4 分 30 秒，比 Anthropic 的 5 分钟提前 30 秒刷新
    cacheSystemPrompt: true,
    cacheToolDefinitions: true,
    logCacheStats: false,
};

// ─── 缓存状态 ───

export interface CacheState {
    /** 缓存是否活跃（在 TTL 内） */
    active: boolean;
    /** 最近一次缓存创建时间 */
    lastCreatedAt: number;
    /** 最近一次缓存命中时间 */
    lastHitAt: number;
    /** 缓存创建次数（cache_write 次数） */
    creationCount: number;
    /** 缓存命中次数（cache_read 次数） */
    hitCount: number;
    /** TTL 剩余毫秒数 */
    remainingMs: number;
}

/**
 * CacheManager — Prompt Cache 生命周期管理器
 *
 * 职责:
 *   1. 跟踪缓存创建/命中时间，提供 TTL 感知
 *   2. 从 TokenUsage 中提取缓存统计信息
 *   3. 格式化缓存统计输出
 *   4. 为 content blocks 自动添加 cache_control 标记
 */
export class CacheManager {
    private config: CacheConfig;
    private logger: Logger;
    private lastCacheWriteTime: number = 0;
    private totalCacheWrites: number = 0;
    private totalCacheHits: number = 0;
    private totalCacheWriteTokens: number = 0;
    private totalCacheReadTokens: number = 0;

    constructor(config?: Partial<CacheConfig>, logger?: Logger) {
        this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
        this.logger = logger ?? {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
        } as Logger;
    }

    /**
     * 检查缓存是否在有效期内
     * 解决问题: 超过 TTL 后缓存失效，需要重新标记 cache_control 以触发缓存重建
     */
    isCacheActive(): boolean {
        if (!this.config.enabled) return false;
        if (this.lastCacheWriteTime === 0) return false;
        const elapsed = Date.now() - this.lastCacheWriteTime;
        return elapsed < this.config.ttlMs;
    }

    /**
     * 获取缓存剩余 TTL 毫秒数
     * 解决问题: 帮助决定是否需要主动刷新缓存（在 TTL 到期前重建）
     */
    getRemainingTTL(): number {
        if (!this.isCacheActive()) return 0;
        return Math.max(0, this.config.ttlMs - (Date.now() - this.lastCacheWriteTime));
    }

    /**
     * 从 LLM 响应中更新缓存统计
     *
     * @param usage — TokenUsage（包含 cacheCreationInputTokens 和 cacheReadInputTokens）
     *
     * 解决问题: 每次 LLM API 调用后，从 usage 中提取缓存相关的 token 统计并累积
     */
    updateFromUsage(usage: TokenUsage): void {
        if (!this.config.enabled) return;

        if (usage.cacheCreationInputTokens && usage.cacheCreationInputTokens > 0) {
            // 有新的缓存写入: 记录时间和累计
            this.lastCacheWriteTime = Date.now();
            this.totalCacheWrites++;
            this.totalCacheWriteTokens += usage.cacheCreationInputTokens;
        }

        if (usage.cacheReadInputTokens && usage.cacheReadInputTokens > 0) {
            // 缓存命中: 累计命中次数和 Token
            this.totalCacheHits++;
            this.totalCacheReadTokens += usage.cacheReadInputTokens;
        }
    }

    /**
     * 获取缓存命中率
     * 解决问题: 核心评估指标，帮助判断缓存策略是否有效
     *
     * 计算方式: 缓存读取 Token / (写入 Token + 读取 Token)
     */
    getHitRate(): number {
        const total = this.totalCacheWriteTokens + this.totalCacheReadTokens;
        if (total === 0) return 0;
        return Math.round((this.totalCacheReadTokens / total) * 100);
    }

    /**
     * 获取当前缓存状态快照
     */
    getState(): CacheState {
        return {
            active: this.isCacheActive(),
            lastCreatedAt: this.lastCacheWriteTime,
            lastHitAt: Date.now(),
            creationCount: this.totalCacheWrites,
            hitCount: this.totalCacheHits,
            remainingMs: this.getRemainingTTL(),
        };
    }

    /**
     * 获取缓存统计摘要
     * 解决问题: 生成人类可读的缓存统计字符串，供 UI 展示
     */
    getStatsSummary(): string {
        if (!this.config.enabled) return "缓存: 已禁用";

        const state = this.getState();
        const hitRate = this.getHitRate();

        const parts: string[] = [];
        parts.push(`命中率: ${hitRate}%`);
        parts.push(`写入: ${this.totalCacheWrites} 次 (${this.formatTokens(this.totalCacheWriteTokens)})`);
        parts.push(`命中: ${this.totalCacheHits} 次 (${this.formatTokens(this.totalCacheReadTokens)})`);

        if (state.active) {
            const remainingSec = Math.round(state.remainingMs / 1000);
            parts.push(`缓存有效 (剩余 ${remainingSec}s)`);
        } else if (this.lastCacheWriteTime > 0) {
            parts.push(`缓存已过期`);
        }

        // 成本节省估算: 缓存读取价格约为写入的 10%
        const savedTokens = this.totalCacheReadTokens * 0.9;
        if (savedTokens > 0) {
            parts.push(`约节省: ${this.formatTokens(savedTokens)}`);
        }

        return parts.join(" | ");
    }

    /**
     * 重置缓存状态
     * 解决问题: 新会话开始或缓存失效时重置统计
     */
    reset(): void {
        this.lastCacheWriteTime = 0;
        this.totalCacheWrites = 0;
        this.totalCacheHits = 0;
        this.totalCacheWriteTokens = 0;
        this.totalCacheReadTokens = 0;
    }

    /**
     * 为 content block 添加缓存标记
     * 解决问题: 对可缓存的内容（system prompt、tool 定义）自动附加 cache_control
     *
     * @param block — 原始 content block
     * @returns 带 cache_control 标记的 content block
     */
    markCacheable<T extends Record<string, unknown>>(block: T): T & { cache_control: { type: "ephemeral" } } {
        return { ...block, cache_control: { type: "ephemeral" } };
    }

    /**
     * 检查是否需要刷新缓存
     * 解决问题: 当 TTL 剩余时间不足总 TTL 的 15% 时，建议刷新
     *          这样可以确保下次请求时缓存仍然有效
     */
    shouldRefresh(): boolean {
        if (!this.isCacheActive()) return true;
        const remainingRatio = this.getRemainingTTL() / this.config.ttlMs;
        return remainingRatio < 0.15;
    }

    private formatTokens(tokens: number): string {
        if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
        return tokens.toString();
    }
}
