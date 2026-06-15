// ─── packages/core/src/agent/error-recovery/circuit-breaker.ts ───
// 熔断器 — 工具级错误熔断保护
// 解决问题: 同一工具在短时间内反复失败时自动熔断，阻止后续调用，
//         防止 Agent 陷入"失败→重试→再失败"的死循环浪费 token 和时间
//
// 状态机: CLOSED → OPEN → HALF_OPEN → CLOSED (恢复) / OPEN (再次熔断)

import type { CircuitBreakerConfig } from "./types";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./types";

/**
 * 熔断器状态枚举
 * CLOSED: 正常通行，记录失败次数
 * OPEN: 拒绝执行，直接返回错误
 * HALF_OPEN: 放行一次探测调用，成功则恢复，失败则重新熔断
 */
export enum CircuitState {
    CLOSED = "closed",
    OPEN = "open",
    HALF_OPEN = "half_open",
}

/**
 * 单个工具的熔断器实例
 * 解决问题: 每个工具独立一个熔断器，互不干扰
 */
class ToolCircuitBreaker {
    /** 当前状态 */
    state: CircuitState = CircuitState.CLOSED;
    /** 窗口内的失败时间戳列表 */
    private failureTimestamps: number[] = [];
    /** 熔断打开的时间戳 */
    private openedAt: number = 0;

    constructor(private config: CircuitBreakerConfig) {}

    /**
     * 记录一次失败并检查是否触发熔断
     * @returns 是否触发了熔断（从 CLOSED → OPEN）
     */
    recordFailure(): boolean {
        const now = Date.now();

        // 清理窗口外的旧记录
        this.failureTimestamps = this.failureTimestamps.filter(
            (t) => now - t < this.config.windowMs,
        );
        this.failureTimestamps.push(now);

        // 检查是否达到熔断阈值
        if (
            this.state === CircuitState.CLOSED &&
            this.failureTimestamps.length >= this.config.failureThreshold
        ) {
            this.state = CircuitState.OPEN;
            this.openedAt = now;
            return true; // 刚触发熔断
        }

        // HALF_OPEN 状态下的探测也失败，重新熔断
        if (this.state === CircuitState.HALF_OPEN) {
            this.state = CircuitState.OPEN;
            this.openedAt = now;
            return true;
        }

        return false;
    }

    /**
     * 记录一次成功 — 在 HALF_OPEN 状态下成功则恢复到 CLOSED
     */
    recordSuccess(): void {
        if (this.state === CircuitState.HALF_OPEN) {
            this.state = CircuitState.CLOSED;
            this.failureTimestamps = [];
        }
        // CLOSED 状态下成功不需要额外操作（不重置失败计数，维持滑动窗口）
    }

    /**
     * 在执行操作前检查熔断器状态
     *   - CLOSED: 允许通过
     *   - OPEN 但已过半开等待期: 转为 HALF_OPEN，允许通过（探测调用）
     *   - OPEN 且未过半开等待期: 拒绝通过
     *
     * @returns true 表示允许执行，false 表示熔断拒绝
     */
    allowRequest(): boolean {
        const now = Date.now();

        switch (this.state) {
            case CircuitState.CLOSED:
                return true;

            case CircuitState.OPEN:
                // 检查是否已过半开等待期
                if (now - this.openedAt >= this.config.halfOpenMs) {
                    this.state = CircuitState.HALF_OPEN;
                    return true; // 放行探测调用
                }
                return false;

            case CircuitState.HALF_OPEN:
                // HALF_OPEN 状态下只允许一次探测调用
                // 调用方需要在调用后调用 recordSuccess 或 recordFailure
                return true;

            default:
                return false;
        }
    }

    /**
     * 获取距离熔断器可以半开探测的剩余毫秒数
     * @returns 剩余毫秒数，如果已经是 CLOSED 或 HALF_OPEN 则返回 0
     */
    getRemainingOpenMs(): number {
        if (this.state !== CircuitState.OPEN) return 0;
        const elapsed = Date.now() - this.openedAt;
        return Math.max(0, this.config.halfOpenMs - elapsed);
    }
}

/**
 * 熔断器管理器 — 管理所有工具的熔断器实例
 * 解决问题: 集中管理熔断器生命周期，按工具名获取或创建
 */
export class CircuitBreakerManager {
    /** 工具名 → 熔断器实例 的映射 */
    private breakers: Map<string, ToolCircuitBreaker> = new Map();
    private config: CircuitBreakerConfig;

    constructor(config?: Partial<CircuitBreakerConfig>) {
        this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
    }

    /**
     * 获取或创建指定工具的熔断器
     * @param toolName - 工具名称
     */
    private getBreaker(toolName: string): ToolCircuitBreaker {
        let breaker = this.breakers.get(toolName);
        if (!breaker) {
            breaker = new ToolCircuitBreaker(this.config);
            this.breakers.set(toolName, breaker);
        }
        return breaker;
    }

    /**
     * 在执行工具前检查熔断状态
     * @param toolName - 工具名称
     * @returns true 表示允许执行，false 表示已被熔断
     */
    beforeExecute(toolName: string): boolean {
        return this.getBreaker(toolName).allowRequest();
    }

    /**
     * 工具执行成功后调用 — 记录成功
     * @param toolName - 工具名称
     */
    recordSuccess(toolName: string): void {
        this.getBreaker(toolName).recordSuccess();
    }

    /**
     * 工具执行失败后调用 — 记录失败并检查是否触发熔断
     * @param toolName - 工具名称
     * @returns true 表示此次失败触发了熔断
     */
    recordFailure(toolName: string): boolean {
        return this.getBreaker(toolName).recordFailure();
    }

    /**
     * 获取指定工具熔断器的当前状态
     * @param toolName - 工具名称
     */
    getState(toolName: string): CircuitState {
        return this.getBreaker(toolName).state;
    }

    /**
     * 获取指定工具熔断器的剩余打开时间（毫秒）
     * @param toolName - 工具名称
     */
    getRemainingOpenMs(toolName: string): number {
        return this.getBreaker(toolName).getRemainingOpenMs();
    }

    /**
     * 重置所有熔断器状态（用于会话重置）
     */
    resetAll(): void {
        this.breakers.clear();
    }

    /**
     * 重置指定工具的熔断器
     * @param toolName - 工具名称
     */
    reset(toolName: string): void {
        this.breakers.delete(toolName);
    }
}
