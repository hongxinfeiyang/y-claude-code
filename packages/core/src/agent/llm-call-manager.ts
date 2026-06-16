// ─── packages/core/src/agent/llm-call-manager.ts ───
// LLMCallManager — LLM 调用与流式响应处理
// 解决问题: 将 executeThinkingPhase 中的 LLM 流式调用、chunk 分发、
//          token 追踪、错误分类逻辑从 AgentLoop 中抽离。
//          抽离原因: 这 ~60 行流式处理逻辑与 ReAct 编排无关，
//          内嵌在 AgentLoop 中导致 executeThinkingPhase 方法职责过重。

import type { AgentConfig, TurnEvent } from "../types/agent";
import type { ToolUse, TokenUsage } from "../types/messages";
import { ErrorCategory } from "./error-recovery/types";
import type { ErrorRecoveryManager } from "./error-recovery/manager";
import type { CacheManager } from "../context/cache-manager";
import type { ContextMonitor } from "../context/monitor";
import type { Tool } from "../types/tools";

/**
 * LLMCallContext — LLM 调用所需的运行时依赖
 * 解决问题: 将 LLM 调用的配置和可选服务集中为一个参数对象，
 *          避免 streamCall 方法参数过多（6+ 个独立参数）。
 */
export interface LLMCallContext {
    /** Provider 实例（Anthropic / OpenAI） */
    provider: AgentConfig["provider"];
    /** 模型标识，如 "claude-sonnet-4-6" */
    model: string;
    /** 单轮最大输出 token 数 */
    maxTokensPerTurn: number;
    /** 是否启用 Extended Thinking */
    thinkingEnabled: boolean;
    /** Extended Thinking token 预算 */
    thinkingTokens?: number;
    /** 取消信号，用户中断时触发 */
    signal: AbortSignal;
    /** 当前可用的工具列表（Plan Mode 下已过滤为只读子集） */
    activeTools: Tool[];
    /** 错误恢复管理器（可选），用于流式 error chunk 分类 */
    errorRecoveryManager?: ErrorRecoveryManager;
    /** Prompt Cache 管理器（可选），用于更新缓存命中统计 */
    cacheManager?: CacheManager;
    /** 上下文窗口监控器（可选），用于更新 token 使用率 */
    contextMonitor?: ContextMonitor;
}

/**
 * LLMCallResult — 流式调用完成后的结构化结果
 * 解决问题: 将分散的返回值（toolUses、tokenUsage、hasError、errorCategory）
 *          收敛为一个对象，调用方一次性获取全部信息。
 */
export interface LLMCallResult {
    /** LLM 返回的工具调用列表 */
    toolUses: ToolUse[];
    /** 本次调用消耗的 token 统计 */
    tokenUsage: TokenUsage;
    /** 流式传输中是否收到过 error chunk（非抛异常，需调用方决定是否恢复） */
    hasError: boolean;
    /** 错误类别（hasError 为 true 时有值） */
    errorCategory?: ErrorCategory;
}

