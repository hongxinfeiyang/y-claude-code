// ─── packages/core/src/context/summarizer.ts ───
// 渐进式摘要生成器 — LLM 驱动的对话历史压缩
// 解决问题: 用 LLM 生成语义摘要替代文本截断，在回收 Token 的同时保留关键信息
//
// 核心策略:
//   1. 分块处理: 将旧消息分成固定大小的块，每块独立调用 LLM 生成摘要
//   2. 渐进式合并: 已有摘要 + 新消息块 → LLM → 合并后的摘要（支持无限长对话）
//   3. 摘要自压缩: 摘要本身超过上限时，对摘要再做一次压缩
//   4. 失败回退: LLM 摘要失败时自动降级为文本截断，确保可用性

import type { Message } from "../types/messages";
import type { LLMProvider } from "../types/agent";
import type { Logger } from "../types/tools";

// ─── 摘要配置 ───

export interface SummarizeConfig {
    /** 是否启用 LLM 驱动摘要，默认 true */
    enabled: boolean;
    /** 消息 token 占上下文窗口比例超过此值则触发摘要，默认 0.70 */
    threshold: number;
    /** 每次 LLM 摘要调用处理的消息条数，默认 20 */
    chunkSize: number;
    /** 始终保留的最近消息条数（不被摘要），默认 10 */
    recentPreserveCount: number;
    /** 单次摘要 LLM 调用的输出 token 上限，默认 2000 */
    summaryMaxTokens: number;
    /** 摘要文本累积的最大 token 数，超过则自压缩，默认 8000 */
    maxSummaryTokens: number;
    /** 是否启用渐进式合并（将新消息与已有摘要合并），默认 true */
    progressiveMerge: boolean;
}

export const DEFAULT_SUMMARIZE_CONFIG: SummarizeConfig = {
    enabled: true,
    threshold: 0.70,
    chunkSize: 20,
    recentPreserveCount: 10,
    summaryMaxTokens: 2000,
    maxSummaryTokens: 8000,
    progressiveMerge: true,
};

// ─── 摘要专用 System Prompt ───

const SUMMARIZE_SYSTEM_PROMPT = `你是一个对话摘要生成器。请将以下对话片段压缩为简洁的信息摘要。

规则:
1. 保留所有关键决策、代码变更、错误信息和用户明确指令
2. 保留文件路径、函数名、技术术语等精确信息
3. 省略闲聊、重复确认和过程性描述
4. 用中文输出
5. 格式: 每条关键信息一行，以 "- " 开头`;

/**
 * 摘要生成器 — 使用 LLM 将对话历史压缩为语义摘要
 *
 * 解决问题:
 *   1. 文本截断丢失语义 → LLM 理解对话内容后生成高质量摘要
 *   2. 长对话 token 爆炸 → 分块摘要 + 渐进式合并支持无限长对话
 *   3. 摘要本身膨胀 → 自压缩机制保持摘要大小可控
 */
export class Summarizer {
    private config: SummarizeConfig;
    private logger?: Logger;

    /** 当前累积的摘要文本（用于渐进式合并） */
    private accumulatedSummary: string = "";

    /** 已摘要过的消息数量（用于判断是否需要增量合并） */
    private summarizedCount: number = 0;

    constructor(config?: Partial<SummarizeConfig>, logger?: Logger) {
        this.config = { ...DEFAULT_SUMMARIZE_CONFIG, ...config };
        this.logger = logger;
    }

    /**
     * 判断是否需要对消息历史进行摘要
     * 解决问题: 不等到 token 溢出才处理，而是在达到阈值时主动压缩，
     *         给 Agent 留出充足的 token 空间做有效推理
     *
     * @param messageTokens - 当前消息历史的 token 数
     * @param contextWindow - 模型上下文窗口大小
     * @returns 是否需要摘要
     */
    shouldSummarize(messageTokens: number, contextWindow: number): boolean {
        if (!this.config.enabled) return false;
        const ratio = messageTokens / contextWindow;
        return ratio >= this.config.threshold;
    }

