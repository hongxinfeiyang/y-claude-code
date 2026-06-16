/**
 * config/loader.ts — 配置加载器
 *
 * 【是什么】
 *   按多级优先级加载和合并配置文件：命令行参数 > 环境变量 > settings.local.json
 *   > settings.json > 用户配置 > 默认值。提供统一的配置读写接口。
 *
 * 【解决什么问题】
 *   1. 配置分层：不同级别的配置控制不同的覆盖粒度。
 *      用户级设定全局偏好，项目级设定项目特定参数，环境变量适配不同部署环境。
 *   2. 配置发现：通过 cosmiconfig 自动搜索多个预定义位置的配置文件，
 *      用户不需要手动指定配置路径。
 *   3. 本地覆盖：settings.local.json 允许开发者做本地调整而不污染项目共享配置
 *      （该文件在 .gitignore 中，不入版本管理）。
 *   4. 环境变量注入：CI/CD 和容器环境中，通过环境变量覆盖配置比编辑文件更方便。
 *   5. Provider 管理：支持多个 LLM Provider（Anthropic、OpenAI 等），
 *      每个 Provider 有独立的 API Key、baseURL、默认模型。
 */

import { cosmiconfig } from "cosmiconfig";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_USER_CONFIG } from "../types/config";
import type { UserConfig } from "../types/config";

/**
 * cosmiconfig 探索器 — 自动发现并加载 y-claude-code 项目级配置文件
 *
 * 注意：searchPlaces 中只放 settings.json（项目共享配置），
 * settings.local.json 在 load() 中手动处理以确保正确的合并顺序
 * （cosmiconfig 只返回第一个匹配文件，无法自动合并多个配置层）
 */
const explorer = cosmiconfig("y-claude-code", {
    searchPlaces: [
        ".y-claude/settings.json",
        ".y-claude/settings.yaml",
    ],
});

/**
 * ConfigLoader — 配置加载与访问的单例
 *
 * 为什么是单例（见文件底部的 configLoader 导出）：
 *   - 整个应用只需一份配置状态
 *   - 避免多处加载配置文件导致不一致
 *   - 方便在任意模块中 import { configLoader } 直接访问
 */
export class ConfigLoader {
    /** 当前生效的完整配置对象 */
    private config: UserConfig;

    constructor() {
        // ─── 从默认值初始化 ───
        // 深拷贝默认配置，避免后续修改污染默认值
        this.config = structuredClone(DEFAULT_USER_CONFIG);
    }

