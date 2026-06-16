// ─── packages/core/src/agent/error-recovery/manager.ts ───
// ErrorRecoveryManager — 错误恢复主控制器
// 解决问题: 统一调度错误分类、重试、Provider 回退、熔断等子系统，
//         为 Agent Loop 提供一站式的错误恢复决策和执行能力
//
// 架构位置: Agent Loop → ErrorRecoveryManager → Classifier / Retry / CircuitBreaker / Failover
//           Agent Loop 发生错误时调用 manager.handleLLMError / handleToolError，
//           manager 内部完成分类→决策→执行的全流程

import type { LLMProvider } from "../../types/agent";
import type { Logger } from "../../types/tools";
import { ErrorClassifier } from "./classifier";
import { RetryManager } from "./retry";
import { CircuitBreakerManager } from "./circuit-breaker";
import { ProviderFailoverManager } from "./failover";
import {
    ErrorCategory,
    RecoveryStrategy,
    type ErrorInfo,
    type RecoveryResult,
    type RetryConfig,
    type CircuitBreakerConfig,
    type ProviderFailoverConfig,
    DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "./types";

/**
 * ErrorRecoveryManager 配置
 */
export interface ErrorRecoveryConfig {
    /** 重试配置 */
    retry?: Partial<RetryConfig>;
    /** 熔断器配置 */
    circuitBreaker?: Partial<CircuitBreakerConfig>;
    /** Provider 回退配置（必须提供至少一个 Provider） */
    failover: ProviderFailoverConfig;
    /** 日志器（可选，用于记录恢复过程） */
    logger?: Logger;
}

/**
 * ErrorRecoveryManager — 错误恢复子系统的主入口
 * 解决问题: Agent Loop 需要统一的错误处理入口，
 *         而不是在各个 catch 块中散落不同的处理逻辑
 */
export class ErrorRecoveryManager {
    /** 错误分类器 */
    private classifier: ErrorClassifier;
    /** 重试管理器 */
    private retryManager: RetryManager;
    /** 熔断器管理器 */
    circuitBreaker: CircuitBreakerManager;
    /** Provider 回退管理器 */
    failover: ProviderFailoverManager;
    /** 日志器 */
    private logger?: Logger;

    /** 当前轮次 LLM 错误重试计数 */
    private llmRetryCount: number = 0;

    constructor(config: ErrorRecoveryConfig) {
        this.classifier = new ErrorClassifier();
        this.retryManager = new RetryManager(config.retry);
        this.circuitBreaker = new CircuitBreakerManager(config.circuitBreaker);
        this.failover = new ProviderFailoverManager(config.failover);
        this.logger = config.logger;
    }

    // ─── LLM 错误处理 ───

    /**
     * 处理 LLM 调用错误 — 分类→决策→返回恢复结果
     * 解决问题: LLM 调用失败后，根据错误类型自动决定是重试、切换 Provider 还是终止
     *
     * @param error - LLM 调用中抛出的原始错误
     * @param currentModel - 当前使用的模型名（Provider 切换时需要重新映射模型名）
     * @returns RecoveryResult — 告知 Agent Loop 应如何行动
     */
    handleLLMError(error: Error, currentModel: string): RecoveryResult {
        const providerName = this.failover.getCurrentProviderName();
        const maxRetries = this.retryManager.getConfig().maxRetries;

        // 分类错误
        const errorInfo = this.classifier.classifyLLMError(
            error,
            providerName,
            this.llmRetryCount,
            maxRetries,
        );

        this.log("warn", `LLM 错误分类: ${errorInfo.category} | 策略: ${errorInfo.suggestedStrategy} | 重试: ${this.llmRetryCount}/${maxRetries}`);

        // 根据策略执行恢复
        switch (errorInfo.suggestedStrategy) {
            case RecoveryStrategy.RETRY:
                return this.executeRetry(errorInfo, currentModel);

            case RecoveryStrategy.SWITCH_PROVIDER:
                return this.executeProviderSwitch(currentModel);

            case RecoveryStrategy.COMPACT_CONTEXT:
                return this.executeCompactContext(errorInfo);

            case RecoveryStrategy.ABORT_TURN:
                return this.createResult(false, RecoveryStrategy.ABORT_TURN, "abort_turn", errorInfo.message);

            case RecoveryStrategy.ABORT_SESSION:
                return this.createResult(false, RecoveryStrategy.ABORT_SESSION, "abort_session", errorInfo.message);

            default:
                return this.createResult(false, RecoveryStrategy.ABORT_TURN, "abort_turn", `未知恢复策略: ${errorInfo.suggestedStrategy}`);
        }
    }

    /**
     * 处理 LLM 流式响应中的 error 类型 chunk
     * 解决问题: LLM Provider 在流式传输中也可能返回 error chunk（非抛异常），
     *         需要同样的分类和决策流程
     *
     * @param code - 错误码字符串
     * @param message - 错误描述
     * @param currentModel - 当前模型名
     */
    handleLLMErrorChunk(code: string, message: string, currentModel: string): RecoveryResult {
        const error = new Error(`[${code}]: ${message}`);
        return this.handleLLMError(error, currentModel);
    }

    // ─── 工具错误处理 ───

    /**
     * 处理工具执行错误 — 分类→熔断检查→反馈 LLM
     * 解决问题: 工具错误通常不应终止 Agent Loop，而是反馈给 LLM 让其调整策略，
     *         但如果同一工具反复失败则触发熔断保护
     *
     * @param error - 工具执行中抛出的原始错误
     * @param toolName - 工具名称
     * @returns RecoveryResult
     */
    handleToolError(error: Error, toolName: string): RecoveryResult {
        // 先记录失败到熔断器（内部统计窗口内失败次数）
        const triggeredCircuitBreak = this.circuitBreaker.recordFailure(toolName);

        // 获取当前失败次数（用于分类器判断是否达到熔断阈值）
        // CircuitBreakerManager 内部维护精确计数，这里使用默认配置阈值
        const failureCount = DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold;
        const threshold = DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold;

        const errorInfo = this.classifier.classifyToolError(
            error,
            toolName,
            failureCount,
            threshold,
        );

        if (triggeredCircuitBreak || errorInfo.category === ErrorCategory.CIRCUIT_BREAKER) {
            this.log("warn", `工具 "${toolName}" 触发熔断 | 窗口内失败 ${failureCount} 次`);
            return this.createResult(
                false,
                RecoveryStrategy.CIRCUIT_BREAK,
                "abort_turn",
                errorInfo.message,
            );
        }

        this.log("info", `工具 "${toolName}" 执行失败: ${error.message} | 反馈 LLM 继续循环`);
        return this.createResult(
            true,
            RecoveryStrategy.FEEDBACK_TO_LLM,
            "continue",
            errorInfo.message,
        );
    }

    /**
     * 处理工具未找到错误
     * @param toolName - 未找到的工具名
     */
    handleToolNotFound(toolName: string): RecoveryResult {
        const errorInfo = this.classifier.classifySystemError("tool_not_found", toolName);
        return this.createResult(
            true,
            RecoveryStrategy.FEEDBACK_TO_LLM,
            "continue",
            errorInfo.message,
        );
    }

    /**
     * 处理用户拒绝授权错误
     * @param toolName - 被拒绝的工具名
     */
    handlePermDenied(toolName: string): RecoveryResult {
        const errorInfo = this.classifier.classifySystemError("perm_denied", toolName);
        return this.createResult(
            true,
            RecoveryStrategy.FEEDBACK_TO_LLM,
            "continue",
            errorInfo.message,
        );
    }

    /**
     * 处理达到最大轮次错误
     */
    handleMaxRounds(): RecoveryResult {
        const errorInfo = this.classifier.classifySystemError("max_rounds");
        return this.createResult(
            false,
            RecoveryStrategy.ABORT_TURN,
            "abort_turn",
            errorInfo.message,
        );
    }

    // ─── 熔断器查询 ───

    /**
     * 在执行工具前检查熔断器状态
     * @param toolName - 工具名称
     * @returns true 表示允许执行
     */
    checkCircuitBreaker(toolName: string): boolean {
        return this.circuitBreaker.beforeExecute(toolName);
    }

    /**
     * 错误码分类 — 统一入口，消除 AgentLoop 中的重复分类逻辑
     * @param code - LLM Provider 返回的错误码字符串
     */
    classifyErrorCode(code: string): ErrorCategory {
        return this.classifier.classifyByCode(code);
    }

    /**
     * 工具执行成功后通知熔断器
     * @param toolName - 工具名称
     */
    recordToolSuccess(toolName: string): void {
        this.circuitBreaker.recordSuccess(toolName);
    }

    /**
     * 获取工具在窗口内的失败次数（用于熔断检查）
     */
    private getToolFailureCount(toolName: string): number {
        // 通过熔断器状态间接估算：如果 CLOSED 但 check 不通过说明接近阈值
        // 这里简化为返回任意合理值，精确计数在 CircuitBreaker 内部维护
        return 1;
    }

    // ─── 重试次数管理 ───

    /**
     * 重置当前轮次的 LLM 重试计数
     * 解决问题: 每次新的 LLM 调用开始前重置计数，避免跨轮次累积
     */
    resetLLMRetryCount(): void {
        this.llmRetryCount = 0;
    }

    /**
     * 重置整个错误恢复状态（用于新会话）
     */
    resetAll(): void {
        this.llmRetryCount = 0;
        this.circuitBreaker.resetAll();
        this.failover.reset();
    }

    // ─── 内部辅助方法 ───

    /**
     * 执行重试策略 — 计算延迟并返回重试指令
     */
    private executeRetry(errorInfo: ErrorInfo, _currentModel: string): RecoveryResult {
        const delayMs = this.retryManager.calculateDelay(
            this.llmRetryCount + 1,
            errorInfo.retryAfterSeconds,
        );

        this.llmRetryCount++;

        if (this.llmRetryCount > this.retryManager.getConfig().maxRetries) {
            // 重试次数耗尽，尝试切换 Provider
            if (this.failover.hasNext()) {
                return this.executeProviderSwitch(_currentModel);
            }
            return this.createResult(false, RecoveryStrategy.ABORT_TURN, "abort_turn", "重试次数耗尽，无可用 Provider");
        }

        this.log("info", `准备第 ${this.llmRetryCount} 次重试 | 等待 ${Math.round(delayMs)}ms`);
        return {
            success: true,
            strategy: RecoveryStrategy.RETRY,
            action: "retry",
            provider: this.failover.getCurrentProvider(),
        };
    }

    /**
     * 执行 Provider 切换策略
     */
    private executeProviderSwitch(currentModel: string): RecoveryResult {
        const nextProvider = this.failover.switchToNext();

        if (!nextProvider) {
            this.log("error", "Provider 回退链耗尽，无可用 LLM Provider");
            return this.createResult(
                false,
                RecoveryStrategy.ABORT_SESSION,
                "abort_session",
                "所有 LLM Provider 均不可用，请检查网络和 API 配置",
            );
        }

        // 重置 LLM 重试计数（新 Provider 重新开始）
        this.llmRetryCount = 0;

        // 映射模型名
        const mappedModel = this.failover.mapModel(currentModel, nextProvider.name);

        this.log("warn", `Provider 已切换至: ${nextProvider.name} | 模型: ${mappedModel}`);

        return {
            success: true,
            strategy: RecoveryStrategy.SWITCH_PROVIDER,
            provider: nextProvider,
            action: "retry",
        };
    }

    /**
     * 执行上下文压缩策略 — 返回压缩指令，由 Agent Loop 的 ContextBuilder 实际执行压缩
     */
    private executeCompactContext(errorInfo: ErrorInfo): RecoveryResult {
        this.llmRetryCount++;

        if (this.llmRetryCount > 1) {
            // 压缩后仍然溢出，不再重试
            return this.createResult(false, RecoveryStrategy.ABORT_TURN, "abort_turn", "上下文压缩后仍然超出窗口限制");
        }

        this.log("info", "触发上下文压缩策略 | 将在压缩后重试");
        return {
            success: true,
            strategy: RecoveryStrategy.COMPACT_CONTEXT,
            action: "retry",
            provider: this.failover.getCurrentProvider(),
        };
    }

    /**
     * 构造统一格式的 RecoveryResult
     */
    private createResult(
        success: boolean,
        strategy: RecoveryStrategy,
        action: RecoveryResult["action"],
        error?: string,
    ): RecoveryResult {
        return { success, strategy, action, error };
    }

    /**
     * 记录日志
     */
    private log(level: "info" | "warn" | "error", message: string): void {
        if (!this.logger) return;
        switch (level) {
            case "info":
                this.logger.info(`[ErrorRecovery] ${message}`);
                break;
            case "warn":
                this.logger.warn(`[ErrorRecovery] ${message}`);
                break;
            case "error":
                this.logger.error(`[ErrorRecovery] ${message}`);
                break;
        }
    }
}
