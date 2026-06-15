// @ts-nocheck — OpenAI SDK 流式类型过于复杂，通过 any 桥接
// ─── packages/core/src/llm/openai.ts ───
// OpenAI Provider — 对接 OpenAI Chat Completions API，兼容 DeepSeek 等 OpenAI 接口风格的服务
//
// 本文档实现了基于 OpenAI Chat Completions API 的 LLM Provider 适配层。
// 核心职责是将系统内部的 Message/ResponseChunk 抽象格式与 OpenAI SDK 做双向转换。
//
// 设计要点:
//  - 不仅支持 OpenAI 官方模型（GPT-4o、o3-mini 等），也兼容所有走 OpenAI 风格接口的第三方服务
//    （如 DeepSeek、OpenRouter 等），通过自定义 baseURL 实现多服务复用同一个 Provider。
//  - OpenAI 不支持 Anthropic 特有的 extended thinking 能力，supportsFeature 中不包含 "thinking"。
//  - 工具调用的 arguments 同样是流式增量推送，需要在本地累积拼装后再解析完整 JSON。

import OpenAI from "openai";
import type { Message, ResponseChunk, LLMToolDefinition } from "../types/messages";
import type { LLMProvider, ChatOptions } from "../types/agent";

// ─── 模型上下文窗口映射 ───

/**
 * 标记: OpenAI 模型 → 上下文窗口大小（tokens）映射表
 * 解决问题: 不同模型支持的最大上下文窗口不同，Agent 需要根据模型名自动查询窗口上限，
 *          用来做 token 预算管理和截断决策。
 *          DeepSeek 兼容模型也包含在此表中，因为它们复用 OpenAIProvider。
 */
const CONTEXT_WINDOWS: Record<string, number> = {
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4-turbo": 128_000,
    "o3-mini": 200_000,
    "o4-mini": 200_000,
    // DeepSeek 兼容模型 — 走 OpenAI 兼容接口
    "deepseek-chat": 128_000,
    "deepseek-reasoner": 64_000,
};

/**
 * 标记: OpenAIProvider — OpenAI Chat Completions API 的 Provider 实现
 * 解决问题: 将 OpenAI SDK 的调用封装为系统统一的 LLMProvider 接口，
 *          使上层 Agent Loop 不需要感知底层是 OpenAI、DeepSeek 还是其他兼容服务。
 */
export class OpenAIProvider implements LLMProvider {
    /**
     * 标记: Provider 名称标识
     * 解决问题: 用于工厂匹配和日志输出，区分不同的 Provider 实现。
     */
    readonly name = "openai";

    /**
     * 标记: OpenAI SDK 客户端实例
     * 解决问题: 封装 API Key 和 baseURL，统一管理 Chat Completions 请求。
     */
    private client: OpenAI;

    /**
     * 标记: 构造函数
     * 解决问题: 初始化 OpenAI SDK 客户端，默认指向 OpenAI 官方 API，
     *          同时也支持通过 baseURL 自定义端点以对接 DeepSeek 等兼容服务。
     * @param apiKey - API 访问密钥
     * @param baseURL - API 端点，默认为 "https://api.openai.com/v1"
     */
    constructor(apiKey: string, baseURL?: string) {
        this.client = new OpenAI({
            apiKey,
            baseURL: baseURL ?? "https://api.openai.com/v1",
        });
    }

    // ─── 上下文窗口查询 ───

    /**
     * 标记: contextWindow — 查询指定模型的上下文窗口上限
     * 解决问题: Agent 在发送请求前需要知道窗口大小来决定截断策略和 token 预算。
     * @param model - 模型名称（如 "gpt-4o"）
     * @returns 上下文窗口大小（tokens），未匹配到则默认返回 128,000
     */
    contextWindow(model: string): number {
        return CONTEXT_WINDOWS[model] ?? 128_000;
    }

    // ─── 特性检测 ───

    /**
     * 标记: supportsFeature — 查询当前 Provider 是否支持某项能力
     * 解决问题: OpenAI 不支持 extended thinking，上层 Agent 在执行前通过此方法做能力探测，
     *          避免向 OpenAI 发送 thinking 配置导致 API 报错。
     *          OpenRouter / DeepSeek 等兼容端点也使用同一个 Provider，能力集相同。
     * @param feature - 特性标识
     * @returns OpenAI Provider 支持 "vision" 和 "tools"，不支持 "thinking" 和 "caching"
     */
    supportsFeature(feature: string): boolean {
        // OpenAI 不支持 Anthropic 风格的 extended thinking 和 prompt caching
        return ["vision", "tools"].includes(feature);
    }