    /**
     * 从文件系统加载所有层级的配置
     *
     * 加载优先级链：默认值 < 用户配置 < 项目配置 < 本地配置 < 环境变量
     *
     * 为什么环境变量优先级最高：
     *   - 容器/Docker 部署时配置文件不可变，只能通过环境变量注入
     *   - CI 流水线中不同 job 可能需要不同配置（如不同模型），环境变量最灵活
     *   - 敏感信息（API Key）不应写入配置文件，应从环境变量读取
     *
     * @param workingDirectory — 当前工作目录（cosmiconfig 从该目录开始向上搜索）
     * @returns 合并后的完整配置
     */
    async load(workingDirectory: string): Promise<UserConfig> {
        // ─── 0. 重新初始化默认值（避免多次 load 时残留旧值） ───
        this.config = structuredClone(DEFAULT_USER_CONFIG);
        console.log("[ConfigLoader] 初始化, workingDirectory:", workingDirectory);
        console.log("[ConfigLoader] 默认 providers keys:", Object.keys(this.config.providers));

        // ─── 1. 加载用户级全局配置（最低优先级） ───
        const globalConfigPath = join(homedir(), ".y-claude-code", "config.json");
        if (existsSync(globalConfigPath)) {
            try {
                const globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8")) as Partial<UserConfig>;
                this.merge(this.config, globalConfig);
                console.log("[ConfigLoader] 已加载全局配置:", globalConfigPath);
            } catch {
                // 配置文件格式错误，忽略（由 diagnostics 报告）
            }
        }

        // ─── 2. 加载项目级共享配置 settings.json ───
        const result = await explorer.search(workingDirectory);
        console.log("[ConfigLoader] cosmiconfig 搜索结果:", result ? `找到 ${result.filepath}` : "未找到");

        // 确定项目配置目录：可能是 cosmiconfig 返回的路径，也可能只有 settings.local.json
        let configDir: string | null = null;
        if (result?.filepath) {
            configDir = dirname(result.filepath);
            console.log("[ConfigLoader] configDir (来自 cosmiconfig):", configDir);
        } else {
            // settings.json 不存在时，向上搜索 .y-claude/ 目录
            let dir = workingDirectory;
            while (dir !== "/" && dir !== ".") {
                const candidate = join(dir, ".y-claude");
                if (existsSync(candidate)) {
                    configDir = candidate;
                    console.log("[ConfigLoader] configDir (向上搜索找到):", configDir);
                    break;
                }
                dir = dirname(dir);
            }
            if (!configDir) {
                console.log("[ConfigLoader] configDir 未找到（无 .y-claude/ 目录）");
            }
        }

        if (result?.config) {
            this.merge(this.config, result.config as Partial<UserConfig>);
            console.log("[ConfigLoader] 已合并 cosmiconfig 配置, 当前 providers keys:", Object.keys(this.config.providers));
        }

        // ─── 3. 加载本地覆盖配置 settings.local.json（优先级高于 settings.json） ───
        // 解决问题: 即使 settings.json 不存在，settings.local.json 也应被加载。
        // 原逻辑依赖 result?.filepath（即 settings.json 存在），
        // 导致只配置 settings.local.json 时被静默忽略。
        //
        // 另外，当 cosmiconfig 在父目录找到 settings.json 时，configDir 指向父目录，
        // 而工作目录自身的 .y-claude/settings.local.json 会被漏掉。
        // 所以需要同时检查 configDir 和工作目录下的 .y-claude/settings.local.json。
        const localPaths = new Set<string>();
        if (configDir) {
            localPaths.add(join(configDir, "settings.local.json"));
        }
        // 始终检查工作目录自身的 .y-claude/settings.local.json
        const projectLocalPath = join(workingDirectory, ".y-claude", "settings.local.json");
        localPaths.add(projectLocalPath);
        console.log("[ConfigLoader] 检查 settings.local.json 路径:", [...localPaths]);
        for (const localPath of localPaths) {
            console.log("[ConfigLoader] 检查:", localPath, existsSync(localPath) ? "存在" : "不存在");
            if (existsSync(localPath)) {
                try {
                    const localConfig = JSON.parse(readFileSync(localPath, "utf-8")) as Partial<UserConfig>;
                    console.log("[ConfigLoader] settings.local.json 内容 keys:", Object.keys(localConfig));
                    this.merge(this.config, localConfig);
                    console.log("[ConfigLoader] 合并后 providers keys:", Object.keys(this.config.providers));
                } catch (e) {
                    console.error("[ConfigLoader] settings.local.json 解析失败:", e);
                }
            }
        }

        // ─── 4. 环境变量覆盖（最高优先级） ───
        this.applyEnvOverrides();
        console.log("[ConfigLoader] 最终 providers keys:", Object.keys(this.config.providers));
        console.log("[ConfigLoader] 最终 provider:", this.config.provider);

        return this.config;
    }

    /**
     * 获取当前完整配置对象
     *
     * @returns 当前生效的配置（注意返回的是引用，修改会影响全局）
     */
    get(): UserConfig {
        return this.config;
    }

    /**
     * 更新指定配置项
     *
     * @param key — 配置项名称
     * @param value — 新值
     */
    set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void {
        this.config[key] = value;
    }

    /**
     * 获取指定配置项的值
     *
     * @param key — 配置项名称
     * @returns 该项的当前值
     */
    getKey<K extends keyof UserConfig>(key: K): UserConfig[K] {
        return this.config[key];
    }

    /**
     * 配置 LLM Provider
     *
     * 自动行为：
     *   - 如果这是唯一已配置的 Provider，自动设为当前使用
     *   - 方便首次配置时不需要额外调用 setCurrentProvider
     *
     * @param name — Provider 名称（如 "anthropic"、"openai"）
     * @param providerConfig — Provider 配置（apiKey 必填，baseURL 和 defaultModel 可选）
     */
    setProvider(name: string, providerConfig: { apiKey: string; baseURL?: string; defaultModel?: string }): void {
        this.config.providers[name] = {
            ...this.config.providers[name], // 保留已有配置（如之前从环境变量注入的）
            ...providerConfig,
        };
        // 便捷行为：首个 Provider 自动设为当前使用
        if (Object.keys(this.config.providers).length === 1) {
            this.config.provider = name;
        }
    }

