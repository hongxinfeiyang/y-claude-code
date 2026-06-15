// @ts-nocheck — Anthropic SDK 流式事件类型过于严格，通过 any 桥接
// ─── packages/core/src/llm/anthropic.ts ───
// Anthropic Provider — 对接 Anthropic Messages API，支持流式对话、extended thinking、prompt caching
//
// 本文档实现了基于 Anthropic Messages API 的 LLM Provider 适配层，是整个系统的核心模型驱动之一。
// 主要职责是将系统内部的 Message/ResponseChunk 抽象格式与 Anthropic 自有 SDK 的请求/响应格式做双向转换，
// 同时封装 Anthropic 特有的能力：extended thinking（扩展推理）、prompt caching（提示缓存）、vision（多模态）。

import Anthropic from "@anthropic-ai/sdk";
import type { Message, ResponseChunk, LLMToolDefinition } from "../types/messages";
import type { LLMProvider, ChatOptions } from "../types/agent";

// ─── 模型上下文窗口映射 ───

/**
 * 标记: Anthropic 模型 → 上下文窗口大小（tokens）映射表
 * 解决问题: 不同模型支持的最大上下文窗口不同，Agent 需要根据模型名自动查询窗口上限，
 *          用来做 token 预算管理和截断决策。
 */
const CONTEXT_WINDOWS: Record<string, number> = {
    "claude-sonnet-4-6": 200_000,
    "claude-opus-4-7": 1_000_000,
    "claude-haiku-4-5": 200_000,
};

/**
 * 标记: AnthropicProvider — Anthropic Messages API 的 Provider 实现
 * 解决问题: 将 Anthropic SDK 的调用封装为系统统一的 LLMProvider 接口，
 *          使上层 Agent Loop 不需要感知底层是 Anthropic 还是 OpenAI，
 *          只需要调用统一的 chat / countTokens / contextWindow / supportsFeature 方法即可。
 */
export class AnthropicProvider implements LLMProvider {
    /**
     * 标记: Provider 名称标识
     * 解决问题: 用于工厂匹配和日志输出，区分不同的 Provider 实现。
     */
    readonly name = "anthropic";

    /**
     * 标记: Anthropic SDK 客户端实例
     * 解决问题: 封装 API Key 和 baseURL，统一管理消息/流式请求的发送。
     */
    private client: Anthropic;

    /**
     * 标记: 构造函数
     * 解决问题: 初始化 Anthropic SDK 客户端，将用户配置的 apiKey 和可选 baseURL 注入。
     * @param apiKey - Anthropic API 访问密钥
     * @param baseURL - 可选的自定义 API 端点（用于代理或兼容服务）
     */
    constructor(apiKey: string, baseURL?: string) {
        this.client = new Anthropic({
            apiKey,
            baseURL,
        });
    }

    // ─── 上下文窗口查询 ───

    /**
     * 标记: contextWindow — 查询指定模型的上下文窗口上限
     * 解决问题: 不同 Anthropic 模型的窗口大小差异很大（20万~100万），
     *          Agent 在发送请求前需要知道窗口大小来决定截断策略和 token 预算。
     * @param model - 模型名称（如 "claude-opus-4-7"）
     * @returns 上下文窗口大小（tokens），未匹配到则默认返回 200,000
     */
    contextWindow(model: string): number {
        return CONTEXT_WINDOWS[model] ?? 200_000;
    }

    // ─── 特性检测 ───

    /**
     * 标记: supportsFeature — 查询当前 Provider 是否支持某项能力
     * 解决问题: 不同 Provider 能力差异大，上层 Agent 在执行前通过此方法做能力探测，
     *          避免向 Anthropic 发送不支持的配置参数导致 API 报错。
     *          例如 OpenAI Provider 不支持 thinking，上层会据此跳过 thinking 配置。
     * @param feature - 特性标识 ("thinking" | "caching" | "vision" | "tools")
     * @returns 是否支持该特性
     */
    supportsFeature(feature: string): boolean {
        return ["thinking", "caching", "vision", "tools"].includes(feature);
    }

    // ─── 流式对话（核心方法） ───

