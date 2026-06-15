// ─── packages/core/src/tools/builtin/glob.ts ───
// Glob 工具 — 文件模式匹配，支持通配符搜索
// 解决问题：为 Agent 提供高效的文件发现能力，自动排除无关目录避免结果噪音

import fg from "fast-glob";
import * as path from "node:path";
import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";

/**
 * 默认排除目录列表
 * 解决问题：自动过滤 node_modules（海量依赖文件）、.git（仓库内部数据）、
 * dist/.next（构建产物），避免 glob 结果被这些目录污染
 */
const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**"];

/**
 * GlobTool — 基于 fast-glob 的文件模式搜索工具
 *
 * 核心能力：
 * 1. glob 模式匹配搜索文件（如 src/&#42;&#42;/*.ts 匹配所有 TypeScript 源文件）
 * 2. 自动排除 node_modules、.git 等无关目录
 * 3. 返回结果转为相对路径展示（便于阅读和后续引用）
 * 4. 不包含隐藏文件（dot: false），减少噪音
 */
export class GlobTool extends Tool {
    /** 工具名称标识 */
    name = "Glob";

    /**
     * 工具描述
     * 解决问题：告知模型 glob 语法示例和自动排除规则，提高搜索命中率
     */
    description = "使用 glob 模式搜索文件。例如 'src/**/*.ts' 匹配所有 TypeScript 文件。自动排除 node_modules 和 .git 等目录。";

    /**
     * 参数 JSON Schema 定义
     * 解决问题：
     * - pattern: glob 模式字符串（必须参数）
     * - path: 搜索起始目录，默认当前工作目录
     */
    parameters: JSONSchema = {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "glob 模式，如 'src/**/*.ts'",
            },
            path: {
                type: "string",
                description: "搜索起始目录（默认：当前工作目录）",
            },
        },
        required: ["pattern"],
    };

    /**
     * 执行 glob 文件搜索
     *
     * @param params - 包含 pattern 和可选 path 参数
     * @param context - 执行上下文，获取当前工作目录
     * @returns ToolResult - 匹配文件列表或错误信息
     *
     * 执行流程：
     * 1. 解析搜索路径（默认工作目录）
     * 2. 调用 fast-glob 搜索
     * 3. 将绝对路径转为相对路径展示
     * 4. 处理零结果和异常情况
     */
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const pattern = params.pattern as string;
        const searchPath = (params.path as string) ?? context.workingDirectory;

        try {
            // ─── 路径解析 ───
            // 解决问题：确保 fast-glob 的 cwd 参数使用绝对路径，避免相对路径歧义
            const resolvedPath = path.resolve(searchPath);

            const files = await fg(pattern, {
                cwd: resolvedPath,        // 搜索的起始目录
                ignore: DEFAULT_IGNORE,   // 自动排除无关目录
                absolute: true,           // 返回绝对路径（用于后续转相对路径）
                dot: false,               // 不包含隐藏文件（.gitignore 等），减少噪音
                onlyFiles: true,          // 只返回文件，不返回目录
            });

            // ─── 零结果处理 ───
            // 解决问题：明确告知 Agent 没有匹配项，而非返回空字符串让 Agent 困惑
            if (files.length === 0) {
                return {
                    tool_use_id: "",
                    content: `未找到匹配 "${pattern}" 的文件`,
                };
            }

            // ─── 转为相对路径展示 ───
            // 解决问题：
            // - 相对路径更简洁（./src/main.ts vs /Users/xxx/long/path/src/main.ts）
            // - 路径在工作目录内即可用其他工具直接操作（Read、Edit 等）
            const relative = files.map((f) => path.relative(context.workingDirectory, f));
            const output = `匹配 "${pattern}" (${files.length} 个文件):\n${relative.map((f) => `  ${f}`).join("\n")}`;

            return { tool_use_id: "", content: output };
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            return { tool_use_id: "", content: `Glob 搜索失败: ${message}`, is_error: true };
        }
    }

    /**
     * 是否需要用户确认
     * 解决问题：glob 是纯只读操作，不修改文件系统，无需审批
     */
    requiresApproval(): boolean {
        return false; // 只读操作
    }
}
