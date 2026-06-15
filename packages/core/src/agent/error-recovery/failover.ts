// ─── packages/core/src/agent/error-recovery/failover.ts ───
// Provider 回退管理器 — LLM Provider 故障时的自动切换
// 解决问题: 主 Provider 不可用时自动切换到备用 Provider，
//         避免单点故障导致 Agent 完全不可用
//
// 回退链: DeepSeek → Anthropic → OpenAI
//         每个 Provider 故障后依次尝试下一个，全部不可用则终止

import type { LLMProvider } from "../../types/agent";
import type { ProviderFailoverConfig } from "./types";

/**
 * Provider 回退管理器 — 管理 LLM Provider 的优先级链和故障切换
 * 解决问题: 当当前 Provider 不可用时，按优先级链自动切换到下一个可用 Provider
 */
export class ProviderFailoverManager {
    /** 已排序的 Provider 列表 */
    private providers: LLMProvider[];
    /** 当前使用的 Provider 在列表中的索引 */
    private currentIndex: number;
    /** 模型名映射表: providerName -> { sourceModel -> targetModel } */
    private modelMapping: Record<string, Record<string, string>>;

    constructor(config: ProviderFailoverConfig) {
        if (config.providers.length === 0) {
            throw new Error("ProviderFailoverManager: providers 列表不能为空");
        }
        this.providers = config.providers;
        this.currentIndex = 0;
        this.modelMapping = config.modelMapping ?? {};
    }

    /**
     * 获取当前使用的 Provider
     */
    getCurrentProvider(): LLMProvider {
        return this.providers[this.currentIndex];
    }

    /**
     * 获取当前 Provider 的索引
     */
    getCurrentIndex(): number {
        return this.currentIndex;
    }

    /**
     * 获取当前 Provider 的名称
     */
    getCurrentProviderName(): string {
        return this.providers[this.currentIndex].name;
    }

    /**
     * 切换到下一个可用的 Provider
     * @returns 切换后的 Provider，如果所有 Provider 都已尝试则返回 null
     */
    switchToNext(): LLMProvider | null {
        this.currentIndex++;

        if (this.currentIndex >= this.providers.length) {
            return null; // 回退链耗尽
        }

        return this.providers[this.currentIndex];
    }

    /**
     * 获取当前模型在目标 Provider 中的等价模型名
     * 解决问题: 不同 Provider 的模型名不同（如 deepseek-v4-flash vs claude-sonnet-4-6），
     *         需要映射表来找到能力最接近的替代模型
     *
     * @param currentModel - 当前使用的模型名
     * @param targetProviderName - 目标 Provider 的名称
     * @returns 映射后的模型名，如果没有映射则返回原模型名
     */
    mapModel(currentModel: string, targetProviderName: string): string {
        // 从当前 Provider 的映射表查找
        const currentProviderName = this.getCurrentProviderName();
        const providerMapping = this.modelMapping[currentProviderName];
        if (providerMapping && providerMapping[currentModel]) {
            return providerMapping[currentModel];
        }

        // 从目标 Provider 的映射表查找
        const targetMapping = this.modelMapping[targetProviderName];
        if (targetMapping && targetMapping[currentModel]) {
            return targetMapping[currentModel];
        }

        // 无映射，返回原模型名（目标 Provider 可能接受相同模型名）
        return currentModel;
    }

    /**
     * 是否还有可用的备用 Provider
     */
    hasNext(): boolean {
        return this.currentIndex + 1 < this.providers.length;
    }

    /**
     * 重置回退链到第一个 Provider
     * 解决问题: 回退链耗尽后，用户可能修复了主 Provider（如重新配置 API Key），
     *         重置允许从头开始尝试
     */
    reset(): void {
        this.currentIndex = 0;
    }

    /**
     * 获取 Provider 总数
     */
    getTotalProviders(): number {
        return this.providers.length;
    }

    /**
     * 获取剩余可尝试的 Provider 数量
     */
    getRemainingCount(): number {
        return this.providers.length - this.currentIndex - 1;
    }

    /**
     * 获取完整的 Provider 列表（只读）
     */
    getProviders(): ReadonlyArray<LLMProvider> {
        return this.providers;
    }
}
