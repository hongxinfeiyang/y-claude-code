// ─── packages/core/src/types/messages.ts ───
// 消息类型体系 — LLM 对话的数据结构定义
// 解决问题: 统一 Anthropic/OpenAI/DeepSeek 等不同 LLM 的消息格式
// 标记为"消息层"——Agent Loop 中流转的核心数据单元

/**
 * 消息角色
 * - system: 系统级指令，定义 AI 的行为规范
 * - user: 用户发出的消息
 * - assistant: AI 模型的回复
 */
export type MessageRole = "system" | "user" | "assistant";

/**
 * 工具调用 — LLM 推理后产出的工具执行请求
 * 标记: "LLM → Agent Loop" 的控制信号
 * 解决问题: LLM 需要告诉 Agent "我要调用某个工具，参数是这些"
 */
export interface ToolUse {
    /** 工具调用唯一标识 — 用于后续 ToolResult 关联 */
    id: string;
    /** 工具名称 — 与 Tool.name 对应 */
    name: string;
    /** 调用参数 — 由 LLM 根据 JSON Schema 生成 */
    input: Record<string, unknown>;
}

/**
 * 工具执行结果 — Agent Loop 执行完工具后返回给 LLM 的反馈
 * 标记: "Agent Loop → LLM" 的反馈信号
 * 解决问题: LLM 需要知道工具执行成功还是失败，产出是什么
 */
export interface ToolResult {
    /** 对应的 ToolUse.id — 用于关联请求和响应 */
    tool_use_id: string;
    /** 结果内容：文本或内容块数组 */
    content: string | Array<TextBlock | ImageBlock>;
    /** 是否为错误 — true 时 LLM 会尝试修正并重试 */
    is_error?: boolean;
}

/**
 * 文本内容块
 * 标记: 消息内容的基本单元
 * 解决问题: 多模态消息中需要区分文本和图片
 */
export interface TextBlock {
    type: "text";
    text: string;
}

/** 工具结果内容块 */
export interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string | Array<TextBlock | ImageBlock>;
    is_error?: boolean;
}

/**
 * 图片内容块 — 支持多模态模型 (Claude/GPT-4o)
 * 解决问题: Agent 需要"看到"图片（截图、设计稿等）才能辅助用户
 */
export interface ImageBlock {
    type: "image";
    source: {
        type: "base64";
        media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
        /** base64 编码的图像数据（不含 data:xxx;base64, 前缀） */
        data: string;
    };
}

/**
 * 消息联合类型 — LLM 对话历史中的一条消息
 * 标记: 对话原子单位
 * 解决问题: 统一 system/user/assistant 三种角色的消息格式
 */
export type Message =
    | { role: "system"; content: string | Array<TextBlock> }
    | { role: "user"; content: string | Array<TextBlock | ImageBlock> }
    | {
          role: "assistant";
          content: string | Array<TextBlock | ToolUse>;
      }
    | {
          role: "user";
          content: Array<ToolResultBlock>;
      };

// ─── LLM 流式响应块 — 实时增量返回的数据单元 ───

/**
 * LLM 流式返回的增量数据单元
 * 标记: "Provider → Agent Loop" 的流式事件
 * 解决问题: LLM 响应可能很慢（数秒到数十秒），通过流式 chunk 让用户实时看到输出进度
 */
export type ResponseChunk =
    | { type: "text"; content: string }
    | { type: "tool_use"; id: string; name: string; input: Partial<Record<string, unknown>> }
    | { type: "thinking"; content: string }          // Anthropic extended thinking
    | { type: "stop"; reason: "end_turn" | "max_turns" | "tool_use"; usage?: { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number } }
    | { type: "error"; code: string; message: string };

/**
 * Token 用量统计
 * 标记: 成本控制的数据基础
 * 解决问题:
 *   1. 跟踪每次 LLM 调用的 token 消耗（计费依据）
 *   2. cacheCreationInputTokens / cacheReadInputTokens 用于计算 Anthropic Prompt Cache 命中率
 */
export interface TokenUsage {
    /** 输入 token 数 */
    inputTokens: number;
    /** 输出 token 数 */
    outputTokens: number;
    /** Prompt Cache 新写入 token 数 (Anthropic) — 写入缓存有 25% 加价 */
    cacheCreationInputTokens?: number;
    /** Prompt Cache 命中读取 token 数 (Anthropic) — 缓存读取有 90% 折扣 */
    cacheReadInputTokens?: number;
}

/**
 * LLM 工具定义格式 — 发送给 LLM 的工具描述
 * 标记: "Agent → LLM" 的能力声明
 * 解决问题: LLM 需要知道有哪些工具可用、各自的参数格式是什么
 */
export interface LLMToolDefinition {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
}
