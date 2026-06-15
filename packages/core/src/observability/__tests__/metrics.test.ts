// ─── packages/core/src/observability/__tests__/metrics.test.ts ───
// MetricsCollector 单元测试

import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "../metrics";

describe("MetricsCollector", () => {
    let collector: MetricsCollector;

    beforeEach(() => {
        collector = new MetricsCollector();
    });

    // ─── Counter ───
    it("increment 应增加计数器值", () => {
        collector.increment("llm.calls.total");
        collector.increment("llm.calls.total");
        const snap = collector.getSnapshot();
        const counter = snap.counters.find((c) => c.name === "llm.calls.total");
        expect(counter?.value).toBe(2);
    });

    it("increment 应支持按标签分组", () => {
        collector.increment("tool.calls.total", "tool_name", "Read");
        collector.increment("tool.calls.total", "tool_name", "Read");
        collector.increment("tool.calls.total", "tool_name", "Bash");

        const snap = collector.getSnapshot();
        const counter = snap.counters.find((c) => c.name === "tool.calls.total");
        expect(counter?.value).toBe(3);
        expect(counter?.labels["tool_name"]["Read"]).toBe(2);
        expect(counter?.labels["tool_name"]["Bash"]).toBe(1);
    });

    // ─── Histogram ───
    it("observe 应记录观测值", () => {
        collector.observe("llm.latency", 150);
        collector.observe("llm.latency", 250);
        collector.observe("llm.latency", 350);

        const snap = collector.getSnapshot();
        const histogram = snap.histograms.find((h) => h.name === "llm.latency");
        expect(histogram?.values).toEqual([150, 250, 350]);
    });

    it("getPercentile 应正确计算分位数", () => {
        for (let i = 1; i <= 100; i++) {
            collector.observe("llm.latency", i);
        }

        // P50 = 第 50 个值
        expect(collector.getPercentile("llm.latency", 50)).toBe(50);
        // P95 = 第 95 个值
        expect(collector.getPercentile("llm.latency", 95)).toBe(95);
    });

    it("getPercentile 在无数据时应返回 0", () => {
        expect(collector.getPercentile("llm.latency", 50)).toBe(0);
    });

    // ─── Gauge ───
    it("set 应设置仪表值", () => {
        collector.set("session.token.total", 5000);
        const snap = collector.getSnapshot();
        const gauge = snap.gauges.find((g) => g.name === "session.token.total");
        expect(gauge?.value).toBe(5000);
    });

    it("重复 set 应覆盖仪表值", () => {
        collector.set("session.token.total", 5000);
        collector.set("session.token.total", 8888);
        const snap = collector.getSnapshot();
        const gauge = snap.gauges.find((g) => g.name === "session.token.total");
        expect(gauge?.value).toBe(8888);
    });

    // ─── 禁用模式 ───
    it("disabled 时 increment 不应生效", () => {
        const disabled = new MetricsCollector({ enabled: false });
        disabled.increment("llm.calls.total");
        const snap = disabled.getSnapshot();
        const counter = snap.counters.find((c) => c.name === "llm.calls.total");
        expect(counter?.value).toBe(0);
    });

    // ─── reset ───
    it("reset 应清空所有指标并恢复默认值", () => {
        collector.increment("llm.calls.total");
        collector.increment("llm.calls.total");
        collector.observe("llm.latency", 100);
        collector.set("session.token.total", 9999);

        collector.reset();

        const snap = collector.getSnapshot();
        const counter = snap.counters.find((c) => c.name === "llm.calls.total");
        expect(counter?.value).toBe(0);
        const histogram = snap.histograms.find((h) => h.name === "llm.latency");
        expect(histogram?.values).toHaveLength(0);
        const gauge = snap.gauges.find((g) => g.name === "session.token.total");
        expect(gauge?.value).toBe(0);
    });

    // ─── getSnapshot ───
    it("getSnapshot 应返回所有三类指标", () => {
        const snap = collector.getSnapshot();
        expect(snap.counters.length).toBeGreaterThan(0);
        expect(snap.histograms.length).toBeGreaterThan(0);
        expect(snap.gauges.length).toBeGreaterThan(0);
    });
});
