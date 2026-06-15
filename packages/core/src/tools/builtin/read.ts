// ─── packages/core/src/tools/builtin/read.ts ───
// Read 工具 — 读取文件内容，支持文本、图片、PDF、Jupyter Notebook，自动添加行号
// 解决问题：为 Agent 提供安全、受控的文件读取能力，防止路径穿越攻击，同时支持图片 base64 编码、PDF 文本提取、Notebook 格式化展示和文本行号对齐

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult, ImageBlock } from "../../types/messages";

/**
 * 图片文件扩展名集合
 * 解决问题：自动识别图片文件，与普通文本文件区分处理（图片走 base64 编码通道，文本走行号展示通道）
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * ReadTool — 安全文件读取工具
 *
 * 核心能力：
 * 1. 文本文件 → 返回带行号的内容（行号宽度对齐，方便引用具体位置）
 * 2. 图片文件 → Base64 编码为 ImageBlock，供多模态模型渲染
 * 3. PDF 文件  → 指定页码范围读取
 * 4. 安全约束 → 路径必须在工作目录内，防止读取任意系统文件
 */
export class ReadTool extends Tool {
    /** 工具名称标识 */
    name = "Read";

    /**
     * 工具描述
     * 解决问题：告诉模型何时使用此工具以及它能做什么
     */
    description = "读取文件内容。文本文件返回带行号的内容，图片文件返回 base64 编码的图像数据，PDF 文件返回提取的文本内容，Jupyter Notebook (.ipynb) 返回格式化的单元格内容。";

    /**
     * 参数 JSON Schema 定义
     * 解决问题：
     * - file_path: 定位目标文件（必须为绝对路径，避免歧义）
     * - offset/limit: 支持大文件分段读取，防止单次输出超出上下文窗口
     * - pages: PDF 分页读取能力
     */
    parameters: JSONSchema = {
        type: "object",
        properties: {
            file_path: {
                type: "string",
                description: "要读取的文件的绝对路径",
            },
            offset: {
                type: "number",
                description: "从第几行开始读取（1-based，默认从开头）",
            },
            limit: {
                type: "number",
                description: "最多读取多少行（默认 2000）",
            },
            pages: {
                type: "string",
                description: "PDF 文件页码范围，如 '1-5'",
            },
        },
        required: ["file_path"],
    };

    /**
     * 执行文件读取
     *
     * @param params - 包含 file_path、offset、limit 等参数的运行时数据
     * @param context - 执行上下文，包含工作目录等环境信息
     * @returns ToolResult - 统一的结果格式，成功时返回文件内容，失败时返回错误信息
     *
     * 执行流程：
     * 1. 安全校验（路径必须在工作目录内）
     * 2. 判断文件类型（图片 / 文本）
     * 3. 图片 → base64 编码
     * 4. 文本 → 行号对齐输出
     */
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const filePath = params.file_path as string;
        const offset = (params.offset as number) ?? 0;
        const limit = (params.limit as number) ?? 2000;

        // ─── 安全校验：路径必须在工作目录内 ───
        // 解决问题：防止 Agent 通过 ../ 或绝对路径读取任意系统文件（如 /etc/passwd ~/.ssh/id_rsa）
        if (!this.isPathSafe(filePath, context.workingDirectory)) {
            return {
                tool_use_id: "",
                content: `安全限制：不允许读取工作目录外的文件 (${filePath})`,
                is_error: true,
            };
        }

