// ─── packages/core/src/observability/types.ts ───
// 可观测性类型定义 — Metrics、Span、Transcript 事件

import type { TokenUsage } from "../types/messages";
import type { ErrorCategory } from "../agent/error-recovery/types";

// ─── Transcript 事件 ───

export type TranscriptEventType =
    | "turn:start"
    | "turn:end"
    | "llm:call"
    | "llm:result"
    | "tool:call"
    | "tool:result"
    | "error"
    | "recovery";

export interface TranscriptEvent {
    /** 事件类型 */
    type: TranscriptEventType;
    /** 时间戳 (ISO 8601) */
    timestamp: string;
    /** 会话 ID */
    session_id: string;
    /** Trace ID */
    trace_id: string;
    /** 当前 Span ID */
    span_id?: string;
    /** 事件负载 */
    payload: Record<string, unknown>;
}

// ─── Span (链路追踪) ───

export interface Span {
    /** Span 唯一 ID */
    span_id: string;
    /** 所属 Trace ID */
    trace_id: string;
    /** 父 Span ID (根 Span 为 undefined) */
    parent_span_id?: string;
    /** 操作名称 */
    name: string;
    /** 开始时间戳 (epoch ms) */
    start_time: number;
    /** 结束时间戳 (epoch ms)，进行中为 0 */
    end_time: number;
    /** 状态 */
    status: "ok" | "error";
    /** 附加元数据 */
    metadata: Record<string, unknown>;
    /** 子 Span 列表 */
    children: Span[];
}

// ─── Metrics ───

export interface MetricCounter {
    name: string;
    help: string;
    value: number;
    /** 按标签分组的值 */
    labels: Record<string, Record<string, number>>;
}

export interface MetricHistogram {
    name: string;
    help: string;
    /** 所有记录的值 */
    values: number[];
    /** 分桶边界 (ms 或 token 数) */
    buckets: number[];
}

export interface MetricGauge {
    name: string;
    help: string;
    value: number;
}

export interface MetricsSnapshot {
    counters: MetricCounter[];
    histograms: MetricHistogram[];
    gauges: MetricGauge[];
}

// ─── 配置 ───

export interface TranscriptConfig {
    enabled: boolean;
    /** 存储目录，默认 ~/.y-claude-code/transcripts */
    dir: string;
}

export interface MetricsConfig {
    enabled: boolean;
}

export interface TracingConfig {
    enabled: boolean;
}

export interface ObservabilityConfig {
    transcript?: Partial<TranscriptConfig>;
    metrics?: Partial<MetricsConfig>;
    tracing?: Partial<TracingConfig>;
}

export const DEFAULT_OBSERVABILITY_CONFIG: Required<ObservabilityConfig> = {
    transcript: { enabled: true, dir: "" },
    metrics: { enabled: true },
    tracing: { enabled: true },
};
