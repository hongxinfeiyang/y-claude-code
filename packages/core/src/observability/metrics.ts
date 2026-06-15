// ─── packages/core/src/observability/metrics.ts ───
// 性能指标收集器 — Counter、Histogram、Gauge
// 解决问题: 收集 LLM 调用延迟、工具执行耗时、Token 消耗等运行时指标，
//         支持按标签分组聚合，方便性能分析和异常检测

import type {
    MetricCounter,
    MetricHistogram,
    MetricGauge,
    MetricsSnapshot,
    MetricsConfig,
} from "./types";

/**
 * MetricsCollector — 内存中的性能指标收集器
 * 解决问题: 在 Agent 运行过程中持续收集各类指标，
 *         运行结束后可通过 getSnapshot() 导出聚合数据
 */
export class MetricsCollector {
    private enabled: boolean;
    private counters: Map<string, MetricCounter> = new Map();
    private histograms: Map<string, MetricHistogram> = new Map();
    private gauges: Map<string, MetricGauge> = new Map();

    constructor(config?: Partial<MetricsConfig>) {
        this.enabled = config?.enabled ?? true;
        this.registerDefaults();
    }

    // ─── Counter (计数器) ───

    /**
     * 计数器加 1（可选按标签分组）
     * @param name - 指标名
     * @param labelKey - 标签键（如 "error_category", "tool_name"）
     * @param labelValue - 标签值
     */
    increment(name: string, labelKey?: string, labelValue?: string): void {
        if (!this.enabled) return;

        const counter = this.counters.get(name);
        if (!counter) return;

        counter.value++;
        if (labelKey && labelValue) {
            if (!counter.labels[labelKey]) {
                counter.labels[labelKey] = {};
            }
            counter.labels[labelKey][labelValue] =
                (counter.labels[labelKey][labelValue] || 0) + 1;
        }
    }

    // ─── Histogram (直方图) ───

    /**
     * 记录一个直方图观测值
     * @param name - 指标名
     * @param value - 观测值
     */
    observe(name: string, value: number): void {
        if (!this.enabled) return;

        const histogram = this.histograms.get(name);
        if (!histogram) return;

        histogram.values.push(value);
    }

    // ─── Gauge (仪表) ───

    /**
     * 设置仪表值
     * @param name - 指标名
     * @param value - 当前值
     */
    set(name: string, value: number): void {
        if (!this.enabled) return;

        const gauge = this.gauges.get(name);
        if (!gauge) return;

        gauge.value = value;
    }

    // ─── 快照导出 ───

    /**
     * 导出当前所有指标的聚合快照
     * @returns MetricsSnapshot
     */
    getSnapshot(): MetricsSnapshot {
        return {
            counters: Array.from(this.counters.values()),
            histograms: Array.from(this.histograms.values()),
            gauges: Array.from(this.gauges.values()),
        };
    }

    /**
     * 计算直方图的分位数
     * @param name - 指标名
     * @param percentile - 分位 (0-100)
     */
    getPercentile(name: string, percentile: number): number {
        const histogram = this.histograms.get(name);
        if (!histogram || histogram.values.length === 0) return 0;

        const sorted = [...histogram.values].sort((a, b) => a - b);
        const index = Math.ceil((percentile / 100) * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    }

    /**
     * 重置所有指标
     */
    reset(): void {
        this.counters.clear();
        this.histograms.clear();
        this.gauges.clear();
        this.registerDefaults();
    }

    // ─── 注册默认指标 ───

    private registerDefaults(): void {
        // Counters
        this.counters.set("llm.calls.total", {
            name: "llm.calls.total", help: "LLM 调用总次数", value: 0, labels: {},
        });
        this.counters.set("llm.calls.errors", {
            name: "llm.calls.errors", help: "LLM 调用错误次数", value: 0, labels: {},
        });
        this.counters.set("tool.calls.total", {
            name: "tool.calls.total", help: "工具调用总次数", value: 0, labels: {},
        });
        this.counters.set("tool.calls.errors", {
            name: "tool.calls.errors", help: "工具调用错误次数", value: 0, labels: {},
        });
        this.counters.set("recovery.attempts", {
            name: "recovery.attempts", help: "错误恢复尝试次数", value: 0, labels: {},
        });
        this.counters.set("recovery.successes", {
            name: "recovery.successes", help: "错误恢复成功次数", value: 0, labels: {},
        });

        // Histograms
        this.histograms.set("llm.latency", {
            name: "llm.latency", help: "LLM 调用延迟 (ms)",
            values: [], buckets: [100, 500, 1000, 3000, 5000, 10000, 30000],
        });
        this.histograms.set("tool.latency", {
            name: "tool.latency", help: "工具执行延迟 (ms)",
            values: [], buckets: [10, 50, 100, 500, 1000, 5000, 30000],
        });
        this.histograms.set("token.usage", {
            name: "token.usage", help: "单次 LLM 调用 Token 消耗",
            values: [], buckets: [100, 500, 1000, 5000, 10000, 50000],
        });

        // Gauges
        this.gauges.set("session.token.total", {
            name: "session.token.total", help: "当前会话总 Token 消耗", value: 0,
        });
        this.gauges.set("session.tool.rounds", {
            name: "session.tool.rounds", help: "当前会话工具调用轮次", value: 0,
        });
        this.gauges.set("session.messages.count", {
            name: "session.messages.count", help: "当前会话消息数", value: 0,
        });
    }
}
