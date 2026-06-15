// ─── packages/core/src/llm/factory.ts ───
// Provider 工厂 — 根据用户配置动态创建 LLM Provider 实例
//
// 本文档实现了 Provider 工厂模式，是系统对接多个 LLM 服务商的入口。
// 核心职责:
//  - 根据用户配置（provider 名称 + API Key + baseURL）创建对应的 Provider 实例
//  - 统一 Anthropic、OpenAI、DeepSeek 等不同服务商的创建逻辑
//  - 提供 Provider 配置检测和列表查询，供上层设置页面使用
//
// 设计要点:
//  - AnthropicProvider 只用于 "anthropic" 标识
//  - OpenAIProvider 同时用于 "openai"、"deepseek" 以及所有未知标识
//    因为 OpenAI 的 Chat Completions 协议是事实标准，大多数第三方 LLM 服务都兼容

import type { LLMProvider } from "../types/agent";
import type { UserConfig } from "../types/config";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";

/**
 * 标记: createProvider — Provider 工厂函数
 * 解决问题: 根据用户配置中的 provider 标识（如 "anthropic"、"openai"、"deepseek"），
 *          实例化对应的 Provider 对象并返回。隐藏了具体 Provider 类的创建细节，
 *          使上层只需依赖 LLMProvider 接口，不需要知道具体实现类。
 *
 * @param config - 用户配置对象，包含 provider 选择和各 Provider 的 API Key / baseURL
 * @returns 对应类型的 LLMProvider 实例
 * @throws Error - 当指定的 Provider 未配置 API Key 时抛出异常
 */
export function createProvider(config: UserConfig): LLMProvider {
    // 当前要使用的 Provider 名称（如 "anthropic"）
    const providerName = config.provider;
    // 从 providers 配置映射表中取出该 Provider 的配置（含 apiKey 和 baseURL）
    const providerConfig = config.providers[providerName];

    // ─── 诊断日志：记录 createProvider 收到的完整配置状态 ───
    console.log("[createProvider] providerName:", providerName);
    console.log("[createProvider] config.providers type:", typeof config.providers);
    console.log("[createProvider] config.providers keys:", config.providers ? Object.keys(config.providers) : "FALSY");
    console.log("[createProvider] config.providers[providerName]:", providerConfig ? "EXISTS" : "UNDEFINED");
    if (providerConfig) {
        console.log("[createProvider] providerConfig.apiKey:", providerConfig.apiKey ? "***" + providerConfig.apiKey.slice(-4) : "MISSING");
        console.log("[createProvider] providerConfig.baseURL:", providerConfig.baseURL || "MISSING");
    }

    // ─── 配置校验: Provider 配置项不存在 ───
    if (!providerConfig) {
        const available = Object.keys(config.providers).filter((k) => config.providers[k]?.apiKey);
        const hint = available.length > 0
            ? `可用 Provider: ${available.join(", ")}。请将 "provider" 字段改为其中之一。`
            : "请运行 y-claude-code --setup 添加 Provider 配置。";
        throw new Error(`Provider "${providerName}" 未配置。${hint}`);
    }

    // ─── 配置校验: API Key 为空 ───
    if (!providerConfig.apiKey) {
        const envVar = providerName === "anthropic" ? "ANTHROPIC_API_KEY"
            : providerName === "openai" ? "OPENAI_API_KEY"
            : `${providerName.toUpperCase()}_API_KEY`;
        throw new Error(
            `Provider "${providerName}" 缺少 API Key。\n` +
            `修复: export ${envVar}="your-key" 或在 ~/.y-claude-code/config.json 中填写 providers.${providerName}.apiKey`,
        );
    }

    // ─── 根据 Provider 名称分发创建 ───
    switch (providerName) {
        case "anthropic":
            // Anthropic Provider: 使用 Anthropic Messages API
            return new AnthropicProvider(providerConfig.apiKey, providerConfig.baseURL);

        case "openai":
        // DeepSeek 使用 OpenAI 兼容接口，复用 OpenAIProvider
        // 注意: case "deepseek" 无 break，会 fall through 到 OpenAIProvider 的创建分支
        case "deepseek":
            return new OpenAIProvider(providerConfig.apiKey, providerConfig.baseURL);

        default:
            // ─── 未知 Provider: 默认尝试 OpenAI 兼容接口 ───
            // 解决问题: 许多第三方 LLM 服务（如 OpenRouter、Groq、Together AI 等）
            //         都兼容 OpenAI Chat Completions 协议格式，使用 OpenAIProvider 作为兜底，
            //         用户只需要配置对应的 baseURL 和 API Key 即可对接任意兼容服务。
            return new OpenAIProvider(providerConfig.apiKey, providerConfig.baseURL);
    }
}

/**
 * 标记: listConfiguredProviders — 列出所有已配置的 Provider 名称
 * 解决问题: 用户可能在配置中预设了多个 Provider（如同时配置了 Anthropic 和 OpenAI），
 *          此函数查询哪些 Provider 已填写 API Key（即可用），供设置界面展示选项列表。
 *
 * @param config - 用户配置对象
 * @returns 已配置且包含 API Key 的 Provider 名称数组
 */
export function listConfiguredProviders(config: UserConfig): string[] {
    // 过滤: 只返回 providers 中 apiKey 不为空的条目
    return Object.keys(config.providers).filter((name) => config.providers[name]?.apiKey);
}

/**
 * 标记: isProviderAvailable — 检测某个 Provider 是否已配置且可用
 * 解决问题: UI 或 Agent 在执行前快速判断某个指定的 Provider 是否可用，
 *          用于切换 Provider 前的可用性检查。
 *
 * @param config - 用户配置对象
 * @param name - Provider 名称标识
 * @returns true 表示该 Provider 已配置 API Key 且可用
 */
export function isProviderAvailable(config: UserConfig, name: string): boolean {
    const pc = config.providers[name];
    return !!(pc?.apiKey);
}
