// ─── packages/core/src/observability/manager.ts ───
// ObservabilityManager — 可观测性主控制器
// 解决问题: 统一调度 Transcript、Metrics、Tracer 三个子系统，
//         为 Agent Loop 提供一键式的可观测性接入点
//
// 使用模式:
//   Agent Loop 在关键节点调用 manager.recordLLMCall() / recordToolCall() 等便捷方法，
//   manager 内部自动协调 Transcript 写入 + Metrics 收集 + Span 追踪

import type { TokenUsage } from "../types/messages";
import type { ErrorCategory } from "../agent/error-recovery/types";
import type { Logger } from "../types/tools";
import { TranscriptWriter } from "./transcript";
import { MetricsCollector } from "./metrics";
import { Tracer } from "./tracer";
import type {
    ObservabilityConfig,
    TranscriptEvent,
    MetricsSnapshot,
    Span,
} from "./types";
import { DEFAULT_OBSERVABILITY_CONFIG } from "./types";

/**
 * ObservabilityManager — 可观测性子系统主入口
 * 解决问题: Agent Loop 只需注入一个对象，即可获得完整的可观测性能力
 */
export class ObservabilityManager {
    /** JSONL 对话记录器 */
    transcript: TranscriptWriter;
    /** 性能指标收集器 */
    metrics: MetricsCollector;
    /** 链路追踪器 */
    tracer: Tracer;
    /** 日志器（可选，用于内部错误记录） */
    private logger?: Logger;

    constructor(config?: ObservabilityConfig, logger?: Logger) {
        const cfg = { ...DEFAULT_OBSERVABILITY_CONFIG, ...config };
        this.transcript = new TranscriptWriter(cfg.transcript);
        this.metrics = new MetricsCollector(cfg.metrics);
        this.tracer = new Tracer(cfg.tracing);
        this.logger = logger;
    }

    // ─── 会话生命周期 ───

    /**
     * 开始新会话 — 打开 Transcript 文件
     */
    startSession(sessionId: string): void {
        this.transcript.startSession(sessionId);
    }

    /**
     * 开始新一轮对话 — 创建 Trace
     */
    startTurn(userInput: string): string {
        const traceId = this.tracer.startTrace("agent.turn", {
            user_input: userInput.slice(0, 500),
        });

        this.transcript.record(this.makeEvent("turn:start", traceId, {
            user_input: userInput.slice(0, 500),
        }));

        return traceId;
    }

    /**
     * 结束新一轮对话 — 结束 Trace，记录总耗时
     */
    endTurn(traceId: string, usage: TokenUsage, toolRounds: number): void {
        const trace = this.tracer.endTrace(traceId);
        const duration = trace ? trace.end_time - trace.start_time : 0;

        this.transcript.record(this.makeEvent("turn:end", traceId, {
            duration_ms: duration,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            tool_rounds: toolRounds,
        }));

        // 更新 Session 级 Gauge
        this.metrics.set("session.token.total", usage.inputTokens + usage.outputTokens);
        this.metrics.set("session.tool.rounds", toolRounds);
    }

    // ─── LLM 调用 ───

    /**
     * 记录 LLM 调用开始 — 开始 LLM Span
     * @returns span_id（调用结束时需要传入 recordLLMResult）
     */
    recordLLMCall(model: string, messageCount: number, estimatedTokens: number): string {
        this.metrics.increment("llm.calls.total");

        const spanId = this.tracer.startSpan("llm.call", {
            model,
            message_count: messageCount,
            estimated_tokens: estimatedTokens,
        });

        this.transcript.record(this.makeEvent("llm:call", this.tracer.getCurrentTraceId(), {
            span_id: spanId,
            model,
            message_count: messageCount,
            estimated_tokens: estimatedTokens,
        }));

        return spanId;
    }

