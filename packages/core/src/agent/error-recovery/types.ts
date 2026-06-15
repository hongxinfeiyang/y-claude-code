// ─── packages/core/src/agent/error-recovery/types.ts ───
// 错误恢复模型类型定义 — 错误分类、恢复策略、重试配置、熔断器配置
// 解决问题: 为错误恢复子系统提供完整的类型体系，支撑分类→决策→执行的策略链路

import type { LLMProvider } from "../../types/agent";

// ─── 错误分类枚举 ───
// 解决问题: 不同来源和性质的错误需要不同的恢复策略，
//         统一分类后 ErrorRecoveryManager 可按类别决策

export enum ErrorCategory {
    /** LLM 层: 网络错误（DNS 解析失败、连接超时、TCP 断开），可重试 */
    NETWORK = "network",
    /** LLM 层: 速率限制（HTTP 429），可重试且需等 Retry-After */
    RATE_LIMIT = "rate_limit",
    /** LLM 层: 认证错误（HTTP 401/403），不可重试 */
    AUTH = "auth",
    /** LLM 层: 无效请求（HTTP 400），参数格式错误，不可重试 */
    INVALID_REQUEST = "invalid_request",
    /** LLM 层: Provider 内部错误（HTTP 5xx），可重试 */
    PROVIDER_ERROR = "provider_error",
    /** LLM 层: 上下文超出窗口限制，需压缩后重试 */
    CONTEXT_OVERFLOW = "context_overflow",
    /** 工具层: LLM 幻觉产生的未知工具名，反馈 LLM 继续循环 */
    TOOL_NOT_FOUND = "tool_not_found",
    /** 工具层: 工具执行异常（文件不存在、命令失败等），反馈 LLM 继续循环 */
    TOOL_EXEC = "tool_exec",
    /** 工具层: 用户拒绝授权操作，反馈 LLM 继续循环 */
    PERM_DENIED = "perm_denied",
    /** 系统层: 达到最大工具调用轮次，强制终止 */
    MAX_ROUNDS = "max_rounds",
    /** 系统层: 熔断器触发，终止会话 */
    CIRCUIT_BREAKER = "circuit_breaker",
}

// ─── 恢复策略枚举 ───
// 解决问题: 每种策略对应一种具体的恢复行为，ErrorRecoveryManager 根据分类结果选择

export enum RecoveryStrategy {
    /** 指数退避重试: 等待后退时间后重新发起相同请求 */
    RETRY = "retry",
    /** 切换 Provider: 按回退链切换到下一个可用的 LLM Provider */
    SWITCH_PROVIDER = "switch_provider",
    /** 压缩上下文: 触发 LLM 驱动压缩，削去最早 50% 历史后重试 */
    COMPACT_CONTEXT = "compact_context",
    /** 反馈 LLM: 将错误以 is_error: true 格式注入上下文，LLM 自行调整 */
    FEEDBACK_TO_LLM = "feedback_to_llm",
    /** 触发熔断: 打开熔断器，后续调用直接拒绝 */
    CIRCUIT_BREAK = "circuit_break",
    /** 终止当前轮次: 停止本次 Agent Loop，等待用户处理 */
    ABORT_TURN = "abort_turn",
    /** 终止会话: 不可恢复的错误，终止整个会话 */
    ABORT_SESSION = "abort_session",
}

// ─── 错误信息结构 ───
// 解决问题: 将原始错误转换为结构化信息，包含分类、严重级别和建议策略

export interface ErrorInfo {
    /** 错误分类 */
    category: ErrorCategory;
    /** 错误严重级别: warning 可恢复 | error 当前轮次终止 | critical 会话终止 */
    severity: "warning" | "error" | "critical";
    /** 是否可重试 */
    retryable: boolean;
    /** 建议的恢复策略 */
    suggestedStrategy: RecoveryStrategy;
    /** 当前重试次数 */
    retryCount: number;
    /** 最大重试次数 */
    maxRetries: number;
    /** 原始错误消息 */
    message: string;
    /** 错误来源上下文（如工具名、Provider 名） */
    source?: string;
    /** HTTP 状态码（如来自 LLM API 的错误） */
    statusCode?: number;
    /** 服务端建议的重试等待秒数（Retry-After 头） */
    retryAfterSeconds?: number;
}

// ─── 重试配置 ───
// 解决问题: 用户可自定义重试行为的各项参数

export interface RetryConfig {
    /** 最大重试次数，默认 3 */
    maxRetries: number;
    /** 基础延迟毫秒数，默认 1000 */
    baseDelayMs: number;
    /** 最大延迟毫秒数（上限），默认 30000 */
    maxDelayMs: number;
    /** 指数退避乘数，默认 2 */
    backoffMultiplier: number;
}

// ─── 熔断器配置 ───
// 解决问题: 用户可自定义熔断器的触发阈值和时间窗口

export interface CircuitBreakerConfig {
    /** 熔断阈值: 窗口内失败次数达到此值触发熔断，默认 5 */
    failureThreshold: number;
    /** 统计窗口毫秒数，默认 60000 (60s) */
    windowMs: number;
    /** 熔断打开后的半开等待毫秒数，默认 30000 (30s) */
    halfOpenMs: number;
}

// ─── Provider 回退配置 ───
// 解决问题: 定义 Provider 回退链的顺序和模型名映射

export interface ProviderFailoverConfig {
    /** 已排序的 Provider 列表（索引 0 为最高优先级） */
    providers: LLMProvider[];
    /** 模型名映射: providerName -> { sourceModel -> targetModel } */
    modelMapping?: Record<string, Record<string, string>>;
}

// ─── 默认配置常量 ───
// 解决问题: 提供开箱即用的合理默认值，用户无需配置即可使用错误恢复功能

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
};

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
    failureThreshold: 5,
    windowMs: 60000,
    halfOpenMs: 30000,
};

// ─── 恢复结果 ───
// 解决问题: 描述恢复策略执行后的结果，告知 Agent Loop 下一步应如何行动

export interface RecoveryResult {
    /** 策略是否执行成功 */
    success: boolean;
    /** 执行的策略类型 */
    strategy: RecoveryStrategy;
    /** 如果策略是 RETRY/SWITCH_PROVIDER，返回新的 Provider */
    provider?: LLMProvider;
    /** 如果策略是 COMPACT_CONTEXT，返回压缩后的消息数 */
    compactedCount?: number;
    /** 如果策略失败，返回失败原因 */
    error?: string;
    /** 建议 Agent Loop 执行的操作 */
    action: "retry" | "continue" | "abort_turn" | "abort_session";
}
