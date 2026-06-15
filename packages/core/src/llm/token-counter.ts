// ─── packages/core/src/llm/token-counter.ts ───
// Token 计数器 + Prompt Cache 管理
//
// Token 计数器 — 多模型 token 估算，支持 tiktoken (OpenAI) 和字符估算 (Anthropic)
// Prompt Cache 管理 — 标记可缓存的 system prompt 和 tool 定义块
//
// 本文档包含两大模块:
//
// 一、Token 计数器
//   负责估算对话上下文中的 Token 消耗量，用于上下文窗口管理和截断判定。
//   提供两种计数策略:
//    - tiktoken 精确计数: 适用 OpenAI 模型，依赖 js-tiktoken 的 WASM 编码器
//    - 字符估算法: 适用于 Anthropic 等无公开 tokenizer 的模型
//
// 二、Prompt Cache 管理
//   负责标记和管理 Anthropic Prompt Caching 的相关逻辑，
//   包括缓存标记常量、缓存命中率计算和缓存统计。
//
// 设计要点:
//  - countWithTiktoken 使用动态 import 避免阻塞初始化
//  - estimateTokens 作为 tiktoken 加载失败时的优雅降级
//  - remainingTokens 预留 15% 的输出缓冲，防止回答被截断

import type { Message } from "../types/messages";

// ─── 一、Token 计数器 ───

/**
 * 标记: 模型 → 上下文窗口（tokens）映射表
 * 解决问题: 不同模型的上下文窗口大小差异很大（6.4万 ~ 100万 tokens），
 *          需要一个集中式的映射表供 Token 预算管理查询。
 */
const CONTEXT_WINDOWS: Record<string, number> = {
    // ─── Anthropic 系列 ───
    "claude-opus-4-7": 1_000_000,
    "claude-sonnet-4-6": 200_000,
    "claude-haiku-4-5": 200_000,
    // ─── OpenAI 系列 ───
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4-turbo": 128_000,
    "o3-mini": 200_000,
    "o4-mini": 200_000,
    // ─── DeepSeek 等兼容模型 ───
    "deepseek-chat": 128_000,
    "deepseek-reasoner": 64_000,
};

/**
 * 标记: 默认上下文窗口大小
 * 解决问题: 当模型名未在 CONTEXT_WINDOWS 表中匹配到时，
 *          使用此默认值避免计算错误。
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 标记: TokenCounter — 多模型 Token 计数器
 * 解决问题: 提供统一的 Token 计数接口，支持 OpenAI 的精确计数（tiktoken）
 *          和 Anthropic 的近似估算，以及上下文窗口余量计算。
 */
export class TokenCounter {
    /**
     * 标记: countWithTiktoken — 使用 tiktoken 精确计数 Token（仅 OpenAI 模型）
     * 解决问题: OpenAI 提供了 tiktoken 编码器，可以精确计算任意文本的 Token 数。
     *          使用动态 import 避免在初始化阶段加载 .wasm 文件造成启动延迟。
     *          如果 tiktoken 加载失败（浏览器环境或 CORS 问题），
     *          自动降级为 estimateTokens 字符估算。
     *
     * @param messages - 对话历史消息列表
     * @param model - 模型名称，默认 "gpt-4o"（用于选择对应的 tokenizer）
     * @returns 精确或估算的 Token 总数
     */
    async countWithTiktoken(messages: Message[], model = "gpt-4o"): Promise<number> {
        try {
            // ─── 动态导入 tiktoken ───
            // 解决问题: js-tiktoken 依赖 WASM 二进制，静态导入会影响模块初始化速度。
            //         动态 import 确保 tiktoken 只在首次调用时加载，不阻塞应用启动。
            const { encodingForModel } = await import("js-tiktoken");
            const enc = encodingForModel(model as never);
            let total = 0;

            for (const msg of messages) {
                // 将 Message 内容展平为单一文本
                const content = typeof msg.content === "string"
                    ? msg.content
                    : Array.isArray(msg.content)
                        ? msg.content.map((b) => ("text" in b ? b.text : JSON.stringify(b))).join("")
                        : String(msg.content ?? "");

                // 每条消息的格式开销（role 标识 + 分隔符等，约 4 tokens）
                total += 4 + enc.encode(content).length;
            }

            // ─── 资源释放: 手动释放 WASM 编码器内存 ───
            (enc as { free?: () => void }).free?.();
            return total;
        } catch {
            // ─── tiktoken 加载失败 → 优雅降级为字符估算 ───
            return this.estimateTokens(messages);
        }
    }

