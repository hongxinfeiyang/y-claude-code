// ─── packages/core/src/observability/tracer.ts ───
// 链路追踪器 — Span 树管理
// 解决问题: 追踪 Agent 内部操作的因果链（用户输入 → LLM 调用 → 工具执行），
//         为性能根因分析和错误溯源提供结构化数据

import type { Span, TracingConfig } from "./types";

/**
 * Tracer — Span 树管理器
 * 解决问题: 创建和管理 Span 树，支持父子关系和层级嵌套，
 *         Agent Loop 通过 startSpan / endSpan 记录操作边界
 */
export class Tracer {
    private enabled: boolean;
    /** trace_id → Span 树根节点 */
    private traces: Map<string, Span> = new Map();
    /** span_id → Span (快速查找) */
    private spanIndex: Map<string, Span> = new Map();
    /** 当前活跃 Span 栈 (用于自动推断父子关系) */
    private activeSpanStack: Span[] = [];
    /** Span ID 计数器 (避免引入 uuid 依赖) */
    private idCounter: number = 0;

    constructor(config?: Partial<TracingConfig>) {
        this.enabled = config?.enabled ?? true;
    }

    /**
     * 开始一个新的 Trace（对应一次 AgentLoop.run() 调用）
     * @returns trace_id
     */
    startTrace(name: string, metadata?: Record<string, unknown>): string {
        if (!this.enabled) return "";

        const traceId = this.generateId();
        const span: Span = {
            span_id: this.generateId(),
            trace_id: traceId,
            name,
            start_time: Date.now(),
            end_time: 0,
            status: "ok",
            metadata: metadata ?? {},
            children: [],
        };

        this.traces.set(traceId, span);
        this.spanIndex.set(span.span_id, span);
        this.activeSpanStack = [span];

        return traceId;
    }

    /**
     * 在当前 Trace 下创建一个子 Span
     * 解决问题: 自动推断父 Span（栈顶 Span），无需手动传递 parent_span_id
     *
     * @param name - 操作名称（如 "llm.call", "tool.execute:bash"）
     * @param metadata - 附加信息
     * @returns span_id
     */
    startSpan(name: string, metadata?: Record<string, unknown>): string {
        if (!this.enabled || this.activeSpanStack.length === 0) return "";

        const parentSpan = this.activeSpanStack[this.activeSpanStack.length - 1];
        const span: Span = {
            span_id: this.generateId(),
            trace_id: parentSpan.trace_id,
            parent_span_id: parentSpan.span_id,
            name,
            start_time: Date.now(),
            end_time: 0,
            status: "ok",
            metadata: metadata ?? {},
            children: [],
        };

        parentSpan.children.push(span);
        this.spanIndex.set(span.span_id, span);
        this.activeSpanStack.push(span);

        return span.span_id;
    }

    /**
     * 结束当前活跃的 Span
     * @param spanId - 要结束的 Span ID（可选，默认结束栈顶 Span）
     * @param status - 结果状态
     * @param metadata - 追加的元数据
     */
    endSpan(spanId?: string, status?: "ok" | "error", metadata?: Record<string, unknown>): void {
        if (!this.enabled) return;

        let span: Span | undefined;
        if (spanId) {
            span = this.spanIndex.get(spanId);
            // 从栈中移除该 span
            const idx = this.activeSpanStack.findIndex((s) => s.span_id === spanId);
            if (idx >= 0) this.activeSpanStack.splice(idx, 1);
        } else {
            span = this.activeSpanStack.pop();
        }

        if (!span) return;

        span.end_time = Date.now();
        if (status) span.status = status;
        if (metadata) Object.assign(span.metadata, metadata);
    }

    /**
     * 结束整个 Trace（自动结束所有未结束的 Span）
     * @param traceId - Trace ID
     * @returns 完整的 Span 树
     */
    endTrace(traceId: string): Span | undefined {
        if (!this.enabled) return undefined;

        // 结束所有未结束的 Span
        while (this.activeSpanStack.length > 0) {
            this.endSpan();
        }

        const trace = this.traces.get(traceId);
        this.traces.delete(traceId);

        // 清理 spanIndex 中的引用
        if (trace) {
            this.cleanupSpanIndex(trace);
        }

        return trace;
    }

    /**
     * 获取当前 Span ID（用于 Transcript 关联）
     */
    getCurrentSpanId(): string {
        if (this.activeSpanStack.length === 0) return "";
        return this.activeSpanStack[this.activeSpanStack.length - 1].span_id;
    }

    /**
     * 获取当前 Trace ID
     */
    getCurrentTraceId(): string {
        if (this.activeSpanStack.length === 0) return "";
        return this.activeSpanStack[0].trace_id;
    }

    /**
     * 获取指定 Span 的耗时（毫秒）
     * 如果 Span 未结束，返回从开始到现在的耗时
     */
    getSpanDuration(spanId: string): number {
        const span = this.spanIndex.get(spanId);
        if (!span) return 0;
        if (span.end_time === 0) return Date.now() - span.start_time;
        return span.end_time - span.start_time;
    }

    /**
     * 重置所有 Trace 数据
     */
    reset(): void {
        this.traces.clear();
        this.spanIndex.clear();
        this.activeSpanStack = [];
    }

    // ─── 内部方法 ───

    private generateId(): string {
        this.idCounter++;
        const timestamp = Date.now().toString(36);
        const counter = this.idCounter.toString(36);
        const random = Math.random().toString(36).slice(2, 8);
        return `${timestamp}-${counter}-${random}`;
    }

    private cleanupSpanIndex(span: Span): void {
        this.spanIndex.delete(span.span_id);
        for (const child of span.children) {
            this.cleanupSpanIndex(child);
        }
    }
}
