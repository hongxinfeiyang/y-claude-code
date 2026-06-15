// ─── packages/core/src/tools/builtin/edit.ts ───
// Edit 工具 — 精确字符串替换，确保替换唯一性（Claude Code 核心编辑工具）
// 解决问题：提供精确、安全的代码修改能力，通过唯一性校验防止意外误改

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";

/**
 * EditTool — 精确字符串替换工具
 *
 * 核心设计理念：
 * - old_string 必须在目标文件中精确匹配（包括空白字符）
 * - 默认模式下要求 old_string 唯一匹配，防止误改多处
 * - replace_all 模式允许替换全部匹配项
 *
 * 与 Write 工具的区别：
 * - Write 是全量覆盖整个文件
 * - Edit 是局部精确修改，保留文件其余部分不变
 */
export class EditTool extends Tool {
    /** 工具名称标识 */
    name = "Edit";

    /**
     * 工具描述
     * 解决问题：指导模型提供精确的 old_string（必须保留原缩进、空白字符），
     * 从而避免"模糊编辑"导致文件损坏
     */
    description = "精确字符串替换。在文件中查找 old_string 并替换为 new_string。如果 old_string 在文件中不唯一且未设置 replace_all，将报错。必须保持原有缩进（制表符/空格）不变。";

    /**
     * 参数 JSON Schema 定义
     * 解决问题：
     * - old_string: 必须精确匹配文件内容（不能多也不能少一个空格）
     * - replace_all: 安全阀门 — 默认 false 防止误改，只有明确声明后才能全量替换
     */
    parameters: JSONSchema = {
        type: "object",
        properties: {
            file_path: {
                type: "string",
                description: "要修改的文件的绝对路径",
            },
            old_string: {
                type: "string",
                description: "要被替换的原始字符串，必须能在文件中精确匹配",
            },
            new_string: {
                type: "string",
                description: "替换后的新字符串",
            },
            replace_all: {
                type: "boolean",
                description: "是否替换所有匹配项（默认 false，即要求唯一匹配）",
                default: false,
            },
        },
        required: ["file_path", "old_string", "new_string"],
    };

    /**
     * 执行精确字符串替换
     *
     * @param params - 包含 file_path、old_string、new_string、replace_all
     * @param context - 执行上下文
     * @returns ToolResult - 替换结果或详细错误信息
     *
     * 执行流程：
     * 1. 安全校验（路径必须在工作目录内）
     * 2. 读取文件原始内容
     * 3. 查找 old_string 的所有匹配位置
     * 4. 零匹配 → 报错
     * 5. 多匹配且未声明 replace_all → 报错 + 显示上下文
     * 6. 单匹配或 replace_all → 执行替换并写回文件
     */
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const filePath = params.file_path as string;
        const oldString = params.old_string as string;
        const newString = params.new_string as string;
        const replaceAll = (params.replace_all as boolean) ?? false;

        // ─── 安全校验：路径必须在工作目录内 ───
        // 解决问题：防止通过编辑工具修改系统文件或越权文件
        if (!this.isPathSafe(filePath, context.workingDirectory)) {
            return {
                tool_use_id: "",
                content: `安全限制：不允许修改工作目录外的文件 (${filePath})`,
                is_error: true,
            };
        }

        try {
            const originalContent = await fs.readFile(filePath, "utf-8");

            // ─── 查找所有匹配位置 ───
            // 解决问题：需要知道匹配次数来决定是否允许替换
            // 使用 findIndexOf 而非正则，确保纯文本精确匹配（不会受正则特殊字符干扰）
            const matches = this.findAllMatches(originalContent, oldString);

            // ─── 零匹配处理 ───
            // 解决问题：old_string 找不到目标时给出明确错误提示，
            // 而非静默失败（静默失败会让 Agent 以为编辑成功而实际什么都没改）
            if (matches.length === 0) {
                return {
                    tool_use_id: "",
                    content: `未找到匹配的字符串:\n\`\`\`\n${oldString.slice(0, 200)}\n\`\`\``,
                    is_error: true,
                };
            }

            // ─── 唯一性检查（非 replace_all 模式） ───
            // 解决问题：模型提供的 old_string 如果匹配了多处（比如函数名过于简短），
            // 默认拒绝替换并提示添加更多上下文。此保护防止"意外全局替换"。
            if (!replaceAll && matches.length > 1) {
                // ─── 构造上下文提示 ───
                // 解决问题：展示每个匹配位置前后各 40 字符的上下文，
                // 用 >>> <<< 标记匹配区域，帮助模型定位需要修改的具体位置
                const contexts = matches.slice(0, 5).map((pos, i) => {
                    const contextStart = Math.max(0, pos - 40);
                    const contextEnd = Math.min(originalContent.length, pos + oldString.length + 40);
                    const before = originalContent.slice(contextStart, pos);
                    const match = originalContent.slice(pos, pos + oldString.length);
                    const after = originalContent.slice(pos + oldString.length, contextEnd);
                    return `  [${i + 1}] 位置 ${pos}: ...${before}>>>${match}<<<${after}...`;
                });
                // 超过 5 个时提示实际总数，避免输出过长
                const extra = matches.length > 5 ? `\n  ... 及其他 ${matches.length - 5} 个位置` : "";

                return {
                    tool_use_id: "",
                    content: `old_string 在文件中匹配到 ${matches.length} 处，不唯一。请提供更多上下文使匹配唯一，或设置 replace_all: true 替换全部。\n匹配位置:\n${contexts.join("\n")}${extra}`,
                    is_error: true,
                };
            }

            // ─── 执行替换 ───
            // 解决问题：
            // - replaceAll 模式：使用 String.replaceAll 替换所有出现
            // - 单次模式：在匹配位置进行字符串拼接（slice 方法优于 replace，因为 replace 会把 $&、$1 等当特殊替换模式）
            const newContent = replaceAll
                ? originalContent.replaceAll(oldString, newString)
                : originalContent.slice(0, matches[0]) + newString + originalContent.slice(matches[0] + oldString.length);

            await fs.writeFile(filePath, newContent, "utf-8");

            const count = replaceAll ? matches.length : 1;
            const diff = this.generateUnifiedDiff(filePath, originalContent, newContent);
            return {
                tool_use_id: "",
                content: `替换了 ${count} 处匹配: ${filePath}\n\n${diff}`,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            return { tool_use_id: "", content: `编辑文件失败: ${message}`, is_error: true };
        }
    }