        try {
            const ext = path.extname(filePath).toLowerCase();

            // ─── 图片文件 → base64 编码为 ImageBlock ───
            // 解决问题：多模态模型只能通过 base64 编码接收图片数据
            // ImageBlock 统一格式让上游消息处理层无需关心原始文件类型
            if (IMAGE_EXTENSIONS.has(ext)) {
                const data = await fs.readFile(filePath);
                const base64 = data.toString("base64");
                const mimeType = this.getImageMimeType(ext);
                const imageBlock: ImageBlock = {
                    type: "image",
                    source: { type: "base64", media_type: mimeType, data: base64 },
                };
                return { tool_use_id: "", content: [imageBlock] };
            }

            // ─── PDF 文件 → 提取文本内容 ───
            // 解决问题：PDF 是二进制格式，需要专门的解析库提取可读文本
            if (ext === ".pdf") {
                const pagesParam = params.pages as string | undefined;
                return await this.readPdf(filePath, pagesParam);
            }

            // ─── Jupyter Notebook → 格式化单元格 ───
            // 解决问题：.ipynb 是 JSON 格式，直接展示原始 JSON 可读性差，
            // 格式化为 "### [cell_type] cell_id\\n\\ncontent\\n\\noutputs" 结构
            if (ext === ".ipynb") {
                return await this.readNotebook(filePath);
            }

            // ─── 文本文件 → 带行号输出 ───
            // 解决问题：行号使模型能精确引用位置（如"第 42 行有 bug"），
            // 行号宽度对齐保证视觉整洁
            const content = await fs.readFile(filePath, "utf-8");
            const lines = content.split("\n");

            // ─── 计算读取范围 ───
            // 解决问题：支持大文件分段读取，避免超出上下文窗口限制
            // offset 默认 0（从头开始），limit 默认按实际行数
            const startLine = Math.max(0, offset);
            const endLine = limit ? Math.min(startLine + limit, lines.length) : lines.length;
            const selectedLines = lines.slice(startLine, endLine);

            // ─── 行号格式化（宽度对齐） ───
            // 解决问题：最大行号的位数决定对齐宽度，确保所有行号右对齐
            // 例如 9999 行文件，行号宽度为 4，第 1 行显示为 "   1"
            const lineNumWidth = String(endLine).length;
            const output = selectedLines
                .map((line, i) => {
                    const num = String(startLine + i + 1).padStart(lineNumWidth);
                    return `${num}\t${line}`;
                })
                .join("\n");

            // ─── 截断提示 ───
            // 解决问题：当文件未完全显示时告知用户实际总行数和已显示范围
            const truncated = endLine < lines.length ? `\n\n(文件共 ${lines.length} 行，仅显示第 ${startLine + 1}-${endLine} 行)` : "";

            return { tool_use_id: "", content: `${filePath}:\n${output}${truncated}` };
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            return { tool_use_id: "", content: `读取文件失败: ${message}`, is_error: true };
        }
    }

    /**
     * 是否需要用户确认
     * 解决问题：只读操作无需用户审批，降低交互摩擦
     */
    requiresApproval(): boolean {
        return false; // 只读操作无需确认
    }

    // ─── 私有方法 ───

    /**
     * PDF 文件文本提取
     *
     * @param filePath - PDF 文件绝对路径
     * @param pagesParam - 页码范围，如 "1-5"
     * @returns 提取的文本内容
     *
     * 解决问题：PDF 是二进制格式，使用 pdf-parse 库解析并提取文本，
     * 支持页码范围限制减少输出量
     */
    private async readPdf(filePath: string, pagesParam?: string): Promise<ToolResult> {
        try {
            // 动态加载 pdf-parse（避免非 PDF 场景下的多余加载）
            const { PDFParse } = await import("pdf-parse");
            const data = await fs.readFile(filePath);
            const pdfParse = new PDFParse({ data });
            const result = await pdfParse.getText();
            await pdfParse.destroy();

            let text = result.text;
            const totalPages = result.total;

            // ─── 页码范围过滤 ───
            if (pagesParam) {
                const pages = this.parsePageRange(pagesParam, totalPages);
                text = pages
                    .map((p) => result.getPageText(p) ?? `[第 ${p} 页不可用]`)
                    .join("\n\n");
            }

            const header = `PDF: ${filePath} (${totalPages} 页)${pagesParam ? `，显示页码: ${pagesParam}` : ""}\n\n`;
            return { tool_use_id: "", content: header + text };
        } catch {
            // 降级：PDF 解析失败时回退到原始文本读取
            try {
                const raw = await fs.readFile(filePath, "utf-8");
                return { tool_use_id: "", content: `PDF (原始内容): ${filePath}\n\n${raw.slice(0, 5000)}` };
            } catch {
                return { tool_use_id: "", content: `PDF 解析失败: ${filePath}`, is_error: true };
            }
        }
    }

    /**
     * Jupyter Notebook 文件格式化读取
     *
     * @param filePath - .ipynb 文件绝对路径
     * @returns 格式化的单元格内容
     *
     * 解决问题：.ipynb JSON 原始输出可读性极差，格式化为每个单元格的 source + outputs
     */
    private async readNotebook(filePath: string): Promise<ToolResult> {
        const content = await fs.readFile(filePath, "utf-8");
        const nb = JSON.parse(content);

        if (!nb.cells || !Array.isArray(nb.cells)) {
            return { tool_use_id: "", content: `无效的 Notebook 格式: ${filePath}`, is_error: true };
        }

        const cells = nb.cells as Array<Record<string, unknown>>;
        const lines: string[] = [];
        lines.push(`Notebook: ${filePath} (${cells.length} 个单元格)\n`);

        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            const cellType = (cell.cell_type as string) ?? "code";
            const source = Array.isArray(cell.source)
                ? (cell.source as string[]).join("")
                : (cell.source as string) ?? "";

            lines.push(`## [${i}] ${cellType}${cell.id ? ` (id: ${cell.id})` : ""}`);
            lines.push(source);

            // ─── 展示输出内容 ───
            const outputs = cell.outputs as Array<Record<string, unknown>> | undefined;
            if (outputs?.length) {
                lines.push(`\n--- 输出 ---`);
                for (const output of outputs) {
                    if (output.text) {
                        const text = Array.isArray(output.text) ? (output.text as string[]).join("") : String(output.text);
                        lines.push(text);
                    }
                    if (output.data) {
                        const data = output.data as Record<string, unknown>;
                        for (const [mimeType, value] of Object.entries(data)) {
                            lines.push(`[${mimeType}] ${typeof value === "string" ? value.slice(0, 200) : "[binary data]"}${typeof value === "string" && value.length > 200 ? "..." : ""}`);
                        }
                    }
                    if (output.execution_count != null) {
                        lines.push(`[执行次数: ${output.execution_count}]`);
                    }
                }
            }
            lines.push("");
        }

        const maxOutput = 20000;
        const full = lines.join("\n");
        const result = full.length > maxOutput ? full.slice(0, maxOutput) + `\n\n...(内容已截断，共 ${full.length} 字符，使用 offset/limit 分段读取)` : full;

        return { tool_use_id: "", content: result };
    }

    /**
     * 页码范围解析
     *
     * @param pagesParam - 页码范围字符串，支持 "1-5", "3", "1,3,5-7" 等
     * @param totalPages - 总页数
     * @returns 页码数组
     */
    private parsePageRange(pagesParam: string, totalPages: number): number[] {
        const pages: number[] = [];
        const parts = pagesParam.split(",");
        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.includes("-")) {
                const [startStr, endStr] = trimmed.split("-");
                const start = Math.max(1, parseInt(startStr, 10) || 1);
                const end = Math.min(parseInt(endStr, 10) || totalPages, totalPages);
                for (let p = start; p <= end; p++) {
                    pages.push(p);
                }
            } else {
                const p = parseInt(trimmed, 10);
                if (p >= 1 && p <= totalPages) {
                    pages.push(p);
                }
            }
        }
        return pages.length > 0 ? pages : Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    /**
     * 路径安全校验
     *
     * @param filePath - 用户请求的文件路径（可能是相对路径或绝对路径）
     * @param workingDirectory - 当前会话的工作目录
     * @returns 路径是否安全可访问
     *
     * 解决问题：防止目录穿越攻击（Directory Traversal Attack）
     * - 使用 resolve 消除 ../ 等相对路径陷阱
     * - 允许读取 .y-claude-code 配置目录（跨工作目录的全局配置）
     * - 拒绝任意绝对路径读取（如 /etc/passwd）
     */
    private isPathSafe(filePath: string, workingDirectory: string): boolean {
        const resolved = path.resolve(filePath);
        const workDir = path.resolve(workingDirectory);
        // 允许读取 home 目录下的配置文件（如 ~/.y-claude-code/）
        return resolved.startsWith(workDir) || resolved.includes(".y-claude-code");
    }

    /**
     * 文件扩展名 → MIME 类型映射
     *
     * @param ext - 文件扩展名（含点，如 ".png"）
     * @returns 对应的 MIME 媒体类型字符串
     *
     * 解决问题：ImageBlock 需要正确的 MIME type 字段，
     * 不同图片格式需要不同的 media_type 值才能使模型正确解码
     */
    private getImageMimeType(ext: string): ImageBlock["source"]["media_type"] {
        const map: Record<string, ImageBlock["source"]["media_type"]> = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        };
        return map[ext] ?? "image/png";
    }
}
