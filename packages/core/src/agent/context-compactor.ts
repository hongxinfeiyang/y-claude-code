// ─── packages/core/src/agent/context-compactor.ts ───
// ContextCompactor — 上下文压缩
// 解决问题: 将消息历史压缩逻辑从 AgentLoop 中抽离。
//          支持 Summarizer 语义摘要降级和简单截断两种模式。
//          抽离原因: 压缩策略可能演进（如增加滑动窗口、智能选择保留消息），
//          独立模块便于替换和测试。

import type { Message } from "../types/messages";
import type { Summarizer } from "../context/summarizer";

export class ContextCompactor {
    /**
     * 压缩消息历史以回收 Token
     *
     * 为什么保留 system 消息: system prompt 定义 AI 的行为规范和角色，
     * 删除后 Agent 行为可能退化，必须完整保留。
     *
     * 为什么保留最近 50% 而非固定数量:
     *   对话越长，近期上下文越重要。固定数量（如保留最近 10 条）在短对话中
     *   可能保留过多，在长对话中可能保留不足。比例策略自适应。
     *
     * 为什么 Summarizer 优先: LLM 生成的语义摘要比纯文本截断保留了更多信息
     *   （如关键决策、文件路径、错误信息），降级到简单截断仅作兜底。
     *
     * @param messages - 当前完整消息列表
     * @param summarizer - 可选的 LLM 摘要器
     * @returns 压缩后的消息列表
     */
    compact(messages: Message[], summarizer?: Summarizer): Message[] {
        // system 消息必须保留 — 它是 AI 的行为宪章
        const systemMessages = messages.filter((m) => m.role === "system");
        // 非 system 消息（user + assistant + tool_result）参与压缩
        const nonSystemMessages = messages.filter((m) => m.role !== "system");

        // 非系统消息不足 3 条时不压缩 — 压缩后只剩占位符没有意义
        if (nonSystemMessages.length <= 2) {
            return messages;
        }

        // 保留后 50%，最少 2 条（保证 LLM 有最低限度的近期上下文）
        const keepCount = Math.max(2, Math.floor(nonSystemMessages.length / 2));
        const kept = nonSystemMessages.slice(-keepCount);

        // 生成压缩摘要
        let summaryContent: string;
        const accumulatedSummary = summarizer?.getAccumulatedSummary();
        if (accumulatedSummary) {
            // Summarizer 可用 — 使用语义摘要（包含关键决策、文件路径等）
            summaryContent = `[上下文压缩]: 省略了 ${nonSystemMessages.length - keepCount} 条历史消息。\n以下是之前对话的摘要:\n${accumulatedSummary}`;
        } else {
            // Summarizer 不可用 — 降级为简单占位符
            summaryContent = `[上下文压缩]: 省略了 ${nonSystemMessages.length - keepCount} 条历史消息`;
        }

        const summaryMessage: Message = {
            role: "user",
            // 为什么用 user 角色: system 角色在多数 LLM 中只有一条，
            // 压缩摘要作为用户消息插入可被 LLM 正常处理。
            content: summaryContent,
        };

        return [...systemMessages, summaryMessage, ...kept];
    }
}
