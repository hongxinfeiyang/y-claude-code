/**
 * context/builder.ts — 上下文构建器
 *
 * 【是什么】
 *   负责将多个输入源（系统提示词、工具定义、对话历史、用户输入）拼接为完整的
 *   LLM 请求消息数组，并管理 Token 预算分配，在超限时自动触发压缩。
 *
 * 【解决什么问题】
 *   1. Token 预算管理：LLM 都有上下文窗口限制（如 200K tokens），如果无节制地
 *      把所有内容塞进去，会超出限制导致 API 调用失败或截断关键信息。
 *      本模块按比例分配 SYSTEM_PROMPT（10%）、TOOL_DEFS（5%）、MESSAGES（70%）、
 *      输出预留（15%），确保每一部分都在可控范围内。
 *   2. 历史压缩：当对话历史过长超出 messages 预算时，保留最近 N 条消息，
 *      将旧消息替换为文本摘要，避免丢失上下文的同时控制 token 消耗。
 *   3. 输入截断：对过长的 system prompt 进行 token 级截断，防止占用过多预算。
 *   4. Token 用量统计：返回 inputTokens 供上层追踪消费。
 */

import type { Message, TokenUsage } from "../types/messages";
import type { LLMProvider } from "../types/agent";
import type { Tool } from "../types/tools";
import { Summarizer, type SummarizeConfig } from "./summarizer";

/**
 * Token 预算分配比例常量
 *
 * 为什么是这个比例：
 *   - SYSTEM_PROMPT（10%）：系统提示词相对固定，不需要过大空间
 *   - TOOL_DEFS（5%）：工具定义 JSON Schema 通常不大，5% 足够
 *   - MESSAGES（70%）：对话历史是最有价值的上下文，分配最大份额
 *   - OUTPUT_RESERVE（15%）：为 LLM 的流式输出预留空间，防止输出被截断
 */
const BUDGET = {
    SYSTEM_PROMPT: 0.10, // 系统提示词最多占 10% 的上下文窗口
    TOOL_DEFS: 0.05, // 工具定义 JSON Schema 最多占 5%
    MESSAGES: 0.70, // 对话历史最多占 70%
    OUTPUT_RESERVE: 0.15, // 为 LLM 输出预留 15% 的窗口空间
};

/**
 * ContextBuilder — LLM 请求上下文组装器
 *
 * 职责：
 *   1. 将 systemPrompt、history、userInput 拼接为 messages[]
 *   2. 按 context window 大小分配各部分 token 预算
 *   3. 超预算时自动压缩历史/截断提示词
 *   4. 返回拼接好的消息数组和 token 用量统计
 *
 * 使用场景：
 *   每轮用户输入到来时，由 Agent 循环调用 build() 构造 LLM 请求体。
 */
export class ContextBuilder {
    /** LLM Provider 实例，用于获取 contextWindow 大小和计算 token 数 */
    private provider: LLMProvider;
    /** LLM 驱动摘要器（可选，未提供时使用文本降级摘要） */
    private summarizer?: Summarizer;

    /**
     * @param provider — LLMProvider 实现
     * @param summarizeConfig — LLM 驱动摘要配置（可选，传入则启用 LLM 摘要）
     */
    constructor(provider: LLMProvider, summarizeConfig?: Partial<SummarizeConfig>) {
        this.provider = provider;
        if (summarizeConfig?.enabled !== false) {
            this.summarizer = new Summarizer(summarizeConfig);
        }
    }

    /**
     * 构建完整 LLM 请求的消息数组
     *
     * 处理流程：
     *   1. 查询模型的 contextWindow 大小
     *   2. 按比例计算各区域 token 预算
     *   3. 截断过长的 systemPrompt
     *   4. 检查并压缩超预算的对话历史
     *   5. 拼接最终 messages[] 并统计 inputTokens
     *
     * @param options.systemPrompt — 系统提示词（定义 AI 角色和行为约束）
     * @param options.tools — 可用工具定义列表（会注入到 API 请求的 tools 字段）
     * @param options.history — 历史对话消息
     * @param options.userInput — 当前轮用户输入
     * @param options.model — 模型标识符（用于查询该模型的上下文窗口大小）
     * @returns messages 消息数组和 token 用量信息
     */
    async build(options: {
        systemPrompt: string;
        tools: Tool[];
        history: Message[];
        userInput: string;
        model: string;
    }): Promise<{ messages: Message[]; usage: TokenUsage }> {
        // ─── 获取模型上下文窗口大小并计算各区域预算 ───
        const contextWindow = this.provider.contextWindow(options.model);
        const budget = this.calculateBudget(contextWindow);

        const messages: Message[] = [];

        // ─── 1. System Prompt（系统提示词） ───
        // 系统提示词定义了 AI 的角色、行为准则和全局约束
        // 过长则按 token 预算截断，保留头部内容（头部通常包含最重要的指令）
        if (options.systemPrompt) {
            const truncated = await this.truncateToBudget(options.systemPrompt, budget.systemPrompt);
            messages.push({ role: "system", content: truncated });
        }

        // ─── 2. 对话历史（可能需要压缩） ───
        // 历史消息是 context 中最占 token 的部分
        // 先统计 token 数，超预算则触发 compressHistory 压缩
        let historyMessages = [...options.history];
        const historyTokens = await this.provider.countTokens(historyMessages);
        if (historyTokens > budget.messages) {
            // 触发压缩：保留最近 20 条消息（约 10 轮对话），旧消息生成摘要
            historyMessages = await this.compressHistory(historyMessages, budget.messages);
        }
        messages.push(...historyMessages);

        // ─── 3. 用户输入（当前轮） ───
        // 用户输入始终拼接到末尾，作为 LLM 需要响应的问题
        messages.push({ role: "user", content: options.userInput });

        // ─── 4. Token 用量统计 ───
        // outputTokens 初始为 0，后续由 LLM 响应更新
        const inputTokens = await this.provider.countTokens(messages);
        const usage: TokenUsage = { inputTokens, outputTokens: 0 };

        return { messages, usage };
    }

