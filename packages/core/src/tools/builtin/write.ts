// ─── packages/core/src/tools/builtin/write.ts ───
// Write 工具 — 创建或覆盖文件，自动创建父目录
// 解决问题：为 Agent 提供受控的文件写入能力，包含路径安全校验和敏感文件保护机制

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";

/**
 * WriteTool — 安全文件写入工具
 *
 * 核心能力：
 * 1. 创建新文件或完全覆盖已存在文件
 * 2. 自动创建不存在的父目录（mkdir recursive）
 * 3. 安全约束：路径必须在工作目录内 + 禁止覆盖敏感文件
 */
export class WriteTool extends Tool {
    /** 工具名称标识 */
    name = "Write";

    /**
     * 工具描述
     * 解决问题：与 Edit 工具区分 — Write 用于创建新文件或全量覆盖，Edit 用于精确局部修改
     */
    description = "创建新文件或覆盖已有文件。会自动创建不存在的父目录。";

    /**
     * 参数 JSON Schema 定义
     * 解决问题：
     * - file_path: 必须为绝对路径，避免歧义
     * - content: 完整文件内容的字符串，一次调用写入全部
     */
    parameters: JSONSchema = {
        type: "object",
        properties: {
            file_path: {
                type: "string",
                description: "要写入的文件的绝对路径",
            },
            content: {
                type: "string",
                description: "要写入的文件内容",
            },
        },
        required: ["file_path", "content"],
    };

    /**
     * 执行文件写入
     *
     * @param params - 包含 file_path 和 content 的运行时数据
     * @param context - 执行上下文，包含工作目录
     * @returns ToolResult - 写入结果，包含操作类型（创建/覆盖）和字节数
     *
     * 执行流程：
     * 1. 路径安全校验（必须在工作目录内）
     * 2. 敏感文件名检查（拒绝覆盖 .env 等敏感配置）
     * 3. 自动创建父目录
     * 4. 写入文件内容
     */
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const filePath = params.file_path as string;
        const content = params.content as string;

        // ─── 安全校验：路径必须在工作目录内 ───
        // 解决问题：防止 Agent 通过绝对路径或 ../ 写入任意位置
        if (!this.isPathSafe(filePath, context.workingDirectory)) {
            return {
                tool_use_id: "",
                content: `安全限制：不允许写入工作目录外的文件 (${filePath})`,
                is_error: true,
            };
        }

        // ─── 禁止覆盖敏感文件 ───
        // 解决问题：防止意外覆盖 .env / credentials.json 等包含密钥和令牌的安全敏感文件
        // 这些文件一旦被覆盖可能导致密钥丢失，必须通过手动操作保护
        const basename = path.basename(filePath);
        if (this.isSensitiveFile(basename)) {
            return {
                tool_use_id: "",
                content: `安全限制：不允许覆盖敏感文件 (${basename})。请手动操作。`,
                is_error: true,
            };
        }

        try {
            // ─── 确保父目录存在 ───
            // 解决问题：当写入 src/a/b/c/file.ts 但目录层级不存在时自动创建
            // recursive: true 保证多级目录一次性创建
            await fs.mkdir(path.dirname(filePath), { recursive: true });

            // ─── 检测文件是否存在（用于结果反馈） ───
            // 解决问题：让用户明确知道是"创建"还是"覆盖"，便于核对是否误操作
            const existed = await fs.access(filePath).then(() => true).catch(() => false);

            // 写入文件
            await fs.writeFile(filePath, content, "utf-8");

            const action = existed ? "覆盖写入" : "创建";
            return {
                tool_use_id: "",
                content: `文件 ${action}成功: ${filePath} (${content.length} 字符)`,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            return { tool_use_id: "", content: `写入文件失败: ${message}`, is_error: true };
        }
    }

    /**
     * 是否需要用户确认
     * 解决问题：写入操作会修改文件系统，必须经过用户确认防止恶意或错误写入
     */
    requiresApproval(): boolean {
        return true; // 写入操作需要用户确认
    }

    // ─── 私有方法 ───

    /**
     * 路径安全校验
     *
     * @param filePath - 目标写入路径
     * @param workingDirectory - 当前工作目录
     * @returns 路径是否在允许范围内
     *
     * 解决问题：与 Read 工具共享相同的路径安全策略
     * - resolve 消除 ../ 绕过
     * - 只允许工作目录内和 .y-claude-code 配置目录
     */
    private isPathSafe(filePath: string, workingDirectory: string): boolean {
        const resolved = path.resolve(filePath);
        const workDir = path.resolve(workingDirectory);
        // 也允许写入用户配置目录
        return resolved.startsWith(workDir) || resolved.includes(".y-claude-code");
    }

    /**
     * 敏感文件名检测
     *
     * @param filename - 文件基础名（basename，不含路径）
     * @returns 是否为受保护的敏感文件
     *
     * 解决问题：白名单式保护机制 —
     * .env / credentials.json / secrets.json 等文件通常包含 API 密钥、
     * 数据库密码等机密信息，一旦被覆盖将导致密钥丢失或泄露。
     * 采用基础名匹配而非路径匹配，因为敏感文件名在任何目录下都应受保护。
     */
    private isSensitiveFile(filename: string): boolean {
        const sensitive = [".env", ".env.local", ".env.production", "credentials.json", "secrets.json", ".gitconfig"];
        return sensitive.includes(filename);
    }
}
