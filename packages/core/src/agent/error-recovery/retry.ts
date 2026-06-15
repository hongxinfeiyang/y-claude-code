// ─── packages/core/src/agent/error-recovery/retry.ts ───
// 指数退避重试管理器 — 计算重试等待时间并执行延迟
// 解决问题: 瞬时网络故障、限流等场景需要等待后重试，
//         指数退避 + 随机抖动能避免惊群效应和二次限流

import type { RetryConfig } from "./types";
import { DEFAULT_RETRY_CONFIG } from "./types";

/**
 * 重试管理器 — 实现指数退避算法 + 随机抖动
 * 解决问题: 固定间隔重试可能在服务恢复瞬间产生请求洪峰（惊群效应），
 *         指数增长 + 随机抖动将重试请求分散到不同时间点
 *
 * 退避公式:
 *   delay = min(baseDelay × multiplier^(attempt-1) + jitter, maxDelay)
 *   其中 jitter = random(0, delay × 0.1)
 *
 * 重试序列示例: 1s → 2s → 4s → 8s → 16s → 30s (上限)
 */
export class RetryManager {
    private config: RetryConfig;

    constructor(config?: Partial<RetryConfig>) {
        this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
    }

    /**
     * 计算指定重试次数的等待延迟（毫秒）
     * 解决问题: 调用方在执行重试前需要知道应等待多久
     *
     * @param attempt - 当前为第几次重试（从 1 开始）
     * @param retryAfterSeconds - 服务端建议的等待秒数（来自 Retry-After 头），优先使用
     * @returns 应等待的毫秒数
     */
    calculateDelay(attempt: number, retryAfterSeconds?: number): number {
        // 服务端指定的等待时间优先
        if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
            const serverDelay = retryAfterSeconds * 1000;
            return Math.min(serverDelay, this.config.maxDelayMs);
        }

        // 指数退避: baseDelay × multiplier^(attempt-1)
        const exponentialDelay =
            this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);

        // 随机抖动: 0 ~ 10%
        const jitter = Math.random() * exponentialDelay * 0.1;

        // 限制最大延迟
        return Math.min(exponentialDelay + jitter, this.config.maxDelayMs);
    }

    /**
     * 执行带重试的异步操作
     * 解决问题: 封装"失败→等待→重试"的完整逻辑，调用方只需传入操作函数
     *
     * @param operation - 要重试的异步操作
     * @param shouldRetry - 判断是否应该重试的函数（返回 false 则停止重试）
     * @param onRetry - 每次重试前的回调（用于日志记录和事件通知）
     * @returns 操作结果，如果所有重试都失败则抛出最后一次的错误
     */
    async executeWithRetry<T>(
        operation: () => Promise<T>,
        shouldRetry: (error: Error, attempt: number) => boolean,
        onRetry?: (error: Error, attempt: number, delayMs: number) => void,
    ): Promise<T> {
        let lastError: Error;
        let retryAfterSeconds: number | undefined;

        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));

                // 检查是否应该继续重试
                if (attempt >= this.config.maxRetries || !shouldRetry(lastError, attempt + 1)) {
                    throw lastError;
                }

                // 计算延迟并等待
                const delayMs = this.calculateDelay(attempt + 1, retryAfterSeconds);
                if (onRetry) {
                    onRetry(lastError, attempt + 1, delayMs);
                }

                await this.sleep(delayMs);

                // 尝试从本次错误中提取 Retry-After 供下次使用
                const retryMatch = lastError.message.match(/retry[_-]?after[:\s]+(\d+)/i);
                if (retryMatch) {
                    retryAfterSeconds = parseInt(retryMatch[1], 10);
                }
            }
        }

        throw lastError!;
    }

    /**
     * 阻塞等待指定毫秒数
     * 解决问题: 在重试之间需要等待一段时间，使用 Promise 实现非阻塞 sleep
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * 获取当前配置（只读）
     */
    getConfig(): Readonly<RetryConfig> {
        return this.config;
    }
}