    /**
     * 记录 LLM 调用结果 — 结束 LLM Span
     */
    recordLLMResult(
        spanId: string,
        usage: TokenUsage,
        toolUseCount: number,
        hasError: boolean,
        errorCategory?: ErrorCategory,
    ): void {
        const duration = this.tracer.getSpanDuration(spanId);
        this.tracer.endSpan(spanId, hasError ? "error" : "ok", {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            tool_use_count: toolUseCount,
            duration_ms: duration,
        });

        // Metrics
        this.metrics.observe("llm.latency", duration);
        this.metrics.observe("token.usage", usage.inputTokens + usage.outputTokens);

        if (hasError) {
            this.metrics.increment("llm.calls.errors");
            if (errorCategory) {
                this.metrics.increment("llm.calls.errors", "error_category", errorCategory);
            }
        }

        // Transcript
        this.transcript.record(this.makeEvent("llm:result", this.tracer.getCurrentTraceId(), {
            span_id: spanId,
            duration_ms: duration,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            tool_use_count: toolUseCount,
            has_error: hasError,
            error_category: errorCategory,
        }));
    }

    // ─── 工具调用 ───

    /**
     * 记录工具调用开始 — 开始 Tool Span
     */
    recordToolCall(toolName: string, inputKeys: string[]): string {
        this.metrics.increment("tool.calls.total");
        this.metrics.increment("tool.calls.total", "tool_name", toolName);

        const spanId = this.tracer.startSpan(`tool.execute:${toolName}`, {
            tool_name: toolName,
            input_keys: inputKeys,
        });

        this.transcript.record(this.makeEvent("tool:call", this.tracer.getCurrentTraceId(), {
            span_id: spanId,
            tool_name: toolName,
            input_keys: inputKeys,
        }));

        return spanId;
    }

    /**
     * 记录工具调用结果 — 结束 Tool Span
     */
    recordToolResult(
        spanId: string,
        toolName: string,
        isError: boolean,
        resultSummary: string,
    ): void {
        const duration = this.tracer.getSpanDuration(spanId);
        this.tracer.endSpan(spanId, isError ? "error" : "ok", {
            tool_name: toolName,
            duration_ms: duration,
            result_summary: resultSummary.slice(0, 200),
        });

        this.metrics.observe("tool.latency", duration);

        if (isError) {
            this.metrics.increment("tool.calls.errors");
            this.metrics.increment("tool.calls.errors", "tool_name", toolName);
        }

        this.transcript.record(this.makeEvent("tool:result", this.tracer.getCurrentTraceId(), {
            span_id: spanId,
            tool_name: toolName,
            duration_ms: duration,
            is_error: isError,
            result_summary: resultSummary.slice(0, 200),
        }));
    }

    // ─── 错误与恢复 ───

    /**
     * 记录错误事件
     */
    recordError(error: Error, category?: ErrorCategory): void {
        this.transcript.record(this.makeEvent("error", this.tracer.getCurrentTraceId(), {
            span_id: this.tracer.getCurrentSpanId(),
            error_message: error.message,
            error_category: category,
        }));
    }

    /**
     * 记录错误恢复事件
     */
    recordRecovery(strategy: string, success: boolean, detail?: string): void {
        this.metrics.increment("recovery.attempts");
        this.metrics.increment("recovery.attempts", "strategy", strategy);
        if (success) {
            this.metrics.increment("recovery.successes");
            this.metrics.increment("recovery.successes", "strategy", strategy);
        }

        this.transcript.record(this.makeEvent("recovery", this.tracer.getCurrentTraceId(), {
            span_id: this.tracer.getCurrentSpanId(),
            strategy,
            success,
            detail,
        }));
    }

    // ─── 导出 ───

    /**
     * 获取当前 Metrics 快照
     */
    getMetricsSnapshot(): MetricsSnapshot {
        return this.metrics.getSnapshot();
    }

    /**
     * 获取指定 Trace 的完整 Span 树
     */
    getTrace(traceId: string): Span | undefined {
        // Trace 在 endTrace 时已从内部 Map 移除并返回
        // 这里返回 undefined 表示需要调用方在 endTurn 时自行保存
        return undefined;
    }

    /**
     * 结束会话 — 关闭 Transcript 文件流
     */
    endSession(): void {
        this.transcript.endSession();
    }

    /**
     * 重置所有状态
     */
    reset(): void {
        this.metrics.reset();
        this.tracer.reset();
    }

    // ─── 内部方法 ───

    private makeEvent(
        type: TranscriptEvent["type"],
        traceId: string,
        payload: Record<string, unknown>,
    ): TranscriptEvent {
        return {
            type,
            timestamp: new Date().toISOString(),
            session_id: "", // 由 TranscriptWriter.startSession 设置
            trace_id: traceId,
            span_id: this.tracer.getCurrentSpanId(),
            payload,
        };
    }
}
