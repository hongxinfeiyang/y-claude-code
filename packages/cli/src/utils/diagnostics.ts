// ─── packages/cli/src/utils/diagnostics.ts ───
// 配置诊断 — 检测配置问题并提供可操作的修复指引

import type { UserConfig } from "@y-claude-code/core";
import { listConfiguredProviders } from "@y-claude-code/core";

/** 诊断结果 */
export interface DiagnosticResult {
    /** 严重级别 */
    level: "error" | "warn" | "info";
    /** 问题描述 */
    message: string;
    /** 修复步骤 */
    fix: string[];
}

/** 对用户配置做全面诊断，返回所有发现的问题 */
export function diagnoseConfig(config: UserConfig): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];

    // ─── 1. 检查是否有 Provider 配置 ───
    const configuredProviders = listConfiguredProviders(config);
    if (configuredProviders.length === 0) {
        results.push({
            level: "error",
            message: "未配置任何 LLM Provider",
            fix: [
                "运行 y-claude-code --setup 进入配置向导",
                "或手动编辑 ~/.y-claude-code/config.json",
                "",
                "最简配置示例:",
                '{',
                '  "provider": "anthropic",',
                '  "providers": {',
                '    "anthropic": { "apiKey": "sk-ant-xxx" }',
                '  },',
                '  "model": "claude-sonnet-4-6"',
                '}',
                "",
                "支持所有 OpenAI 兼容接口（如 DeepSeek）:",
                '{',
                '  "provider": "deepseek",',
                '  "providers": {',
                '    "deepseek": {',
                '      "apiKey": "sk-xxx",',
                '      "baseURL": "https://api.deepseek.com/v1"',
                '    }',
                '  },',
                '  "model": "deepseek-chat"',
                '}',
            ],
        });
        return results; // 最严重问题，不继续检查
    }

    // ─── 2. 检查当前选中的 Provider 是否已配置 ───
    const current = config.provider;
    if (!configuredProviders.includes(current)) {
        results.push({
            level: "error",
            message: `当前 Provider "${current}" 未配置，可用: ${configuredProviders.join(", ")}`,
            fix: [
                `运行 y-claude-code 切换: /config set provider ${configuredProviders[0]}`,
                `或编辑配置文件将 "provider" 改为 "${configuredProviders[0]}"`,
            ],
        });
    }

    // ─── 3. 检查当前 Provider 的 API Key ───
    const providerConfig = config.providers[current];
    if (providerConfig && !providerConfig.apiKey) {
        const envVar = current === "anthropic" ? "ANTHROPIC_API_KEY" : current === "openai" ? "OPENAI_API_KEY" : `${current.toUpperCase()}_API_KEY`;
        results.push({
            level: "error",
            message: `Provider "${current}" 缺少 API Key`,
            fix: [
                `方式1: 设置环境变量 export ${envVar}="sk-xxx"`,
                `方式2: 编辑 ~/.y-claude-code/config.json，在 providers.${current}.apiKey 填入密钥`,
                `方式3: 运行 y-claude-code --setup 重新配置`,
            ],
        });
    }

    // ─── 4. 检查模型名是否看起来有问题 ───
    const model = config.model;
    if (model && !model.includes("-")) {
        results.push({
            level: "warn",
            message: `模型名 "${model}" 格式异常，通常应包含 "-"（如 "claude-sonnet-4-6" 或 "gpt-4o"）`,
            fix: ["检查模型名是否正确: /model <正确的模型名>"],
        });
    }

    // ─── 5. 检查 baseURL 是否有常见拼写错误 ───
    if (providerConfig?.baseURL) {
        const url = providerConfig.baseURL;
        if (url.endsWith("/v1/")) {
            results.push({
                level: "warn",
                message: `baseURL 末尾多余斜杠 "${url}"，可能导致 404`,
                fix: [`去掉末尾斜杠: "${url.replace(/\/+$/, "")}"`],
            });
        }
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            results.push({
                level: "warn",
                message: `baseURL "${url}" 缺少协议头`,
                fix: [`添加协议头: "https://${url}"`],
            });
        }
    }

    // ─── 6. 环境变量提示（如果只用 env 配置了 key 但没写入 config） ───
    const envKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"];
    const detectedEnv = envKeys.filter((k) => process.env[k]);
    if (detectedEnv.length > 0 && configuredProviders.length === 0) {
        results.push({
            level: "info",
            message: `检测到环境变量 ${detectedEnv.join(", ")}，但配置文件中无 Provider 定义`,
            fix: [
                "环境变量已设但配置文件缺少 provider 字段",
                "运行 y-claude-code --setup 或手动补全 ~/.y-claude-code/config.json 中的 provider 和 providers 字段",
            ],
        });
    }

    return results;
}

/** 格式化诊断结果为终端输出 */
export function formatDiagnostics(results: DiagnosticResult[]): string {
    if (results.length === 0) return "";

    const lines: string[] = [];
    const counts = { error: 0, warn: 0, info: 0 };

    for (const r of results) {
        counts[r.level]++;
    }

    lines.push("");
    lines.push("─".repeat(60));
    lines.push(`配置诊断: ${counts.error} 个错误, ${counts.warn} 个警告, ${counts.info} 个提示`);
    lines.push("─".repeat(60));

    for (const r of results) {
        const icon = { error: "✕", warn: "⚠", info: "ℹ" }[r.level];
        lines.push("");
        lines.push(`${icon} [${r.level.toUpperCase()}] ${r.message}`);
        if (r.fix.length > 0) {
            lines.push("  修复方式:");
            for (const step of r.fix) {
                lines.push(`    ${step}`);
            }
        }
    }

    lines.push("");
    lines.push("─".repeat(60));
    return lines.join("\n");
}

/** 一站式：诊断 + 格式化 + 输出 */
export function runDiagnostics(config: UserConfig): string {
    const results = diagnoseConfig(config);
    return formatDiagnostics(results);
}