    /**
     * 切换当前使用的 LLM Provider
     *
     * 切换时自动同时切换模型：
     *   - 如果目标 Provider 有 defaultModel，自动切换
     *   - 避免用户切换 Provider 后忘记切换模型，导致使用不匹配的模型
     *
     * @param name — Provider 名称
     * @throws 如果 Provider 未配置（需先调用 setProvider）
     */
    setCurrentProvider(name: string): void {
        if (!this.config.providers[name]) {
            throw new Error(`Provider "${name}" 未配置，请先通过 setProvider 添加`);
        }
        this.config.provider = name;
        // 自动切换到该 Provider 的默认模型，保证 Provider 和 Model 匹配
        const defaultModel = this.config.providers[name].defaultModel;
        if (defaultModel) {
            this.config.model = defaultModel;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 私有方法
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 深度合并配置对象（source 覆盖 target）
     *
     * 合并策略：
     *   - 嵌套对象：递归深度合并
     *     例：providers 中的各个 Provider 配置是合并而非整体替换
     *   - 基础类型和数组：直接覆盖
     *   - undefined 值：不覆盖（保留 target 原值）
     *
     * @param target — 目标配置对象（会被修改）
     * @param source — 来源配置（优先级更高）
     */
    private merge(target: UserConfig, source: Partial<UserConfig>): void {
        for (const key of Object.keys(source) as Array<keyof UserConfig>) {
            const srcVal = source[key];
            const tgtVal = target[key];
            if (srcVal !== undefined) {
                if (this.isPlainObject(srcVal) && this.isPlainObject(tgtVal)) {
                    this.deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
                } else {
                    target[key] = srcVal as never;
                }
            }
        }
    }

    private isPlainObject(val: unknown): val is Record<string, unknown> {
        return typeof val === "object" && val !== null && !Array.isArray(val);
    }

    private deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
        for (const key of Object.keys(source)) {
            const srcVal = source[key];
            const tgtVal = target[key];
            if (srcVal !== undefined) {
                if (this.isPlainObject(srcVal) && this.isPlainObject(tgtVal)) {
                    this.deepMerge(tgtVal, srcVal);
                } else {
                    target[key] = srcVal;
                }
            }
        }
    }

    /**
     * 从环境变量覆盖配置项
     *
     * 支持的环境变量及其优先级：
     *   - ANTHROPIC_API_KEY / OPENAI_API_KEY：API 密钥（不应写入文件）
     *   - Y_CLAUDE_CODE_MODEL：覆盖模型选择
     *   - Y_CLAUDE_CODE_PROVIDER：覆盖 Provider 选择
     *   - Y_CLAUDE_CODE_MAX_ROUNDS：覆盖最大工具调用轮数
     *   - Y_CLAUDE_CODE_THINKING：开启/关闭 thinking 模式
     *
     * 为什么 API Key 通过独立的环境变量读取：
     *   - ANTHROPIC_API_KEY 和 OPENAI_API_KEY 是业界标准变量名
     *   - 与 SDK 默认使用的变量名保持一致，减少用户学习成本
     *   - 安全性：API Key 绝不应出现在配置文件中
     */
    private applyEnvOverrides(): void {
        // ─── 模型选择 ───
        if (process.env.Y_CLAUDE_CODE_MODEL) {
            this.config.model = process.env.Y_CLAUDE_CODE_MODEL;
        }

        // ─── API 密钥（环境变量优先级高于配置文件） ───
        // 使用业界标准变量名，与各 SDK 默认一致
        if (process.env.ANTHROPIC_API_KEY) {
            this.config.providers["anthropic"] = {
                ...this.config.providers["anthropic"],
                apiKey: process.env.ANTHROPIC_API_KEY,
            };
        }
        if (process.env.OPENAI_API_KEY) {
            this.config.providers["openai"] = {
                ...this.config.providers["openai"],
                apiKey: process.env.OPENAI_API_KEY,
            };
        }

        // ─── Provider 选择 ───
        if (process.env.Y_CLAUDE_CODE_PROVIDER) {
            this.config.provider = process.env.Y_CLAUDE_CODE_PROVIDER;
        }

        // ─── 工具调用限制 ───
        if (process.env.Y_CLAUDE_CODE_MAX_ROUNDS) {
            this.config.maxToolRounds = parseInt(process.env.Y_CLAUDE_CODE_MAX_ROUNDS, 10);
        }

        // ─── Thinking（扩展思考）模式 ───
        // 值为 "1" 时开启，允许 AI 在回答前进行更深度的推理
        if (process.env.Y_CLAUDE_CODE_THINKING === "1") {
            this.config.thinkingEnabled = true;
        }
        // 值为 "1" 时在终端中显示 Thinking 内容
        if (process.env.Y_CLAUDE_CODE_SHOW_THINKING === "1") {
            this.config.showThinking = true;
        }
    }
}

/**
 * 全局配置加载器单例
 *
 * 为什么导出单例而非让每个模块各自 new ConfigLoader：
 *   - 避免多处加载配置文件导致状态不一致
 *   - 配置变更后不需要通知多个实例
 *   - 减少 cosmiconfig 重复文件搜索的性能开销
 */
export const configLoader = new ConfigLoader();