    /**
     * 是否需要用户确认
     * 解决问题：修改文件是破坏性操作，需要用户审批
     */
    requiresApproval(): boolean {
        return true; // 修改文件需要用户确认
    }

    // ─── 私有方法 ───

    /**
     * 生成统一 diff 格式（带 ANSI 颜色标记）
     *
     * @param filePath - 文件路径（用于 diff 头部）
     * @param original - 原始内容
     * @param modified - 修改后内容
     * @returns 带颜色的 unified diff 字符串
     *
     * 解决问题：替换操作后展示 diff，用户无需手动对比 old/new 差异
     * - 使用 ANSI 颜色: 红色背景标记删除行，绿色背景标记新增行
     * - 上下文窗口: 变更行前后各 3 行
     * - 行号标注: @@ -start,count +start,count @@ 格式
     */
    private generateUnifiedDiff(filePath: string, original: string, modified: string): string {
        const origLines = original.split("\n");
        const modLines = modified.split("\n");

        // ─── 查找第一个差异位置 ───
        let diffStart = 0;
        while (diffStart < origLines.length && diffStart < modLines.length && origLines[diffStart] === modLines[diffStart]) {
            diffStart++;
        }

        // ─── 查找差异结束位置 ───
        let origEnd = origLines.length - 1;
        let modEnd = modLines.length - 1;
        while (origEnd >= diffStart && modEnd >= diffStart && origLines[origEnd] === modLines[modEnd]) {
            origEnd--;
            modEnd--;
        }

        const contextLines = 3;
        const displayStart = Math.max(0, diffStart - contextLines);
        const displayOrigEnd = Math.min(origLines.length - 1, origEnd + contextLines);
        const displayModEnd = Math.min(modLines.length - 1, modEnd + contextLines);

        // ─── ANSI 颜色码 ───
        const RED = "\x1b[31m";
        const GREEN = "\x1b[32m";
        const CYAN = "\x1b[36m";
        const RESET = "\x1b[0m";

        const hunkHeader = `${CYAN}@@ -${displayStart + 1},${displayOrigEnd - displayStart + 1} +${displayStart + 1},${displayModEnd - displayStart + 1} @@${RESET}`;
        const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`, hunkHeader];

        let oi = displayStart;
        let mi = displayStart;

        while (oi <= displayOrigEnd || mi <= displayModEnd) {
            if (oi < diffStart && mi < diffStart) {
                // 上下文行（变更前）
                lines.push(` ${origLines[oi]}`);
                oi++;
                mi++;
            } else if (oi <= origEnd && mi <= modEnd) {
                // 变更行
                if (oi <= origEnd) {
                    lines.push(`${RED}-${origLines[oi]}${RESET}`);
                    oi++;
                }
                if (mi <= modEnd) {
                    lines.push(`${GREEN}+${modLines[mi]}${RESET}`);
                    mi++;
                }
            } else if (oi <= displayOrigEnd) {
                lines.push(`${RED}-${origLines[oi]}${RESET}`);
                oi++;
            } else if (mi <= displayModEnd) {
                lines.push(`${GREEN}+${modLines[mi]}${RESET}`);
                mi++;
            }
        }

        return lines.join("\n");
    }

    /**
     * 查找字符串在内容中的所有匹配位置
     *
     * @param content - 文件完整内容
     * @param search - 要搜索的子字符串
     * @returns 所有匹配起始位置的数组（字符偏移量）
     *
     * 解决问题：
     * - 使用纯文本 indexOf 而非正则，避免正则元字符（., *, +, $ 等）被错误解释
     * - 死循环保护：search 为空字符串时 break（indexOf("", pos) 永远返回 pos）
     * - 收集所有匹配位置后逐一判断，而非边查找边替换
     */
    private findAllMatches(content: string, search: string): number[] {
        const positions: number[] = [];
        let pos = 0;
        while ((pos = content.indexOf(search, pos)) !== -1) {
            positions.push(pos);
            pos += search.length;
            // 防止死循环（search 为空字符串时 indexOf 永远返回当前 pos）
            if (search.length === 0) break;
        }
        return positions;
    }

    /**
     * 路径安全校验
     *
     * @param filePath - 目标编辑路径
     * @param workingDirectory - 当前工作目录
     * @returns 路径是否在允许范围内
     *
     * 解决问题：与其他工具共享相同的路径安全策略
     * - resolve 消除相对路径穿越
     * - 只允许工作目录内和配置目录
     */
    private isPathSafe(filePath: string, workingDirectory: string): boolean {
        const resolved = path.resolve(filePath);
        const workDir = path.resolve(workingDirectory);
        return resolved.startsWith(workDir) || resolved.includes(".y-claude-code");
    }
}
