// ─── packages/core/src/tools/builtin/notebook.ts ───
// NotebookEdit 工具 — Jupyter Notebook (.ipynb) 单元格编辑
// 解决问题: Agent 需要编辑 Jupyter Notebook 中的数据科学/分析文档

import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";
import * as fs from "node:fs/promises";

export class NotebookEditTool extends Tool {
    name = "NotebookEdit";
    description = "编辑 Jupyter Notebook (.ipynb) 文件的单元格。支持替换、插入和删除单元格。用于修改数据分析、机器学习等 Notebook 文档。";

    parameters = {
        type: "object" as const,
        properties: {
            notebook_path: {
                type: "string",
                description: "Notebook 文件的绝对路径 (.ipynb)",
            },
            cell_id: {
                type: "string",
                description: "要编辑的单元格 ID。插入新模式时，新单元格插入到该 ID 之后。不提供则在开头插入。",
            },
            cell_type: {
                type: "string",
                description: "单元格类型",
                enum: ["code", "markdown"],
                default: "code",
            },
            new_source: {
                type: "string",
                description: "单元格的新源代码内容",
            },
            edit_mode: {
                type: "string",
                description: "编辑模式: replace（替换）、insert（插入）、delete（删除）",
                enum: ["replace", "insert", "delete"],
                default: "replace",
            },
        },
        required: ["notebook_path", "new_source"],
    } as unknown as JSONSchema;

    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const notebookPath = params.notebook_path as string;
        const cellId = params.cell_id as string | undefined;
        const cellType = (params.cell_type as "code" | "markdown") ?? "code";
        const newSource = params.new_source as string;
        const editMode = (params.edit_mode as "replace" | "insert" | "delete") ?? "replace";

        try {
            const content = await fs.readFile(notebookPath, "utf-8");
            const notebook = JSON.parse(content);

            if (!notebook.cells || !Array.isArray(notebook.cells)) {
                return { tool_use_id: "", content: "无效的 Notebook 格式: 缺少 cells 数组", is_error: true };
            }

            const cells = notebook.cells as Array<Record<string, unknown>>;

            switch (editMode) {
                case "replace": {
                    const targetIdx = cellId
                        ? cells.findIndex((c) => c.id === cellId)
                        : 0;
                    if (targetIdx === -1) {
                        return { tool_use_id: "", content: `未找到 cell_id="${cellId}"`, is_error: true };
                    }
                    const oldSource = cells[targetIdx].source;
                    cells[targetIdx] = {
                        ...cells[targetIdx],
                        cell_type: cellType,
                        source: newSource,
                    };
                    return {
                        tool_use_id: "",
                        content: `已替换单元格 [${targetIdx}] (id: ${cells[targetIdx].id})\n旧内容: ${typeof oldSource === "string" ? oldSource.slice(0, 100) : JSON.stringify(oldSource).slice(0, 100)}...\n→ 新内容已写入`,
                    };
                }
                case "insert": {
                    const insertIdx = cellId
                        ? cells.findIndex((c) => c.id === cellId) + 1
                        : 0;
                    const newCell = {
                        cell_type: cellType,
                        source: newSource,
                        metadata: {},
                        id: `${cellType}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    };
                    cells.splice(insertIdx, 0, newCell);
                    return {
                        tool_use_id: "",
                        content: `已在位置 [${insertIdx}] 插入新的 ${cellType} 单元格 (id: ${newCell.id})`,
                    };
                }
                case "delete": {
                    if (!cellId) {
                        return { tool_use_id: "", content: "删除模式需要提供 cell_id", is_error: true };
                    }
                    const deleteIdx = cells.findIndex((c) => c.id === cellId);
                    if (deleteIdx === -1) {
                        return { tool_use_id: "", content: `未找到 cell_id="${cellId}"`, is_error: true };
                    }
                    cells.splice(deleteIdx, 1);
                    return {
                        tool_use_id: "",
                        content: `已删除单元格 (id: ${cellId})，位置 [${deleteIdx}]`,
                    };
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return { tool_use_id: "", content: `文件不存在: ${notebookPath}`, is_error: true };
            }
            return {
                tool_use_id: "",
                content: `Notebook 编辑失败: ${error instanceof Error ? error.message : String(error)}`,
                is_error: true,
            };
        }
    }

    requiresApproval(): boolean { return true; }
}
