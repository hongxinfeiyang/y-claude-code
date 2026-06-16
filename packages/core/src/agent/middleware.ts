// ─── packages/core/src/agent/middleware.ts ───
// Agent 中间件管道
// 解决问题: 在 Agent 生命周期的关键节点（LLM 调用前后、工具执行前后）
//          提供可插拔的拦截器机制，用于审计、自定义限流、结果脱敏等横切关注点。
//          无需修改 AgentLoop 源码即可扩展 Agent 行为。

import type { AgentConfig, TurnEvent } from "../types/agent";
import type { ToolUse, ToolResult } from "../types/messages";

/**
 * AgentMiddleware — Agent 生命周期拦截器接口
 * 所有方法均为可选，只实现需要拦截的阶段即可。
 */
export interface AgentMiddleware {
    /** 名称（用于日志和调试） */
    readonly name: string;

    /** LLM 调用前：可修改配置（如注入额外工具、修改 system prompt） */
    beforeLLMCall?(config: AgentConfig): Promise<AgentConfig>;

    /** LLM 调用后：可修改返回的 tool_use 列表（如过滤危险工具调用） */
    afterLLMCall?(toolUses: ToolUse[]): Promise<ToolUse[]>;

    /** 工具执行前：可阻止执行或修改参数 */
    beforeToolExecution?(toolUse: ToolUse): Promise<{ blocked: boolean; reason?: string }>;

    /** 工具执行后：可修改结果（如脱敏、注入审计信息） */
    afterToolExecution?(toolUse: ToolUse, result: ToolResult): Promise<ToolResult>;

    /** 轮次结束后：可用于记录统计或触发告警 */
    afterRound?(round: number, results: ToolResult[]): Promise<void>;
}

/**
 * MiddlewarePipeline — 中间件管道执行器
 * 按注册顺序依次执行各中间件的对应钩子。
 */
export class MiddlewarePipeline {
    private middlewares: AgentMiddleware[] = [];

    /** 注册中间件（后注册的在末尾） */
    use(mw: AgentMiddleware): void {
        this.middlewares.push(mw);
    }

    /** 移除指定名称的中间件 */
    remove(name: string): boolean {
        const idx = this.middlewares.findIndex((mw) => mw.name === name);
        if (idx === -1) return false;
        this.middlewares.splice(idx, 1);
        return true;
    }

    /** 列出已注册的中间件名称 */
    list(): string[] {
        return this.middlewares.map((mw) => mw.name);
    }

    /** 执行 beforeLLMCall 链 */
    async runBeforeLLMCall(config: AgentConfig): Promise<AgentConfig> {
        let current = config;
        for (const mw of this.middlewares) {
            if (mw.beforeLLMCall) {
                current = await mw.beforeLLMCall(current);
            }
        }
        return current;
    }

    /** 执行 afterLLMCall 链 */
    async runAfterLLMCall(toolUses: ToolUse[]): Promise<ToolUse[]> {
        let current = toolUses;
        for (const mw of this.middlewares) {
            if (mw.afterLLMCall) {
                current = await mw.afterLLMCall(current);
            }
        }
        return current;
    }

    /** 执行 beforeToolExecution 链（任一中间件返回 blocked 即阻止） */
    async runBeforeToolExecution(toolUse: ToolUse): Promise<{ blocked: boolean; reason?: string }> {
        for (const mw of this.middlewares) {
            if (mw.beforeToolExecution) {
                const result = await mw.beforeToolExecution(toolUse);
                if (result.blocked) return result;
            }
        }
        return { blocked: false };
    }

    /** 执行 afterToolExecution 链 */
    async runAfterToolExecution(toolUse: ToolUse, result: ToolResult): Promise<ToolResult> {
        let current = result;
        for (const mw of this.middlewares) {
            if (mw.afterToolExecution) {
                current = await mw.afterToolExecution(toolUse, current);
            }
        }
        return current;
    }

    /** 执行 afterRound 链 */
    async runAfterRound(round: number, results: ToolResult[]): Promise<void> {
        for (const mw of this.middlewares) {
            if (mw.afterRound) {
                await mw.afterRound(round, results);
            }
        }
    }
}