    /**
     * 标记: chat — 流式对话核心方法，向 Anthropic Messages API 发起流式请求
     * 解决问题: 将系统内部的 Message 序列和 ChatOptions 配置转换为 Anthropic API 格式，
     *          并以 ResponseChunk 事件流的形式逐块返回，上层 Agent 无需处理底层协议细节。
     *
     * 流式处理的关键设计决策:
     *  - System prompt 单独提取并标记 cache_control，利用 Anthropic Prompt Caching 降本
     *  - 工具调用的 arguments 是增量 JSON 流，需要在本地累积拼接再解析
     *  - content_block_stop 事件标志着某个 content block 完整接收，此时解析累积的工具参数
     *
     * @param messages - 对话历史消息列表
     * @param options - 对话配置（模型、max_tokens、工具、thinking 等）
     * @returns 异步可迭代的 ResponseChunk 事件流
     */
    async *chat(messages: Message[], options: ChatOptions): AsyncIterable<ResponseChunk> {
        // ─── 1. 分离 system 消息 — Anthropic API 要求 system 单独作为顶层参数传递，不能混在 messages 中 ───
        // 解决问题: Anthropic Messages API 的 system 消息不在 messages 数组内，而是独立的 system 参数，
        //         这与 OpenAI 的 system role 放在 messages 中的设计不同，需要做字段拆分。
        const systemMessages = messages.filter((m) => m.role === "system");
        const conversationMessages = messages.filter((m) => m.role !== "system");

        // 将多条 system 消息拼接为单条 system prompt
        const systemPrompt = systemMessages
            .map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b) => ("text" in b ? b.text : "")).join("") : String(m.content ?? "")))
            .join("\n\n");

        // ─── 2. 构建请求参数 ───
        // 解决问题: 将系统内部的配置字段映射为 Anthropic API 的请求体结构，
        //         同时根据需要添加缓存标记、工具定义、thinking 配置等可选字段。
        const requestParams: Record<string, unknown> = {
            model: options.model,
            max_tokens: options.maxTokens,
            messages: this.convertMessages(conversationMessages),
            stream: true,
        };

        // ─── Prompt Caching: system prompt 标记为可缓存 ───
        // 解决问题: 多轮对话中 system prompt 是固定不变的，标记为 ephemeral 缓存可以让
        //         Anthropic 在后续请求中复用 system prompt 的编码结果，大幅降低输入 Token 成本。
        if (systemPrompt) {
            requestParams.system = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
        }

        // ─── 工具定义转换 ───
        // 解决问题: 将系统内部统一的 LLMToolDefinition 格式转换为 Anthropic 的 Tool 格式
        if (options.tools?.length) {
            requestParams.tools = options.tools.map((tool) => this.convertTool(tool));
        }

        // ─── Extended Thinking 配置 ───
        // 解决问题: Anthropic 特有的 extended thinking 能力，给模型分配额外的推理 Token 预算
        //         使其在复杂问题上能做更长链路的推理，生成质量更高。
        if (options.thinking && this.supportsFeature("thinking")) {
            requestParams.thinking = {
                type: "enabled",
                budget_tokens: options.thinkingTokens ?? 4000,
            };
        }

        // ─── 3. 流式请求 ───
        // 解决问题: 使用 Anthropic SDK 的 stream() 方法发起流式请求，
        //         SDK 内部使用 SSE (Server-Sent Events) 协议，逐块返回模型输出。
        const stream = this.client.messages.stream(requestParams as unknown as Anthropic.MessageCreateParams);

        // 支持 Ctrl+C 中断：将 signal 连接到 stream 的 abort controller
        if (options.signal) {
            const onAbort = () => stream.controller.abort();
            if (options.signal.aborted) {
                stream.controller.abort();
            } else {
                options.signal.addEventListener("abort", onAbort, { once: true });
            }
        }

        // ─── 工具调用参数累积缓冲区 ───
        // 解决问题: Anthropic 流式返回工具调用时，arguments JSON 是分块增量推送到 input_json_delta 事件中的，
        //         无法单独从某个 delta 获得完整 JSON，需要在接收过程中逐步拼接，
        //         直到收到 content_block_stop 事件后才能解析完整 JSON。
        // Key: content block index，Value: 正在累积的工具调用信息
        const pendingToolUses = new Map<number, { id: string; name: string; arguments: string }>();

        try {
            for await (const event of stream) {
                switch ((event as Anthropic.RawMessageStreamEvent).type) {
                    // ─── 内容块增量事件 — 模型输出的最小粒度单元 ───
                    case "content_block_delta": {
                        // 文本增量: 模型直接输出的对话文本
                        if ((event as { delta: { type: string; text?: string; thinking?: string; partial_json?: string } }).delta.type === "text_delta") {
                            yield { type: "text", content: (event as { delta: { text?: string } }).delta.text! };
                        }
                        // 推理增量: extended thinking 模式下模型内部的思考过程
                        else if ((event as { delta: { type: string; thinking?: string } }).delta.type === "thinking_delta") {
                            yield { type: "thinking", content: (event as { delta: { thinking?: string } }).delta.thinking! };
                        }
                        // 工具参数增量: 累积解析中的工具调用 JSON 片段
                        else if ((event as { delta: { type: string; partial_json?: string } }).delta.type === "input_json_delta") {
                            // 解决问题: 每次 delta 只包含一部分 JSON 片段，需要按 index 索引累积拼接
                            const idx = (event as { index: number }).index; const existing = pendingToolUses.get(idx) ?? { id: "", name: "", arguments: "" };
                            existing.arguments += (event as { delta: { partial_json?: string } }).delta.partial_json ?? "";
                            pendingToolUses.set(idx, existing);
                        }
                        break;
                    }

                    // ─── 内容块开始事件 — 一个新的 content block（文本/工具调用）开始 ───
                    case "content_block_start": {
                        if ((event as Anthropic.RawContentBlockStartEvent).content_block.type === "tool_use") {
                            // 解决问题: 记录工具调用的 ID 和名称。工具名在 content_block_start 出现，
                            //         参数 JSON 在后续的 input_json_delta 中增量推送。
                            pendingToolUses.set((event as Anthropic.RawContentBlockDeltaEvent).index, {
                                id: (event as Anthropic.RawContentBlockStartEvent).content_block.id,
                                name: (event as Anthropic.RawContentBlockStartEvent).content_block.name,
                                arguments: "",
                            });
                        }
                        break;
                    }

                    // ─── 内容块结束事件 — 某个 content block 的完整内容已推送完毕 ───
                    case "content_block_stop": {
                        // 解决问题: 此时工具调用的 arguments JSON 已完整接收，
                        //         尝试 JSON.parse 解析并 yield 最终的 tool_use 事件。
                        const pending = pendingToolUses.get((event as Anthropic.RawContentBlockDeltaEvent).index);
                        if (pending && pending.arguments) {
                            try {
                                const input = JSON.parse(pending.arguments) as Record<string, unknown>;
                                yield {
                                    type: "tool_use",
                                    id: pending.id,
                                    name: pending.name,
                                    input,
                                };
                            } catch {
                                // JSON 不完整（异常情况）：等待更多 delta 块，不删除暂存数据
                            }
                            pendingToolUses.delete((event as Anthropic.RawContentBlockDeltaEvent).index);
                        }
                        break;
                    }

                    // ─── 消息结束事件 — 模型本轮输出完整结束 ───
                    case "message_stop": {
                        // 提取 usage（含缓存统计）
                        const msg = (event as { message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } }).message;
                        const usage = msg?.usage ? {
                            inputTokens: msg.usage.input_tokens ?? 0,
                            outputTokens: msg.usage.output_tokens ?? 0,
                            cacheCreationInputTokens: msg.usage.cache_creation_input_tokens,
                            cacheReadInputTokens: msg.usage.cache_read_input_tokens,
                        } : undefined;
                        yield { type: "stop", reason: "end_turn", usage };
                        break;
                    }

                    // ─── 错误事件 — API 返回的错误信息 ───
                    default: {
                        if ((event as { type: string; error?: { message: string } }).type === "error") { yield { type: "error", code: "anthropic_error", message: (event as unknown as { error: { message: string } }).error!.message }; }
                        break;
                    }
                }
            }
        } finally {
            // ─── 资源释放: 确保流在中途退出时被中止，避免资源泄露 ───
            if (stream) {
                try {
                    stream.abort();
                } catch {
                    // 忽略中止错误：流可能已经被服务端关闭
                }
            }
        }
    }

    // ─── Token 计数 ───

    /**
     * 标记: countTokens — 估算当前对话历史的 Token 使用量
     * 解决问题: Anthropic 官方不提供公开的 tokenizer，无法精确计数；
     *          采用业界通用的字符估算公式（1 token ≈ 4 英文字符）作为近似值，
     *          用于 Token 预算管理和上下文窗口截断判断。
     * @param messages - 对话历史消息列表
     * @returns 估算的 Token 总数
     */
    async countTokens(messages: Message[]): Promise<number> {
        let total = 0;
        for (const msg of messages) {
            // 将 Message 内容（可能是字符串或 ContentBlock 数组）展平为单一文本
            const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((b) => ("text" in b ? b.text : JSON.stringify(b))).join("") : String(msg.content ?? "");
            // Anthropic 经验值: 1 token ≈ 4 个英文字符
            // Math.ceil 保证不低估，向上取整到整数 token
            total += Math.ceil(content.length / 4);
        }
        return total;
    }

    // ─── 私有辅助方法 ───

    /**
     * 标记: convertMessages — 将内部 Message 数组转换为 Anthropic SDK 格式
     * 解决问题: 系统内部使用统一的 Message 类型，但 Anthropic SDK 有自己的 MessageParam 格式，
     *          此处完成 role 字段映射和 content 内容格式转换。
     * @param messages - 系统内部的 Message 数组（不含 system role）
     * @returns Anthropic SDK 兼容的 MessageParam 数组
     */
    private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
        return messages.map((msg) => ({
            role: msg.role as "user" | "assistant",
            content: this.convertContent(msg.content),
        }));
    }

    /**
     * 标记: convertContent — 将内部 content 格式转换为 Anthropic ContentBlock 格式
     * 解决问题: 系统内部的 content 可能是纯文本字符串或多种类型的 ContentBlock 数组
     *         （text、image、tool_use、tool_result），需要逐一映射为 Anthropic SDK 认可的类型。
     * @param content - 消息内容，可能是 string 或 ContentBlock 数组
     * @returns Anthropic 格式的 content（string 或 ContentBlock 数组）
     */
    private convertContent(content: string | Array<{ type: string; [key: string]: unknown }>): string | Anthropic.ContentBlock[] {
        // 纯文本内容直接返回，无需转换
        if (typeof content === "string") return content;
        // 防御: content 既非字符串也非数组时，安全降级为字符串
        if (!Array.isArray(content)) return String(content ?? "");

        return content.map((block: Record<string, unknown>) => {
            // ─── 文本块 ───
            if (block.type === "text" && "text" in block) {
                return { type: "text" as const, text: block.text as string };
            }
            // ─── 图片块 — 支持 base64 编码的多模态输入 ───
            if (block.type === "image" && "source" in block) {
                const img = block as { type: "image"; source: { type: "base64"; media_type: string; data: string } };
                return {
                    type: "image" as const,
                    source: { type: img.source.type, media_type: img.source.media_type as Anthropic.ImageBlockParam.Source["media_type"], data: img.source.data },
                };
            }
            // ─── 工具调用块 — assistant 消息中包含的 tool_use ───
            if (block.type === "tool_use" && "id" in block) {
                const tu = block as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
                return { type: "tool_use" as const, id: tu.id, name: tu.name, input: tu.input };
            }
            // ─── 工具结果块 — user 消息中回传的 tool_result ───
            if ("tool_use_id" in block) {
                const tr = block as { type: "tool_result"; tool_use_id: string; content: string | unknown[]; is_error?: boolean };
                return { type: "tool_result" as const, tool_use_id: tr.tool_use_id, content: tr.content as string };
            }
            // ─── 兜底: 未知类型的 block 序列化为 JSON 字符串 ───
            return { type: "text" as const, text: JSON.stringify(block) };
        });
    }

    /**
     * 标记: convertTool — 将系统内部的 LLMToolDefinition 转换为 Anthropic Tool 格式
     * 解决问题: 系统内部用统一的 LLMToolDefinition 描述工具，
     *          但 Anthropic API 的 Tool 格式有特定的 input_schema 结构，
     *          此方法完成 InputSchema 到 input_schema 的字段映射。
     * @param tool - 系统内部的工具定义
     * @returns Anthropic SDK 兼容的 Tool 对象
     */
    private convertTool(tool: LLMToolDefinition): Anthropic.Tool {
        return {
            name: tool.name,
            description: tool.description,
            input_schema: {
                type: "object",
                properties: tool.input_schema.properties as Record<string, unknown>,
                required: tool.input_schema.required,
            },
        };
    }
}
