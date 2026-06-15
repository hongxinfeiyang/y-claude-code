// ─── packages/core/src/agent/error-recovery/__tests__/classifier.test.ts ───
// ErrorClassifier 单元测试 — 验证 LLM/工具/系统三层错误分类的准确性

import { describe, it, expect } from "vitest";
import { ErrorClassifier } from "../classifier";
import { ErrorCategory, RecoveryStrategy } from "../types";

describe("ErrorClassifier — LLM 错误分类", () => {
    const classifier = new ErrorClassifier();

    // ─── 限流错误 ───
    it("应将 HTTP 429 分类为 RATE_LIMIT", () => {
        const info = classifier.classifyLLMError(
            new Error("429 Too Many Requests"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.RATE_LIMIT);
        expect(info.retryable).toBe(true);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.RETRY);
        expect(info.statusCode).toBe(429);
    });

    it("应从消息文本中识别限流（无状态码的情况）", () => {
        const info = classifier.classifyLLMError(
            new Error("rate limit exceeded: too many requests per minute"),
            "openai", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.RATE_LIMIT);
    });

    it("应从错误消息中提取 Retry-After 秒数", () => {
        const info = classifier.classifyLLMError(
            new Error("429 rate limit: retry-after: 30"),
            "anthropic", 0, 3,
        );
        expect(info.retryAfterSeconds).toBe(30);
    });

    // ─── 认证错误 ───
    it("应将 HTTP 401 分类为 AUTH", () => {
        const info = classifier.classifyLLMError(
            new Error("401 Unauthorized"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.AUTH);
        expect(info.retryable).toBe(false);
        expect(info.severity).toBe("critical");
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.ABORT_SESSION);
    });

    it("应将 HTTP 403 分类为 AUTH", () => {
        const info = classifier.classifyLLMError(
            new Error("403 Forbidden: invalid api key"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.AUTH);
    });

    it("应从消息文本识别认证错误（无状态码）", () => {
        const info = classifier.classifyLLMError(
            new Error("invalid token provided"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.AUTH);
    });

    // ─── 无效请求 ───
    it("应将 HTTP 400 分类为 INVALID_REQUEST", () => {
        const info = classifier.classifyLLMError(
            new Error("400 Bad Request: invalid request body"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.INVALID_REQUEST);
        expect(info.retryable).toBe(false);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.ABORT_TURN);
    });

    // ─── Provider 内部错误 ───
    it("应将 HTTP 500 分类为 PROVIDER_ERROR", () => {
        const info = classifier.classifyLLMError(
            new Error("500 Internal Server Error"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.PROVIDER_ERROR);
        expect(info.retryable).toBe(true);
        // 首次错误应建议 RETRY
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.RETRY);
    });

    it("Provider 错误超过最大重试次数时应建议切换 Provider", () => {
        const info = classifier.classifyLLMError(
            new Error("503 Service Unavailable"),
            "anthropic", 3, 3, // retryCount >= maxRetries
        );
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.SWITCH_PROVIDER);
    });

    // ─── 上下文溢出 ───
    it("应将上下文溢出分类为 CONTEXT_OVERFLOW", () => {
        const info = classifier.classifyLLMError(
            new Error("context length exceeded: too many tokens (50000 > 32768)"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.CONTEXT_OVERFLOW);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.COMPACT_CONTEXT);
        expect(info.maxRetries).toBe(1); // 压缩后只重试 1 次
    });

    it("应识别 token limit 消息", () => {
        const info = classifier.classifyLLMError(
            new Error("maximum context length reached: token limit exceeded"),
            "openai", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.CONTEXT_OVERFLOW);
    });

    // ─── 网络错误 ───
    it("应将网络超时分类为 NETWORK", () => {
        const info = classifier.classifyLLMError(
            new Error("network timeout after 30000ms"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.NETWORK);
        expect(info.retryable).toBe(true);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.RETRY);
    });

    it("应识别 ECONNREFUSED", () => {
        const info = classifier.classifyLLMError(
            new Error("connect ECONNREFUSED 127.0.0.1:443"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.NETWORK);
    });

    it("应识别 DNS 解析失败", () => {
        const info = classifier.classifyLLMError(
            new Error("getaddrinfo ENOTFOUND api.anthropic.com"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.NETWORK);
    });

    // ─── 兜底分类 ───
    it("未知错误应兜底为 PROVIDER_ERROR 并允许重试", () => {
        const info = classifier.classifyLLMError(
            new Error("something unexpected happened"),
            "anthropic", 0, 3,
        );
        expect(info.category).toBe(ErrorCategory.PROVIDER_ERROR);
        expect(info.retryable).toBe(true);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.RETRY);
    });

    it("未知错误超过最大重试次数应建议 ABORT_TURN", () => {
        const info = classifier.classifyLLMError(
            new Error("something unexpected happened"),
            "anthropic", 3, 3,
        );
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.ABORT_TURN);
    });
});

describe("ErrorClassifier — 工具错误分类", () => {
    const classifier = new ErrorClassifier();

    // ─── 普通工具异常 ───
    it("普通工具执行错误应反馈 LLM", () => {
        const info = classifier.classifyToolError(
            new Error("文件不存在: /tmp/missing.txt"),
            "Read", 1, 5,
        );
        expect(info.category).toBe(ErrorCategory.TOOL_EXEC);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.FEEDBACK_TO_LLM);
        expect(info.severity).toBe("warning");
    });

    // ─── 熔断触发 ───
    it("连续失败达到阈值应触发熔断", () => {
        const info = classifier.classifyToolError(
            new Error("命令执行失败"),
            "Bash", 5, 5, // consecutiveFailures >= failureThreshold
        );
        expect(info.category).toBe(ErrorCategory.CIRCUIT_BREAKER);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.CIRCUIT_BREAK);
        expect(info.retryable).toBe(false);
    });

    it("未达到阈值的连续失败不应触发熔断", () => {
        const info = classifier.classifyToolError(
            new Error("命令执行失败"),
            "Bash", 4, 5, // consecutiveFailures < failureThreshold
        );
        expect(info.category).toBe(ErrorCategory.TOOL_EXEC);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.FEEDBACK_TO_LLM);
    });
});

describe("ErrorClassifier — 系统错误分类", () => {
    const classifier = new ErrorClassifier();

    it("tool_not_found 应反馈 LLM", () => {
        const info = classifier.classifySystemError("tool_not_found", "UnknownTool");
        expect(info.category).toBe(ErrorCategory.TOOL_NOT_FOUND);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.FEEDBACK_TO_LLM);
        expect(info.message).toContain("UnknownTool");
    });

    it("perm_denied 应反馈 LLM", () => {
        const info = classifier.classifySystemError("perm_denied", "Bash");
        expect(info.category).toBe(ErrorCategory.PERM_DENIED);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.FEEDBACK_TO_LLM);
    });

    it("max_rounds 应终止轮次", () => {
        const info = classifier.classifySystemError("max_rounds");
        expect(info.category).toBe(ErrorCategory.MAX_ROUNDS);
        expect(info.suggestedStrategy).toBe(RecoveryStrategy.ABORT_TURN);
        expect(info.severity).toBe("error");
    });
});