    /**
     * 按上下文窗口大小计算各区域的 token 预算
     *
     * 为什么需要预算分片：
     *   - 如果 systemPrompt 无限制地增长（如加载了大量 skill 定义），
     *     会挤压对话历史空间，导致过早触发压缩丢失有用上下文
     *   - 通过硬性预算约束，各部分互不侵占，保证核心对话历史的可用空间
     *
     * @param contextWindow — 模型的上下文窗口大小（token 数）
     * @returns 各区域的 token 上限
     */
    private calculateBudget(contextWindow: number) {
        return {
            systemPrompt: Math.floor(contextWindow * BUDGET.SYSTEM_PROMPT),
            toolDefs: Math.floor(contextWindow * BUDGET.TOOL_DEFS),
            messages: Math.floor(contextWindow * BUDGET.MESSAGES),
            outputReserve: Math.floor(contextWindow * BUDGET.OUTPUT_RESERVE),
            total: contextWindow,
        };
    }

    /**
     * 将长文本截断到指定 token 数
     *
     * 截断策略：
     *   - 采用粗略估算：英文平均 1 token ≈ 4 字符（中文 1 字符 ≈ 1 token，
     *     这里用英文估算作为上界，因为中文 token 更密集）
     *   - 保留头部内容（开头通常是最重要的规则/约束）
     *   - 末尾追加截断提示，让 LLM 知道内容被裁剪了
     *
     * @param text — 原始文本
     * @param maxTokens — 最大允许的 token 数
     * @returns 截断后的文本
     */
    private async truncateToBudget(text: string, maxTokens: number): Promise<string> {
        // 粗略估算：每 token 约 4 个英文字符
        const estimatedTokens = Math.ceil(text.length / 4);
        if (estimatedTokens <= maxTokens) return text;

        // 按比例计算截断字符数并截取头部
        const maxChars = maxTokens * 4;
        return text.slice(0, maxChars) + "\n(系统提示词已截断)";
    }

    /**
     * 压缩历史消息：保留最近 N 条，将旧消息替换为摘要
     *
     * 压缩策略:
     *   - 优先使用 LLM 驱动摘要（如果启用了 Summarizer）：分块→LLM摘要→合并
     *   - LLM 摘要失败时自动降级为文本截断
     *   - 未启用 Summarizer 时使用纯文本拼接
     *
     * @param messages — 完整的历史消息列表
     * @param maxTokens — 允许的最大 token 数
     * @returns 压缩后的消息列表（system + 摘要 + 最近消息）
     */
    private async compressHistory(messages: Message[], maxTokens: number): Promise<Message[]> {
        const RECENT_COUNT = 10;
        if (messages.length <= RECENT_COUNT) return messages;

        const recentMessages = messages.slice(-RECENT_COUNT);
        const systemMessages = messages.filter((m) => m.role === "system");

        // ─── 优先使用 LLM 驱动摘要 ───
        if (this.summarizer) {
            try {
                const model = "claude-sonnet-4-6"; // Provider 当前使用的模型，从配置中获取
                return await this.summarizer.summarize(messages, this.provider, model);
            } catch {
                // 摘要失败，降级到文本截断（在下方处理）
            }
        }

        // ─── 文本降级摘要 ───
        const oldMessages = messages.slice(0, -RECENT_COUNT);
        const summary = oldMessages
            .filter((m) => m.role !== "system")
            .map((m) => {
                const content = typeof m.content === "string"
                    ? m.content
                    : Array.isArray(m.content)
                        ? m.content.map((b) => ("text" in b ? b.text : "[工具数据]")).join("")
                        : String(m.content ?? "");
                return `[${m.role}] ${content.slice(0, 200)}`;
            })
            .join("\n");

        const summaryMessage: Message = {
            role: "user",
            content: `[对话历史摘要]: 以下是对之前对话的概括：\n${summary.slice(0, maxTokens * 4)}`,
        };

        return [...systemMessages, summaryMessage, ...recentMessages];
    }

    /**
     * 获取摘要器实例（用于外部访问，如 AgentLoop.compactMessages 场景）
     */
    getSummarizer(): Summarizer | undefined {
        return this.summarizer;
    }
}