    /**
     * 对消息历史执行渐进式摘要
     * 解决问题: 将超长的消息历史压缩为一个信息密集的摘要消息，
     *         保留最近 N 条消息原样不动以维持对话连贯性
     *
     * @param messages - 完整消息历史（含 system / user / assistant）
     * @param provider - LLM Provider（用于调用 LLM 生成摘要）
     * @param model - 当前使用的模型名
     * @returns 压缩后的消息列表: [system消息, 摘要消息, 最近消息]
     */
    async summarize(
        messages: Message[],
        provider: LLMProvider,
        model: string,
    ): Promise<Message[]> {
        const systemMessages = messages.filter((m) => m.role === "system");
        const nonSystemMessages = messages.filter((m) => m.role !== "system");

        // 消息太少，不需要摘要
        if (nonSystemMessages.length <= this.config.recentPreserveCount) {
            return messages;
        }

        // 分割: 旧消息 → 摘要处理，最近消息 → 原样保留
        const recentMessages = nonSystemMessages.slice(-this.config.recentPreserveCount);
        const oldMessages = nonSystemMessages.slice(0, -this.config.recentPreserveCount);

        // 新产生的旧消息（上次摘要后新增的）
        const newOldMessages = oldMessages.slice(this.summarizedCount);

        this.log("info", `开始摘要: 旧消息 ${oldMessages.length} 条 (新增 ${newOldMessages.length}) | 保留最近 ${recentMessages.length} 条`);

        let summaryText: string;

        try {
            if (this.config.progressiveMerge && this.accumulatedSummary && newOldMessages.length > 0) {
                // 渐进式合并: 已有摘要 + 新消息 → LLM → 合并摘要
                summaryText = await this.mergeSummary(
                    this.accumulatedSummary,
                    newOldMessages,
                    provider,
                    model,
                );
            } else if (newOldMessages.length > 0) {
                // 首次摘要或摘要已重置: 对新旧消息进行分块摘要
                const chunks = this.chunkMessages(newOldMessages, this.config.chunkSize);
                summaryText = await this.summarizeChunks(chunks, provider, model);
            } else {
                // 没有新消息需要摘要，使用已有摘要
                summaryText = this.accumulatedSummary;
            }

            // 自压缩: 摘要过长则对摘要本身再做摘要
            const estimatedTokens = Math.ceil(summaryText.length / 2); // 中文约 2 字符/token
            if (estimatedTokens > this.config.maxSummaryTokens) {
                this.log("info", `摘要过长 (约 ${estimatedTokens} tokens)，触发自压缩`);
                summaryText = await this.selfCompress(summaryText, provider, model);
            }

            // 更新累积状态
            this.accumulatedSummary = summaryText;
            this.summarizedCount = oldMessages.length;

        } catch (error) {
            // 摘要失败 → 降级为文本截断
            this.log("warn", `LLM 摘要失败，降级为文本截断: ${error instanceof Error ? error.message : String(error)}`);
            summaryText = this.fallbackTextSummary(oldMessages);
        }

        // 构建摘要消息
        const summaryMessage: Message = {
            role: "user",
            content: `[对话历史摘要]: 以下是对之前 ${oldMessages.length} 条对话的概括:\n${summaryText}`,
        };

        this.log("info", `摘要完成: 原始 ${oldMessages.length} 条 → 约 ${Math.ceil(summaryText.length / 2)} tokens`);

        return [...systemMessages, summaryMessage, ...recentMessages];
    }

    /**
     * 重置累积的摘要状态（用于新会话）
     */
    reset(): void {
        this.accumulatedSummary = "";
        this.summarizedCount = 0;
    }

    /**
     * 获取当前的累积摘要文本（用于紧急压缩场景，如 CONTEXT_OVERFLOW）
     */
    getAccumulatedSummary(): string {
        return this.accumulatedSummary;
    }

    // ─── 内部方法 ───

