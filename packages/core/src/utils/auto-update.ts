// ─── packages/core/src/utils/auto-update.ts ───
// 自动更新检查 — 定期检查新版本并通知用户
// 解决问题：确保用户及时获得最新功能和安全修复，避免在过时版本上运行
//
// 更新策略：
//   1. 启动时异步检查（不阻塞主流程）
//   2. 从 GitHub Releases / npm registry 获取最新版本号
//   3. 比较当前版本与最新版本
//   4. 如果有新版本，在 CLI 中展示更新提示
//   5. 支持配置项控制：autoUpdateCheck（是否启用）、updateChannel（stable/beta）

import { execSync } from "node:child_process";

/**
 * 版本信息
 */
export interface VersionInfo {
    /** 当前版本号（semver 格式） */
    current: string;
    /** 最新可用版本号 */
    latest: string;
    /** 是否有更新可用 */
    hasUpdate: boolean;
    /** 更新渠道 */
    channel: string;
    /** 最新版本的发布日期 */
    releaseDate?: string;
}

/**
 * 自动更新配置
 */
export interface AutoUpdateConfig {
    /** 是否启用自动更新检查（默认 true） */
    enabled: boolean;
    /** 更新渠道: 'stable' 或 'beta'（默认 stable） */
    channel: "stable" | "beta";
    /** 检查间隔（毫秒），默认 24 小时 */
    checkIntervalMs: number;
    /** 当前版本号 */
    currentVersion: string;
    /** npm 包名（用于从 npm registry 检查） */
    packageName: string;
    /** 自定义检查 URL（可选，用于从 GitHub Releases 等来源检查） */
    checkUrl?: string;
    /** 上次检查的时间戳 */
    lastCheckTime?: number;
}

/**
 * 自动更新管理器
 *
 * 【是什么】
 * 管理 CLI 工具的版本检查和更新通知。优先使用 npm registry 检查，
 * 如果失败则回退到自定义 URL（如 GitHub Releases API）。
 *
 * 【解决什么问题】
 * 1. 用户长期不更新可能错过安全修复和关键功能
 * 2. 后台静默检查，不增加启动延迟
 * 3. 可配置的更新渠道（stable / beta）
 * 4. 节流机制：24 小时内不重复检查
 */
export class AutoUpdateManager {
    private config: AutoUpdateConfig;

    constructor(config?: Partial<AutoUpdateConfig>) {
        this.config = {
            enabled: true,
            channel: "stable",
            checkIntervalMs: 24 * 60 * 60 * 1000, // 24 小时
            currentVersion: "0.1.0",
            packageName: "y-claude-code",
            ...config,
        };
    }

    /**
     * 检查是否需要执行更新检查（节流逻辑）
     * @returns 是否应该检查
     */
    shouldCheck(): boolean {
        if (!this.config.enabled) return false;

        const now = Date.now();
        const lastCheck = this.config.lastCheckTime ?? 0;

        // 超过检查间隔才重新检查
        return now - lastCheck >= this.config.checkIntervalMs;
    }

    /**
     * 从 npm registry 获取最新版本
     *
     * 为什么优先使用 npm registry：
     *   - 零配置，只要有包名即可
     *   - npm 自带 CDN，响应快
     *   - 支持 dist-tags（latest / beta）
     */
    private async checkNpmRegistry(): Promise<string | null> {
        try {
            const tag = this.config.channel === "beta" ? "beta" : "latest";
            const result = execSync(
                `npm view ${this.config.packageName}@${tag} version 2>/dev/null`,
                { encoding: "utf-8", timeout: 5000 },
            );
            return result.trim() || null;
        } catch {
            return null; // npm 不可用或包不存在
        }
    }

    /**
     * 从自定义 URL 获取最新版本
     *
     * 为什么提供自定义 URL 选项：
     *   - GitHub Releases 等来源不受 npm 限制
     *   - 企业内网环境可能无法访问 npm registry
     */
    private async checkCustomUrl(): Promise<string | null> {
        if (!this.config.checkUrl) return null;

        try {
            const response = await fetch(this.config.checkUrl, {
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) return null;
            const data = await response.json() as Record<string, unknown>;
            // 尝试从常见字段中提取版本号
            return (data.version ?? data.tag_name ?? data.latest) as string ?? null;
        } catch {
            return null;
        }
    }

    /**
     * 比较版本号
     * @returns 1 如果 v1 > v2, -1 如果 v1 < v2, 0 如果相等
     */
    private compareVersions(v1: string, v2: string): number {
        const parts1 = v1.split(".").map(Number);
        const parts2 = v2.split(".").map(Number);
        const len = Math.max(parts1.length, parts2.length);

        for (let i = 0; i < len; i++) {
            const p1 = parts1[i] ?? 0;
            const p2 = parts2[i] ?? 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }

    /**
     * 检查更新
     * @returns 版本信息，如果无更新或检查失败返回 null
     */
    async check(): Promise<VersionInfo | null> {
        if (!this.shouldCheck()) return null;

        // 记录检查时间（节流）
        this.config.lastCheckTime = Date.now();

        // 优先从 npm registry 检查
        let latestVersion = await this.checkNpmRegistry();

        // 回退到自定义 URL
        if (!latestVersion) {
            latestVersion = await this.checkCustomUrl();
        }

        if (!latestVersion) return null;

        const current = this.config.currentVersion;
        const comparison = this.compareVersions(latestVersion, current);

        if (comparison <= 0) return null; // 当前已是最新

        return {
            current,
            latest: latestVersion,
            hasUpdate: true,
            channel: this.config.channel,
        };
    }

    /**
     * 生成更新提示文本
     * @param info 版本信息
     * @returns 格式化后的更新提示
     */
    static formatUpdateMessage(info: VersionInfo): string {
        return [
            "",
            `新版本可用: ${info.current} → ${info.latest}`,
            `更新渠道: ${info.channel}`,
            `更新方法: npm update -g ${info.channel === "beta" ? "--tag beta " : ""}y-claude-code`,
            "或访问: https://github.com/anthropics/claude-code/releases",
            "",
        ].join("\n");
    }

    /** 获取配置 */
    getConfig(): Readonly<AutoUpdateConfig> {
        return { ...this.config };
    }
}
