// ─── packages/core/src/observability/index.ts ───
// 可观测性模块 barrel export

export { ObservabilityManager } from "./manager";
export { TranscriptWriter } from "./transcript";
export { MetricsCollector } from "./metrics";
export { Tracer } from "./tracer";
export { DEFAULT_OBSERVABILITY_CONFIG } from "./types";
export type {
    TranscriptEvent,
    TranscriptEventType,
    Span,
    MetricCounter,
    MetricHistogram,
    MetricGauge,
    MetricsSnapshot,
    TranscriptConfig,
    MetricsConfig,
    TracingConfig,
    ObservabilityConfig,
} from "./types";