    /**
     * 将消息列表切分为固定大小的块
     */
    private chunkMessages(messages: Message[], chunkSize: number): Message[][] {
        const chunks: Message[][] = [];
        for (let i = 0; i < messages.length; i += chunkSize) {
            chunks.push(messages.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * 逐块调用 LLM 生成摘要，最后合并所有块的摘要
     */
    private async summarizeChunks(
        chunks: Message[][],
        provider: LLMProvider,
        model: string,
    ): Promise<string> {
        const chunkSummaries: string[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkText = this.messagesToText(chunk);
            const summary = await this.callLLMForSummary(
                chunkText,
                provider,
                model,
                `请摘要以下对话片段 (第 ${i + 1}/${chunks.length} 部分):`,
            );
            chunkSummaries.push(summary);
        }

        // 只有一块，直接返回
        if (chunkSummaries.length === 1) {
            return chunkSummaries[0];
        }

        // 多块: 对摘要列表再做一次摘要
        const combinedSummaries = chunkSummaries
            .map((s, i) => `## 第 ${i + 1} 部分摘要\n${s}`)
            .join("\n\n");

        return await this.callLLMForSummary(
            combinedSummaries,
            provider,
            model,
            "请将以下多段摘要合并为一个完整的对话摘要:",
        );
    }

    /**
     * 渐进式合并: 已有摘要 + 新消息 → 合并后的摘要
     */
    private async mergeSummary(
        existingSummary: string,
        newMessages: Message[],
        provider: LLMProvider,
        model: string,
    ): Promise<string> {
        const newText = this.messagesToText(newMessages);
        const prompt = `以下是已有的对话摘要:\n${existingSummary}\n\n以下是新的对话内容:\n${newText}\n\n请将新内容合并到已有摘要中，生成一个更新后的完整摘要。`;

        return await this.callLLMForSummary(prompt, provider, model);
    }

    /**
     * 对摘要自身进行压缩（摘要太长了）
     */
    private async selfCompress(
        summary: string,
        provider: LLMProvider,
        model: string,
    ): Promise<string> {
        return await this.callLLMForSummary(
            summary,
            provider,
            model,
            "请将以下摘要进一步压缩，只保留最关键的信息:",
        );
    }

    /**
     * 调用 LLM 生成摘要
     * 解决问题: 使用独立的轻量 LLM 调用来做摘要，不污染主对话上下文
     */
    private async callLLMForSummary(
        content: string,
        provider: LLMProvider,
        model: string,
        instruction?: string,
    ): Promise<string> {
        const userContent = instruction
            ? `${instruction}\n\n${content}`
            : content;

        const messages: Message[] = [
            { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
            { role: "user", content: userContent },
        ];

        try {
            const chunks = provider.chat(messages, {
                model,
                maxTokens: this.config.summaryMaxTokens,
                temperature: 0, // 确定性输出，保证摘要质量稳定
            });

            let summary = "";
            for await (const chunk of chunks) {
                if (chunk.type === "text") {
                    summary += chunk.content;
                } else if (chunk.type === "error") {
                    throw new Error(`摘要 LLM 调用错误 [${chunk.code}]: ${chunk.message}`);
                } else if (chunk.type === "stop") {
                    break;
                }
            }

            return summary.trim() || content.slice(0, 500); // 兜底: 返回原文前 500 字符
        } catch (error) {
            throw error; // 向上抛出，由 summarize() 的 catch 降级处理
        }
    }

    /**
     * 文本降级摘要: 当 LLM 摘要失败时使用
     * 提取每条消息的 role 和前 200 字符
     */
    private fallbackTextSummary(messages: Message[]): string {
        return messages
            .map((m) => {
                const content = typeof m.content === "string"
                    ? m.content
                    : Array.isArray(m.content)
                        ? m.content.map((b) => ("text" in b ? b.text : "[非文本数据]")).join("")
                        : String(m.content ?? "");
                return `[${m.role}] ${content.slice(0, 200)}`;
            })
            .join("\n");
    }

    /**
     * 将消息列表转换为 LLM 可读的文本格式
     */
    private messagesToText(messages: Message[]): string {
        return messages
            .map((m) => {
                const content = typeof m.content === "string"
                    ? m.content
                    : Array.isArray(m.content)
                        ? m.content.map((b) => {
                        if ("text" in b) return b.text;
                        if ("source" in b) return "[图片]";
                        if ("tool_use_id" in b) return `[工具结果: ${typeof b.content === "string" ? b.content.slice(0, 200) : "..."}]`;
                        if ("name" in b && "input" in b) return `[工具调用: ${b.name}]`;
                        return "[其他数据]";
                    }).join("")
                    : String(m.content ?? "");
                return `[${m.role}]: ${content}`;
            })
            .join("\n");
    }

    private log(level: "info" | "warn" | "error", message: string): void {
        if (this.logger) {
            this.logger.info(`[Summarizer] ${message}`);
        }
    }
}
