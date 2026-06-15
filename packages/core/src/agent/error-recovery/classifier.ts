// ─── packages/core/src/agent/error-recovery/classifier.ts ───
// 错误分类器 — 将原始错误映射为结构化的 ErrorInfo
// 解决问题: Agent Loop 中出现的各类错误需要被识别和分类，
//         才能由 ErrorRecoveryManager 选择正确的恢复策略

import { ErrorCategory, RecoveryStrategy, type ErrorInfo } from "./types";

/**
 * 错误分类器 — 根据错误来源（LLM / 工具 / 系统）和错误特征进行分类
 * 解决问题: 原始 catch 块中的 Error 对象缺乏结构化信息，
 *         分类器提取关键特征（HTTP 状态码、错误码字符串）并映射到 ErrorCategory
 */
export class ErrorClassifier {
    /**
     * 分类 LLM Provider 返回的错误
     * 解决问题: LLM API 调用可能返回多种错误（网络超时、限流、认证失败等），
     *         不同错误需要不同恢复策略
     *
     * @param error - 原始错误对象
     * @param providerName - 发生错误的 Provider 名称
     * @param retryCount - 当前已重试次数
     * @param maxRetries - 最大允许重试次数
     */
    classifyLLMError(
        error: Error,
        providerName: string,
        retryCount: number,
        maxRetries: number,
    ): ErrorInfo {
        const message = error.message;
        // 尝试从错误消息中提取 HTTP 状态码
        const statusMatch = message.match(/\b(4\d{2}|5\d{2}|429)\b/);
        const statusCode = statusMatch ? parseInt(statusMatch[0], 10) : undefined;

        // ─── HTTP 429 Rate Limit ───
        if (statusCode === 429 || /rate.?limit|too.?many.?requests/i.test(message)) {
            const retryAfter = this.extractRetryAfter(error);
            return {
                category: ErrorCategory.RATE_LIMIT,
                severity: "warning",
                retryable: true,
                suggestedStrategy: RecoveryStrategy.RETRY,
                retryCount,
                maxRetries,
                message,
                source: providerName,
                statusCode: 429,
                retryAfterSeconds: retryAfter,
            };
        }

        // ─── HTTP 401/403 认证错误 ───
        if (statusCode === 401 || statusCode === 403 || /unauthorized|forbidden|invalid.*(api.?key|token|auth)/i.test(message)) {
            return {
                category: ErrorCategory.AUTH,
                severity: "critical",
                retryable: false,
                suggestedStrategy: RecoveryStrategy.ABORT_SESSION,
                retryCount,
                maxRetries,
                message,
                source: providerName,
                statusCode,
            };
        }

        // ─── HTTP 400 无效请求 ───
        if (statusCode === 400 || /invalid.*request|bad.?request/i.test(message)) {
            return {
                category: ErrorCategory.INVALID_REQUEST,
                severity: "error",
                retryable: false,
                suggestedStrategy: RecoveryStrategy.ABORT_TURN,
                retryCount,
                maxRetries,
                message,
                source: providerName,
                statusCode: 400,
            };
        }

        // ─── HTTP 5xx Provider 内部错误 ───
        if (statusCode && statusCode >= 500 && statusCode < 600 || /internal.*(server)?.*error|service.?unavailable/i.test(message)) {
            return {
                category: ErrorCategory.PROVIDER_ERROR,
                severity: "error",
                retryable: true,
                suggestedStrategy:
                    retryCount >= maxRetries
                        ? RecoveryStrategy.SWITCH_PROVIDER
                        : RecoveryStrategy.RETRY,
                retryCount,
                maxRetries,
                message,
                source: providerName,
                statusCode,
            };
        }

        // ─── 上下文溢出 ───
        if (/context.?length|too.?many.?tokens|token.?limit|maximum.?context/i.test(message)) {
            return {
                category: ErrorCategory.CONTEXT_OVERFLOW,
                severity: "error",
                retryable: true,
                suggestedStrategy: RecoveryStrategy.COMPACT_CONTEXT,
                retryCount,
                maxRetries: 1, // 压缩后最多重试 1 次
                message,
                source: providerName,
            };
        }

        // ─── 网络错误（连接超时、DNS 解析失败、TCP 断开等） ───
        if (/network|timeout|econnrefused|enotfound|econnreset|socket|dns|abort/i.test(message)) {
            return {
                category: ErrorCategory.NETWORK,
                severity: "warning",
                retryable: true,
                suggestedStrategy: RecoveryStrategy.RETRY,
                retryCount,
                maxRetries,
                message,
                source: providerName,
            };
        }

        // ─── 兜底: 未知错误按可重试处理（保守策略） ───
        return {
            category: ErrorCategory.PROVIDER_ERROR,
            severity: "error",
            retryable: retryCount < maxRetries,
            suggestedStrategy:
                retryCount >= maxRetries
                    ? RecoveryStrategy.ABORT_TURN
                    : RecoveryStrategy.RETRY,
            retryCount,
            maxRetries,
            message,
            source: providerName,
        };
    }