export class LLMCallManager {
    /**
     * 流式调用 LLM 并处理响应 chunk
     *
     * 为什么用 AsyncGenerator 而非普通 async 函数:
     *   调用方（AgentLoop）需要实时 yield text/thinking/error 事件给 UI 层，
     *   不能用 return 一次性返回，必须逐 chunk 透传。
     *
     * 为什么 tokenUsage 由调用方传入并原地修改:
     *   tokenUsage 在 AgentLoop 中跨多轮 LLM 调用累积统计（如多轮重试），
     *   不应在 LLMCallManager 内部创建新对象（会丢失之前的累积值）。
     *
     * @param messages - 当前对话上下文（含 system + history + user input）
     * @param ctx - LLM 调用所需的运行时依赖
     * @param tokenUsage - 跨轮次累积的 token 统计（原地更新）
     * @returns 结构化调用结果
     */
    async *streamCall(
        messages: import("../types/messages").Message[],
        ctx: LLMCallContext,
        tokenUsage: TokenUsage,
    ): AsyncGenerator<TurnEvent, LLMCallResult> {
        let toolUses: ToolUse[] = [];
        let hasError = false;
        let errorCategory: ErrorCategory | undefined;

        // ─── 发起 LLM 流式请求 ───
        // 为什么在这里做 toolToLLMFormat 转换: 每个 Provider 的 tool definition
        // 格式可能不同，转换逻辑属于 LLM 调用层的职责，不应由 AgentLoop 关心。
        const chunks = ctx.provider.chat(messages, {
            model: ctx.model,
            maxTokens: ctx.maxTokensPerTurn,
            tools: ctx.activeTools.map((t) => this.toolToLLMFormat(t)),
            thinking: ctx.thinkingEnabled,
            thinkingTokens: ctx.thinkingTokens,
            signal: ctx.signal,
        });

        // ─── 流式 chunk 分发 ───
        // 为什么区分 5 种 chunk 类型: LLM Provider 异步流中可能夹杂 text、
        // thinking、tool_use、stop、error 五种 chunk，需要分别处理。
        for await (const chunk of chunks) {
            switch (chunk.type) {
                case "text":
                    // 文本增量 — 直接透传给 UI 层实时展示
                    yield { type: "text", content: chunk.content };
                    break;
                case "thinking":
                    // 思考内容 — Anthropic Extended Thinking 的内部推理过程
                    yield { type: "thinking", content: chunk.content };
                    break;
                case "tool_use":
                    // 工具调用 — 累积到列表，流结束后统一返回
                    // 为什么累积而非逐个处理: 多个 tool_use 需要在同一轮 executeToolPhase
                    // 中顺序执行（保持执行顺序可预测）
                    toolUses.push({
                        id: chunk.id,
                        name: chunk.name,
                        input: chunk.input as Record<string, unknown>,
                    });
                    break;
                case "stop":
                    // 流结束信号 — 此时 usage 信息才完整，更新 token 统计和缓存/监控
                    // 为什么在 stop 而非流结束后更新: Anthropic 在最后一个 chunk
                    // （type=stop）中附带完整 usage，提前更新可让 ContextMonitor 更早感知。
                    if (chunk.usage) {
                        tokenUsage.inputTokens = chunk.usage.inputTokens;
                        tokenUsage.outputTokens = chunk.usage.outputTokens;
                        tokenUsage.cacheCreationInputTokens = chunk.usage.cacheCreationInputTokens;
                        tokenUsage.cacheReadInputTokens = chunk.usage.cacheReadInputTokens;
                        ctx.cacheManager?.updateFromUsage(tokenUsage);
                    }
                    ctx.contextMonitor?.update(tokenUsage);
                    break;
                case "error":
                    // 流式 error chunk — LLM 在流中途报告错误但不抛异常
                    // 为什么优先用 errorRecoveryManager 分类: 其内部分类逻辑与
                    // handleLLMError 共享，确保同一错误码在流式和非流式路径中被一致归类。
                    errorCategory = ctx.errorRecoveryManager?.classifyErrorCode(chunk.code)
                        ?? this.classifyByCode(chunk.code);
                    yield {
                        type: "error",
                        error: new Error(`LLM 调用错误 [${chunk.code}]: ${chunk.message}`),
                        category: errorCategory,
                    };
                    hasError = true;
                    break;
            }
        }

        return { toolUses, tokenUsage, hasError, errorCategory };
    }

    /**
     * 将内部 Tool 实例转换为 LLM API 兼容的工具定义格式
     * 为什么是私有方法: 转换细节是 LLMCallManager 内部实现，外部不应感知。
     */
    private toolToLLMFormat(tool: Tool) {
        return {
            name: tool.name,
            description: tool.description,
            input_schema: {
                type: "object" as const,
                properties: tool.parameters.properties as Record<string, unknown>,
                required: tool.parameters.required,
            },
        };
    }

    /**
     * 回退错误码分类 — 当 errorRecoveryManager 未注入时使用
     * 为什么需要回退: LLMCallManager 可能在 errorRecoveryManager 不可用的
     * 环境中被调用（如单元测试），此时仍需基本的错误码→类别映射。
     */
    private classifyByCode(code: string): ErrorCategory {
        switch (code) {
            case "rate_limit_error": case "rate_limit": return ErrorCategory.RATE_LIMIT;
            case "authentication_error": case "invalid_auth": return ErrorCategory.AUTH;
            case "invalid_request_error": return ErrorCategory.INVALID_REQUEST;
            case "context_length_exceeded": case "token_limit_exceeded": return ErrorCategory.CONTEXT_OVERFLOW;
            case "server_error": case "api_error": case "overloaded": return ErrorCategory.PROVIDER_ERROR;
            case "network_error": case "timeout": case "connection_error": return ErrorCategory.NETWORK;
            default: return ErrorCategory.PROVIDER_ERROR;
        }
    }
}
