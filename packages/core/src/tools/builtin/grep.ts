// ─── packages/core/src/tools/builtin/grep.ts ───
// Grep 工具 — 文件内容搜索，基于正则匹配
// 解决问题：为 Agent 提供高效的文件内容搜索能力，通过系统 grep 命令实现（快于 Node.js 纯文本遍历）

import { exec } from "node:child_process";
import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";

/**
 * GrepTool — 基于系统 grep 的文件内容搜索工具
 *
 * 核心能力：
 * 1. 递归搜索：自动遍历目录树
 * 2. 行号展示：每个匹配项显示所在行号
 * 3. 文件过滤：通过 include 参数限定搜索特定文件类型
 * 4. 结果截断：max_results 控制返回数量，避免输出过长
 *
 * 设计选择：使用系统 grep 而非 Node.js 文本处理
 * - grep 经过数十年优化，I/O 效率极高
 * - 自动处理二进制文件（-I 跳过）
 * - 无需将大量文件内容读入 Node.js 内存
 */
export class GrepTool extends Tool {
    /** 工具名称标识 */
    name = "Grep";

    /**
     * 工具描述
     * 解决问题：明确输出格式为 "文件路径:行号: 匹配行内容"，方便 Agent 解析和定位
     */
    description = "在文件中搜索匹配模式的内容。输出格式: 文件路径:行号: 匹配行内容";

    /**
     * 参数 JSON Schema 定义
     * 解决问题：
     * - pattern: 搜索正则（必须参数）
     * - path: 搜索起始路径
     * - include: 限定文件类型（如 *.ts），避免搜索无关文件
     * - max_results: 限制输出量，防止上下文窗口溢出
     */
    parameters: JSONSchema = {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "搜索的正则表达式模式",
            },
            path: {
                type: "string",
                description: "搜索路径（默认：当前工作目录）",
            },
            include: {
                type: "string",
                description: "限定搜索的文件 glob 模式，如 '*.ts'",
            },
            max_results: {
                type: "number",
                description: "最大结果数（默认 100）",
                default: 100,
            },
        },
        required: ["pattern"],
    };

    /**
     * 执行 grep 内容搜索
     *
     * @param params - 包含 pattern、path、include、max_results 参数
     * @param context - 执行上下文，获取工作目录和 AbortSignal
     * @returns ToolResult - 匹配内容列表，每行格式为 "相对路径:行号:内容"
     *
     * 执行流程：
     * 1. 构造 grep 命令（自动添加 -rnI --include 标志）
     * 2. 执行命令（head 限制输出行数）
     * 3. 将绝对路径转为相对路径展示
     * 4. 处理零结果和异常
     */
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const pattern = params.pattern as string;
        const searchPath = (params.path as string) ?? context.workingDirectory;
        const include = params.include as string | undefined;
        const maxResults = (params.max_results as number) ?? 100;

        try {
            // ─── 构造 grep 命令 ───
            // 解决问题：
            // -r: 递归搜索子目录（必需）
            // -n: 输出行号（Agent 定位需要）
            // -I: 跳过二进制文件（防止乱码输出）
            // --include: 限定文件类型（性能优化，减少无效匹配）
            // --color=never: 禁用颜色输出（原始文本不需要 ANSI 转义码）
            // -e: 将 pattern 作为正则参数（带转义）
            // head -n: 限制输出行数（防止结果过多）
            const includeFlag = include ? `--include="${include}"` : "";
            const command = `grep -rnI ${includeFlag} --color=never -e "${this.escapePattern(pattern)}" "${searchPath}" 2>/dev/null | head -n ${maxResults + 1}`;

            const result = await this.execGrep(command, context.signal);
            const lines = result.stdout.trim().split("\n").filter(Boolean);

            // ─── 零结果处理 ───
            // 解决问题：grep 找不到匹配时 exit code 为 1，execGrep 已处理这种情况
            if (lines.length === 0) {
                return {
                    tool_use_id: "",
                    content: `未找到匹配 "${pattern}" 的内容`,
                };
            }

            // ─── 截断检测 ───
            // 解决问题：如果 head 截断了输出，告知用户实际结果可能更多
            const truncated = lines.length > maxResults;
            const displayLines = lines.slice(0, maxResults);

            // ─── 清理路径前缀，转为相对路径 ───
            // 解决问题：grep 输出绝对路径（如 /Users/xxx/project/src/file.ts:42:line）
            // 转为相对路径（./src/file.ts:42:line）更简洁，且可被其他工具直接使用
            const output = displayLines
                .map((line) => {
                    // grep 输出格式: /absolute/path:行号:内容
                    // 注意：只有第一个 : 是路径和行号的分隔符，内容中可能也包含 :
                    const firstColon = line.indexOf(":");
                    if (firstColon === -1) return line;
                    const filePath = line.slice(0, firstColon);
                    const rest = line.slice(firstColon);
                    // 转为相对于工作目录的路径
                    const relativePath = filePath.replace(context.workingDirectory, ".");
                    return relativePath + rest;
                })
                .join("\n");

            return {
                tool_use_id: "",
                content: `搜索 "${pattern}":\n${output}${truncated ? `\n(结果已截断，显示前 ${maxResults} 条)` : ""}`,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            return { tool_use_id: "", content: `Grep 搜索失败: ${message}`, is_error: true };
        }
    }

    /**
     * 是否需要用户确认
     * 解决问题：grep 是纯只读操作，不修改任何文件
     */
    requiresApproval(): boolean {
        return false;
    }

    // ─── 私有方法 ───

    /**
     * 执行 grep 命令
     *
     * @param command - 完整 grep 命令行
     * @param signal - AbortSignal 用于支持 Ctrl+C 取消
     * @returns Promise<{stdout, stderr}> - grep 命令输出
     *
     * 解决问题：
     * - 处理 grep 的特殊退出码：找不到匹配时 exit code 为 1，这不是错误
     * - maxBuffer: 2MB 缓冲区，足够容纳大量搜索结果
     * - 只有真正的执行错误（exit code > 1）才 reject
     */
    private execGrep(command: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            exec(command, { signal, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
                // grep 找不到匹配时 exit code 为 1，不是错误 — 这是关键的处理逻辑
                if (error && error.code !== 1) {
                    reject(error);
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }

    /**
     * 转义 grep 正则中的特殊字符
     *
     * @param pattern - 原始搜索模式
     * @returns 转义后的安全模式
     *
     * 解决问题：
     * - Shell 环境中双引号内的 $、反引号、反斜杠会被 Bash 展开
     * - 转义这些字符防止 grep 命令被错误解析或注入攻击
     * - 注意：这是在 -e 参数中使用的，所以主要转义反斜杠和引号类字符
     */
    private escapePattern(pattern: string): string {
        return pattern.replace(/["'`$\\]/g, "\\$&");
    }
}