    /**
     * 分类工具执行产生的错误
     * 解决问题: 工具错误不同于 LLM 错误——大部分工具错误应该反馈给 LLM 让其自行调整，
     *         但同一工具反复失败需要熔断保护
     *
     * @param error - 原始错误对象
     * @param toolName - 发生错误的工具名称
     * @param consecutiveFailures - 该工具在窗口内的连续失败次数
     * @param failureThreshold - 熔断阈值
     */
    classifyToolError(
        error: Error,
        toolName: string,
        consecutiveFailures: number,
        failureThreshold: number,
    ): ErrorInfo {
        const message = error.message;

        // ─── 熔断检查: 同一工具在窗口内失败次数达到阈值 ───
        if (consecutiveFailures >= failureThreshold) {
            return {
                category: ErrorCategory.CIRCUIT_BREAKER,
                severity: "error",
                retryable: false,
                suggestedStrategy: RecoveryStrategy.CIRCUIT_BREAK,
                retryCount: consecutiveFailures,
                maxRetries: failureThreshold,
                message: `工具 "${toolName}" 在时间窗口内连续失败 ${consecutiveFailures} 次，触发熔断保护`,
                source: toolName,
            };
        }

        // ─── 普通工具执行异常 ───
        return {
            category: ErrorCategory.TOOL_EXEC,
            severity: "warning",
            retryable: false, // 工具错误不自动重试，而是反馈给 LLM
            suggestedStrategy: RecoveryStrategy.FEEDBACK_TO_LLM,
            retryCount: 0,
            maxRetries: 0,
            message,
            source: toolName,
        };
    }

    /**
     * 分类系统层错误（工具未找到、用户拒绝、达到最大轮次）
     * 解决问题: 这些错误不由 catch 块产生，而是 Agent Loop 内部逻辑判断的结果
     */
    classifySystemError(
        type: "tool_not_found" | "perm_denied" | "max_rounds",
        toolName?: string,
    ): ErrorInfo {
        switch (type) {
            case "tool_not_found":
                return {
                    category: ErrorCategory.TOOL_NOT_FOUND,
                    severity: "warning",
                    retryable: false,
                    suggestedStrategy: RecoveryStrategy.FEEDBACK_TO_LLM,
                    retryCount: 0,
                    maxRetries: 0,
                    message: `未知工具: ${toolName}`,
                    source: toolName,
                };
            case "perm_denied":
                return {
                    category: ErrorCategory.PERM_DENIED,
                    severity: "warning",
                    retryable: false,
                    suggestedStrategy: RecoveryStrategy.FEEDBACK_TO_LLM,
                    retryCount: 0,
                    maxRetries: 0,
                    message: "用户拒绝了此操作",
                    source: toolName,
                };
            case "max_rounds":
                return {
                    category: ErrorCategory.MAX_ROUNDS,
                    severity: "error",
                    retryable: false,
                    suggestedStrategy: RecoveryStrategy.ABORT_TURN,
                    retryCount: 0,
                    maxRetries: 0,
                    message: "达到最大工具调用轮次",
                };
        }
    }

    /**
     * 从错误对象中提取 Retry-After 秒数
     * 解决问题: HTTP 429 响应可能包含 Retry-After 头，告知客户端应等待的秒数，
     *         尊重服务端的建议可以避免被持续限流
     */
    private extractRetryAfter(error: Error): number | undefined {
        // 尝试从错误消息中提取 retry-after 或 retry_after 信息
        const match = error.message.match(/retry[_-]?after[:\s]+(\d+)/i);
        if (match) {
            return parseInt(match[1], 10);
        }
        // 也检查 error 对象上是否有 retryAfter 属性（某些 SDK 会设置）
        const errWithRetry = error as Error & { retryAfter?: number };
        if (typeof errWithRetry.retryAfter === "number") {
            return errWithRetry.retryAfter;
        }
        return undefined;
    }
}