    /**
     * 标记: estimateTokens — 字符估算法 Token 计数
     * 解决问题: Anthropic 不提供公开的 tokenizer，业界普遍使用字符比例估算。
     *          经验公式: 1 token ≈ 4 英文字符（中文字符大约 1 字 ≈ 1.5~2 tokens）。
     *          每条消息额外加 4 tokens 的格式开销（role + 分隔符等）。
     *
     * @param messages - 对话历史消息列表
     * @returns 估算的 Token 总数
     */
    estimateTokens(messages: Message[]): number {
        let total = 0;

        for (const msg of messages) {
            // 将 Message 内容展平为单一文本
            const content = typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                    ? msg.content.map((b) => ("text" in b ? b.text : JSON.stringify(b))).join("")
                    : String(msg.content ?? "");
            total += 4 + Math.ceil(content.length / 4); // 每条消息 4 tokens 角色开销 + 内容 Token 估算
        }

        return total;
    }

    /**
     * 标记: getContextWindow — 获取指定模型的上下文窗口大小
     * 解决问题: 统一的窗口大小查询接口，未匹配到模型名时返回默认值。
     *
     * @param model - 模型名称
     * @returns 上下文窗口大小（tokens）
     */
    getContextWindow(model: string): number {
        return CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
    }

    /**
     * 标记: remainingTokens — 计算当前上下文窗口中剩余的可用 Token 数
     * 解决问题: Agent 在做截断决策时需要知道还能容纳多少 Token。
     *          默认预留 15% 的窗口给模型输出（outputReserve），
     *          防止所有 Token 都用于输入导致回答被截断。
     *
     * @param usedTokens - 已使用的 Token 数
     * @param model - 模型名称（用于查询窗口上限）
     * @param outputReserve - 输出预留比例，默认 0.15（15%）
     * @returns 剩余可用的 Token 数
     */
    remainingTokens(usedTokens: number, model: string, outputReserve = 0.15): number {
        const window = this.getContextWindow(model);
        const reserve = Math.floor(window * outputReserve); // 输出预留量
        return window - usedTokens - reserve;
    }
}

// ─── 二、Prompt Cache 管理 ───

// 本段模块用于管理 Anthropic Prompt Caching 的相关逻辑。
// 解决问题: Anthropic 支持将重复使用的 prompt 片段（如 system prompt、tool 定义）
//   标记为可缓存，大幅降低重复请求的输入 Token 成本（缓存的读取价格远低于写入价格）。
//   此模块提供缓存标记常量、缓存命中率计算和缓存统计接口。

/**
 * 标记: CACHE_CONTROL — Anthropic Prompt Cache 的 ephemeral 类型标记
 * 解决问题: 将 cache_control: { type: "ephemeral" } 作为常量导出，
 *          供其他模块（如 AnthropicProvider）在构建请求参数时附加到 content block 上，
 *          指示 Anthropic 服务器对该内容块启用临时缓存。
 */
export const CACHE_CONTROL = { type: "ephemeral" as const };

/**
 * 标记: markCacheable — 为消息内容块添加 cache_control 标记
 * 解决问题: 在不修改原始消息结构的前提下，生成一个带有缓存标记的新对象，
 *          通常用于标记 system prompt 和 tool 定义块，使它们在多轮对话中被 Anthropic 缓存复用。
 *
 * @param block - 原始消息内容块
 * @returns 附加了 cache_control 标记的新对象
 */
export function markCacheable<T extends Record<string, unknown>>(block: T): T & { cache_control: typeof CACHE_CONTROL } {
    return { ...block, cache_control: CACHE_CONTROL };
}

/**
 * 标记: calculateCacheHitRate — 计算 Prompt Cache 的命中率
 * 解决问题: 缓存命中率是衡量缓存效果的核心指标，帮助评估缓存策略是否有效。
 *          命中率 = 缓存读取 Token 数 / (创建写入 Token 数 + 缓存读取 Token 数)
 *
 * @param cacheCreationInputTokens - 首次写入缓存的输入 Token 数
 * @param cacheReadInputTokens - 后续命中缓存的读取 Token 数
 * @returns 缓存命中率的百分比值（0-100）
 */
export function calculateCacheHitRate(
    cacheCreationInputTokens: number = 0,
    cacheReadInputTokens: number = 0,
): number {
    const total = cacheCreationInputTokens + cacheReadInputTokens;
    if (total === 0) return 0;
    return Math.round((cacheReadInputTokens / total) * 100);
}

/**
 * 标记: CacheStats — 缓存统计信息接口
 * 解决问题: 统一描述一次缓存操作的统计维度，
 *          包括写入量、命中量、命中率和节省 Token 数，
 *          供日志输出和性能分析使用。
 */
export interface CacheStats {
    /** 缓存创建写入 Token 数 — 首次将内容写入缓存的 Token 消耗 */
    creationTokens: number;
    /** 缓存命中读取 Token 数 — 后续请求中从缓存读取的 Token 数 */
    readTokens: number;
    /** 命中率百分比 — 缓存读取占总缓存操作的百分比 */
    hitRate: number;
    /** 节省的 Token 数 — 使用缓存相对于完整编码节省的 Token 数 */
    savedTokens: number;
}
