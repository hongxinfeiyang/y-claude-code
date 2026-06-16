// ─── packages/core/src/agent/context-compactor.ts ───
// ContextCompactor — 上下文压缩
// 解决问题: 将消息历史压缩逻辑从 AgentLoop 中抽离。
//          支持 Summarizer 语义摘要降级和简单截断两种模式。

import type { Message } from "../types/messages";
import type { Summarizer } from "../context/summarizer";

export class ContextCompactor {
    /**
     * 压缩消息历史以回收 Token
     * 优先使用 Summarizer 的累积摘要（语义保留），
     * 未配置 Summarizer 时使用简单截断（保留 system + 最近 50%）。
     *
     * @returns 压缩后的消息列表
     */
    compact(messages: Message[], summarizer?: Summarizer): Message[] {
        const systemMessages = messages.filter((m) => m.role === "system");
        const nonSystemMessages = messages.filter((m) => m.role !== "system");

        if (nonSystemMessages.length <= 2) {
            return messages;
        }

        const keepCount = Math.max(2, Math.floor(nonSystemMessages.length / 2));
        const kept = nonSystemMessages.slice(-keepCount);

        let summaryContent: string;
        const accumulatedSummary = summarizer?.getAccumulatedSummary();
        if (accumulatedSummary) {
            summaryContent = `[上下文压缩]: 省略了 ${nonSystemMessages.length - keepCount} 条历史消息。\n以下是之前对话的摘要:\n${accumulatedSummary}`;
        } else {
            summaryContent = `[上下文压缩]: 省略了 ${nonSystemMessages.length - keepCount} 条历史消息`;
        }

        const summaryMessage: Message = {
            role: "user",
            content: summaryContent,
        };

        return [...systemMessages, summaryMessage, ...kept];
    }
}