    // ─── 流式对话（核心方法） ───

    /**
     * 标记: chat — 流式对话核心方法，向 OpenAI Chat Completions API 发起流式请求
     * 解决问题: 将系统内部的 Message 序列和 ChatOptions 配置转换为 OpenAI 格式，
     *          并以 ResponseChunk 事件流的形式逐块返回，兼容 OpenAI 和 DeepSeek 等接口。
     *
     * 与 Anthropic Provider 的差异:
     *  - system 消息在 messages 数组中以 system role 传递，无需单独提取
     *  - 不支持 thinking 事件，只有 text 和 tool_use
     *  - 工具调用增量通过 delta.tool_calls 传递，arguments 同样需要累积拼接
     *  - finish_reason 用于判断本轮对话是否结束
     *
     * @param messages - 对话历史消息列表
     * @param options - 对话配置（模型、max_tokens、温度、工具等）
     * @returns 异步可迭代的 ResponseChunk 事件流
     */
    async *chat(messages: Message[], options: ChatOptions): AsyncIterable<ResponseChunk> {
        // 发起流式 Chat Completions 请求
        const stream = await this.client.chat.completions.create({
            model: options.model,
            max_tokens: options.maxTokens,
            temperature: options.temperature ?? 0.7,
            messages: this.convertMessages(messages),
            tools: options.tools?.length ? options.tools.map((t) => this.convertTool(t)) : undefined,
            stream: true,
        });

        // 支持 Ctrl+C 中断：将 signal 连接到 stream 的 abort controller
        if (options.signal) {
            const onAbort = () => stream.controller.abort();
            if (options.signal.aborted) {
                stream.controller.abort();
            } else {
                options.signal.addEventListener("abort", onAbort, { once: true });
            }
        }

        // ─── 工具调用累积缓冲区 ───
        // 解决问题: OpenAI 流式返回工具调用时，function.name 和 function.arguments 是分片增量推送的，
        //         每次 delta 只包含一个片段，需要在接收过程中逐步累积拼接，
        //         直到 arguments 接收完整（以 "}" 结尾）后才解析完整 JSON 并 yield tool_use 事件。
        // Key: tool_calls index，Value: 正在累积的工具调用信息
        const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

        try {
            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;
                if (!delta) continue;

                // ─── 文本增量 — 模型直接输出的对话文本 ───
                if (delta.content) {
                    yield { type: "text", content: delta.content };
                }

                // ─── 推理内容 — DeepSeek 等推理模型的思考过程 ───
                // 解决问题: deepseek-v4-flash 等推理模型将文本输出到 delta.reasoning_content
                //         而非 delta.content，需单独处理以确保输出不丢失
                const reasoningContent = (delta as Record<string, unknown>).reasoning_content;
                if (reasoningContent) {
                    yield { type: "thinking", content: reasoningContent as string };
                }

                // ─── 工具调用参数累积 ───
                // 解决问题: tool_calls 数组中的每个元素可能只携带部分字段
                //         （首次出现时包含 id 和 function.name，后续只包含 function.arguments），
                //         需要按 index 做增量补充而非替换。
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const index = tc.index;
                        // 从缓冲区取出已有的累积数据，或初始化空对象
                        const existing = pendingToolCalls.get(index) ?? { id: "", name: "", arguments: "" };

                        // 逐字段增量补充：id 通常只在首个 delta 出现
                        if (tc.id) existing.id = tc.id;
                        // function.name 可能需要跨多个 delta 拼接（虽然实际很少见）
                        if (tc.function?.name) existing.name += tc.function.name;
                        // function.arguments 是核心累积字段，每次 delta 追加 JSON 片段
                        if (tc.function?.arguments) existing.arguments += tc.function.arguments;

                        pendingToolCalls.set(index, existing);

                        // ─── 完整性检测: 当 arguments 以 "}" 结尾时，认为 JSON 对象已完整 ───
                        // 解决问题: OpenAI 没有类似 Anthropic 的 content_block_stop 事件，
                        //         只能通过检测 JSON 结尾字符来判断参数是否接收完整。
                        if (existing.id && existing.name && existing.arguments.endsWith("}")) {
                            try {
                                const input = JSON.parse(existing.arguments) as Record<string, unknown>;
                                yield {
                                    type: "tool_use",
                                    id: existing.id,
                                    name: existing.name,
                                    input,
                                };
                                pendingToolCalls.delete(index);
                            } catch {
                                // JSON 解析失败（多层嵌套 "}" 可能提前触发）：
                                // 不删除缓冲区，继续等待更多增量
                            }
                        }
                    }
                }

