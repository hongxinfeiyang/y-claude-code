// ─── packages/core/src/observability/__tests__/tracer.test.ts ───
// Tracer 单元测试 — Span 树创建、父子关联、耗时计算

import { describe, it, expect, beforeEach } from "vitest";
import { Tracer } from "../tracer";

describe("Tracer", () => {
    let tracer: Tracer;

    beforeEach(() => {
        tracer = new Tracer();
    });

    // ─── startTrace / endTrace ───
    it("startTrace 应创建根 Span 并返回 trace_id", () => {
        const traceId = tracer.startTrace("agent.turn", { input: "hello" });
        expect(traceId).toBeTruthy();
        expect(tracer.getCurrentTraceId()).toBe(traceId);
    });

    it("endTrace 应返回完整 Span 树", () => {
        const traceId = tracer.startTrace("agent.turn");
        const span = tracer.endTrace(traceId);

        expect(span).toBeDefined();
        expect(span?.name).toBe("agent.turn");
        expect(span?.status).toBe("ok");
        expect(span?.end_time).toBeGreaterThan(0);
    });

    // ─── startSpan / endSpan ───
    it("startSpan 应在当前 Trace 下创建子 Span", () => {
        tracer.startTrace("agent.turn");
        const spanId = tracer.startSpan("llm.call", { model: "claude" });

        expect(spanId).toBeTruthy();
        expect(tracer.getCurrentSpanId()).toBe(spanId);
    });

    it("子 Span 应自动挂载到父 Span", () => {
        const traceId = tracer.startTrace("agent.turn");
        tracer.startSpan("llm.call");
        tracer.startSpan("tool.execute:Read");
        tracer.endSpan(); // tool.execute:Read
        tracer.endSpan(); // llm.call

        const trace = tracer.endTrace(traceId);
        expect(trace).toBeDefined();

        // agent.turn → llm.call → tool.execute:Read
        expect(trace?.children).toHaveLength(1);
        expect(trace?.children[0].name).toBe("llm.call");
        expect(trace?.children[0].children).toHaveLength(1);
        expect(trace?.children[0].children[0].name).toBe("tool.execute:Read");
    });

    it("endSpan 按指定 spanId 结束非栈顶 Span", () => {
        tracer.startTrace("agent.turn");
        const llmSpanId = tracer.startSpan("llm.call");
        const toolSpanId = tracer.startSpan("tool.execute:Bash");

        // 结束 llmSpan（非栈顶），toolSpan 自动从栈中移除
        tracer.endSpan(llmSpanId);

        // 栈顶现在是 agent.turn，再结束 agent.turn
        tracer.endSpan();
    });

    it("endSpan 应按指定 status 标记状态", () => {
        const traceId = tracer.startTrace("agent.turn");
        const spanId = tracer.startSpan("tool.execute:Bash");
        tracer.endSpan(spanId, "error", { error_code: "CMD_FAILED" });

        const trace = tracer.endTrace(traceId);
        const toolSpan = trace?.children[0];
        expect(toolSpan?.status).toBe("error");
        expect(toolSpan?.metadata.error_code).toBe("CMD_FAILED");
    });

    // ─── 耗时计算 ───
    it("getSpanDuration 应返回已结束 Span 的耗时", async () => {
        const traceId = tracer.startTrace("agent.turn");
        const spanId = tracer.startSpan("llm.call");

        // 模拟耗时操作
        await new Promise((r) => setTimeout(r, 10));

        tracer.endSpan(spanId);

        const duration = tracer.getSpanDuration(spanId);
        expect(duration).toBeGreaterThanOrEqual(10);
    });

    it("getSpanDuration 对进行中 Span 应返回实时耗时", () => {
        tracer.startTrace("agent.turn");
        const currentSpanId = tracer.getCurrentSpanId();
        const duration = tracer.getSpanDuration(currentSpanId);
        expect(duration).toBeGreaterThanOrEqual(0);
    });

    it("getSpanDuration 对不存在的 Span 应返回 0", () => {
        expect(tracer.getSpanDuration("nonexistent")).toBe(0);
    });

    // ─── 禁用模式 ───
    it("disabled 时 startTrace 应返回空字符串", () => {
        const disabled = new Tracer({ enabled: false });
        const traceId = disabled.startTrace("agent.turn");
        expect(traceId).toBe("");
    });

    it("disabled 时 endTrace 应返回 undefined", () => {
        const disabled = new Tracer({ enabled: false });
        const trace = disabled.endTrace("any");
        expect(trace).toBeUndefined();
    });

    it("disabled 时 startSpan 应返回空字符串", () => {
        const disabled = new Tracer({ enabled: false });
        disabled.startTrace("agent.turn");
        const spanId = disabled.startSpan("llm.call");
        expect(spanId).toBe("");
    });

    // ─── reset ───
    it("reset 应清空所有 Trace 数据", () => {
        const traceId = tracer.startTrace("agent.turn");
        tracer.startSpan("llm.call");
        tracer.reset();

        expect(tracer.getCurrentTraceId()).toBe("");
        expect(tracer.getCurrentSpanId()).toBe("");
    });

    // ─── getCurrentTraceId ───
    it("无活跃 Trace 时 getCurrentTraceId 应返回空字符串", () => {
        expect(tracer.getCurrentTraceId()).toBe("");
    });

    // ─── 多 Trace 互不干扰 ───
    it("多个 Trace 应互不干扰", () => {
        const trace1 = tracer.startTrace("turn-1");
        tracer.startSpan("llm.call-1");
        tracer.endSpan();
        tracer.endTrace(trace1);

        const trace2 = tracer.startTrace("turn-2");
        tracer.startSpan("llm.call-2");
        tracer.endSpan();
        const span = tracer.endTrace(trace2);

        expect(span?.name).toBe("turn-2");
        expect(span?.children[0].name).toBe("llm.call-2");
    });
});
