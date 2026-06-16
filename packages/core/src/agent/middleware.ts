// ─── packages/core/src/agent/middleware.ts ───
// Agent 中间件管道
// 解决问题: 在 Agent 生命周期的关键节点（LLM 调用前后、工具执行前后）
//          提供可插拔的拦截器机制，用于审计、自定义限流、结果脱敏等横切关注点。
//          无需修改 AgentLoop 源码即可扩展 Agent 行为。

import type { AgentConfig } from "../types/agent";
import type { ToolUse, ToolResult } from "../types/messages";

/**
 * AgentMiddleware — Agent 生命周期拦截器接口
 *
 * 为什么所有方法都是可选的: 大多数中间件只关心特定阶段（如只做审计的中间件
 * 只需实现 afterToolExecution），强制实现全部 6 个方法会增加不必要的样板代码。
 *
 * 为什么 name 是 readonly 且必需: 管道通过 name 定位和移除中间件，
 * 无名中间件无法被 remove() 移除，会导致调试困难。
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
 *
 * 按注册顺序依次执行各中间件的对应钩子。
 *
 * 为什么是顺序执行而非并发:
 *   中间件之间可能存在依赖（如脱敏中间件应在审计中间件之前运行），
 *   顺序执行保证处理顺序可预测。
 *
 * 为什么 beforeToolExecution 支持短路阻止:
 *   安全中间件（如禁止 rm -rf）需要在执行前拦截，
 *   任一中间件返回 blocked 即终止链并阻止操作。
 */
export class MiddlewarePipeline {
    /** 已注册的中间件列表（按注册顺序） */
    private middlewares: AgentMiddleware[] = [];

    /**
     * 注册中间件
     * 为什么后注册的在末尾: 符合"先注册先执行"的直觉，便于控制中间件顺序。
     */
    use(mw: AgentMiddleware): void {
        this.middlewares.push(mw);
    }

    /**
     * 移除指定名称的中间件
     * @returns true 表示找到并移除，false 表示未找到
     */
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

    /**
     * 执行 beforeLLMCall 链
     * 为什么 config 在链中逐级传递: 每个中间件都可能修改 config
     * （如添加临时工具、修改 system prompt），修改需要传递给后续中间件。
     */
    async runBeforeLLMCall(config: AgentConfig): Promise<AgentConfig> {
        let current = config;
        for (const mw of this.middlewares) {
            if (mw.beforeLLMCall) {
                current = await mw.beforeLLMCall(current);
            }
        }
        return current;
    }

    /** 执行 afterLLMCall 链 — tool_use 列表在中间件间逐级传递并可被过滤/修改 */
    async runAfterLLMCall(toolUses: ToolUse[]): Promise<ToolUse[]> {
        let current = toolUses;
        for (const mw of this.middlewares) {
            if (mw.afterLLMCall) {
                current = await mw.afterLLMCall(current);
            }
        }
        return current;
    }

    /**
     * 执行 beforeToolExecution 链
     * 短路机制: 任一中间件返回 blocked=true 时立即停止后续中间件，
     * 确保安全策略不可被后续中间件绕过。
     */
    async runBeforeToolExecution(toolUse: ToolUse): Promise<{ blocked: boolean; reason?: string }> {
        for (const mw of this.middlewares) {
            if (mw.beforeToolExecution) {
                const result = await mw.beforeToolExecution(toolUse);
                if (result.blocked) return result;
            }
        }
        return { blocked: false };
    }

    /** 执行 afterToolExecution 链 — 结果在中间件间逐级传递并可被修改（如脱敏） */
    async runAfterToolExecution(toolUse: ToolUse, result: ToolResult): Promise<ToolResult> {
        let current = result;
        for (const mw of this.middlewares) {
            if (mw.afterToolExecution) {
                current = await mw.afterToolExecution(toolUse, current);
            }
        }
        return current;
    }

    /** 执行 afterRound 链 — 用于统计、告警等不修改状态的观察者 */
    async runAfterRound(round: number, results: ToolResult[]): Promise<void> {
        for (const mw of this.middlewares) {
            if (mw.afterRound) {
                await mw.afterRound(round, results);
            }
        }
    }
}