                // ─── 流结束检测 ───
                // 解决问题: finish_reason 标志着 Chat Completion 的结束原因，
                //         据此判断是自然结束、工具调用触发还是长度截断。
                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason === "stop" || finishReason === "tool_calls") {
                    // stop: 模型自然结束回答 | tool_calls: 模型请求调用工具
                    yield { type: "stop", reason: finishReason === "tool_calls" ? "tool_use" : "end_turn" };
                } else if (finishReason === "length") {
                    // length: 达到 max_tokens 上限被截断
                    yield { type: "stop", reason: "max_tokens" };
                }
            }
        } catch (error) {
            // ─── 异常处理: 将 OpenAI SDK 抛出的异常转换为统一的 error 事件 ───
            // 解决问题: 网络错误、API 限流、服务端错误等异常需要统一格式传递给上层
            yield {
                type: "error",
                code: "openai_error",
                message: error instanceof Error ? error.message : "OpenAI API 调用失败",
            };
        }
    }

    // ─── Token 计数 ───

    /**
     * 标记: countTokens — 估算当前对话历史的 Token 使用量
     * 解决问题: 采用字符估算法作为快速近似值；生产环境建议使用 tiktoken 进行精确计数，
     *          此处提供轻量级回退方案，不依赖外部 wasm 模块。
     * @param messages - 对话历史消息列表
     * @returns 估算的 Token 总数
     */
    async countTokens(messages: Message[]): Promise<number> {
        let total = 0;
        for (const msg of messages) {
            // 将 Message 内容展平为单一文本
            const content = typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                    ? msg.content.map((b) => ("text" in b ? b.text : JSON.stringify(b))).join("")
                    : String(msg.content ?? "");
            // OpenAI 经验值: 1 token ≈ 4 个英文字符
            total += Math.ceil(content.length / 4);
        }
        return total;
    }

    // ─── 私有辅助方法 ───

    /**
     * 标记: convertMessages — 将内部 Message 数组转换为 OpenAI SDK 格式
     * 解决问题: 系统内部使用统一的 Message 类型，但 OpenAI SDK 的 ChatCompletionMessageParam
     *          格式对不同 role 有不同的字段要求（system/user 只有 content，assistant 还有 tool_calls），
     *          此处按 role 分情况处理。
     * @param messages - 系统内部的 Message 数组
     * @returns OpenAI SDK 兼容的 ChatCompletionMessageParam 数组
     */
    private convertMessages(messages: Message[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

        for (const msg of messages) {
            // ─── system 消息: 纯文本，不支持多模态 ───
            if (msg.role === "system") {
                result.push({
                    role: "system",
                    content: typeof msg.content === "string"
                        ? msg.content
                        : Array.isArray(msg.content)
                            ? msg.content.map((b) => ("text" in b ? b.text : "")).join("")
                            : String(msg.content ?? ""),
                });
                continue;
            }

            // ─── user 消息: 可能包含 tool_result 块（Anthropic 格式）───
            // 解决问题: AgentLoop 将工具结果以 Anthropic 格式打包在 user 消息中
            //         （role: "user", content: [{ type: "tool_result", ... }]），
            //         OpenAI API 要求每个工具结果是独立的 role: "tool" 消息，
            //         此处做拆分转换。
            if (msg.role === "user") {
                if (typeof msg.content === "string") {
                    result.push({ role: "user", content: msg.content });
                    continue;
                }
                // 防御: content 既非字符串也非数组时，安全降级为字符串
                if (!Array.isArray(msg.content)) {
                    result.push({ role: "user", content: String(msg.content ?? "") });
                    continue;
                }
                // 分离 tool_result 块和普通内容块（text / image）
                const toolResults = msg.content.filter((b) => b.type === "tool_result");
                const otherBlocks = msg.content.filter((b) => b.type !== "tool_result");

                // 每个 tool_result 转为独立的 role: "tool" 消息
                for (const tr of toolResults) {
                    const trData = tr as { tool_use_id: string; content: string | Array<{ type: string; text?: string; [key: string]: unknown }>; is_error?: boolean };
                    // 将工具结果内容展平为字符串 — OpenAI API 要求 tool 消息的 content 必须是 string
                    const trContent = typeof trData.content === "string"
                        ? trData.content
                        : Array.isArray(trData.content)
                            ? trData.content.map((b) => ("text" in b ? b.text : JSON.stringify(b))).join("")
                            : String(trData.content ?? "");
                    result.push({
                        role: "tool",
                        tool_call_id: trData.tool_use_id,
                        content: trContent,
                    });
                }

                // 非 tool_result 的普通内容块保留为 user 消息
                if (otherBlocks.length > 0) {
                    result.push({
                        role: "user",
                        content: this.convertUserContent(otherBlocks),
                    });
                }
                continue;
            }

            // ─── assistant 消息: 可能包含 tool_use 工具调用 ───
            if (typeof msg.content === "string") {
                result.push({ role: "assistant", content: msg.content });
                continue;
            }
            // 防御: content 既非字符串也非数组时，安全降级为字符串
            if (!Array.isArray(msg.content)) {
                result.push({ role: "assistant", content: String(msg.content ?? "") });
                continue;
            }
            // 提取文本部分：assistant 消息中的纯文本块
            const textParts = msg.content
                .filter((b) => b.type === "text" && "text" in b)
                .map((b) => (b as { text: string }).text);
            // 提取工具调用部分：转换为 OpenAI 的 function call 格式
            const toolCalls = msg.content
                .filter((b) => b.type === "tool_use" && "id" in b)
                .map((b) => {
                    const tu = b as { id: string; name: string; input: Record<string, unknown> };
                    return {
                        id: tu.id,
                        type: "function" as const,
                        function: { name: tu.name, arguments: JSON.stringify(tu.input) },
                    };
                });
            result.push({
                role: "assistant",
                content: textParts.join("") || null,
                tool_calls: toolCalls.length ? toolCalls : undefined,
            });
        }

        return result;
    }

    /**
     * 标记: convertUserContent — 将多模态用户消息转换为 OpenAI ContentPart 格式
     * 解决问题: OpenAI 的 user 消息支持 text 和 image_url 两种 ContentPart，
     *          需要将内部的 image block（base64 编码）转换为 OpenAI 的 image_url 格式。
     * @param content - ContentBlock 数组，可能包含 text 和 image 类型
     * @returns OpenAI 的 ChatCompletionContentPart 数组
     */
    private convertUserContent(content: Array<{ type: string; [key: string]: unknown }>): Array<{ type: string; text?: string; image_url?: { url: string } }> {
        return content.map((block) => {
            // ─── 文本块 ───
            if (block.type === "text" && "text" in block) {
                return { type: "text", text: block.text as string };
            }
            // ─── 图片块: 转换为 OpenAI 的 image_url 格式 (data URI) ───
            if (block.type === "image" && "source" in block) {
                const img = block as unknown as { source: { media_type: string; data: string } };
                return { type: "image_url", image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` } };
            }
            // ─── 兜底: 未知类型的 block 序列化为 JSON 字符串 ───
            return { type: "text", text: JSON.stringify(block) };
        });
    }

    /**
     * 标记: convertTool — 将系统内部的 LLMToolDefinition 转换为 OpenAI function 工具格式
     * 解决问题: OpenAI 的工具定义使用 { type: "function", function: { name, description, parameters } } 结构，
     *          与 Anthropic 的 Tool 格式不同，需要做字段映射。
     * @param tool - 系统内部的工具定义
     * @returns OpenAI SDK 兼容的 ChatCompletionTool 对象
     */
    private convertTool(tool: LLMToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
        return {
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: {
                    type: "object",
                    properties: tool.input_schema.properties as Record<string, unknown>,
                    required: tool.input_schema.required,
                },
            },
        };
    }
}
