// ─── packages/core/src/tools/builtin/task.ts ───
// TaskOutput / TaskStop 工具 — 后台任务输出和停止
// 解决问题: 主 Agent 在后台启动了子代理或 Bash 任务后，需要查看结果或停止任务

import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";

// 后台任务注册表（由 AgentLoop 管理）
interface BackgroundTask {
    id: string;
    type: string;
    description: string;
    status: "running" | "completed" | "error";
    output?: string;
    error?: string;
    createdAt: number;
}

const backgroundTasks = new Map<string, BackgroundTask>();

export function registerBackgroundTask(task: BackgroundTask): void {
    backgroundTasks.set(task.id, task);
}

export function updateBackgroundTask(id: string, update: Partial<BackgroundTask>): void {
    const existing = backgroundTasks.get(id);
    if (existing) {
        backgroundTasks.set(id, { ...existing, ...update });
    }
}

// ─── TaskOutputTool ───

export class TaskOutputTool extends Tool {
    name = "TaskOutput";
    description = "获取后台运行任务的输出内容。用于查看子代理或后台 Bash 命令的执行状态和结果。";

    parameters = {
        type: "object" as const,
        properties: {
            task_id: { type: "string", description: "任务 ID（由启动后台任务的工具返回）" },
            block: { type: "boolean", description: "是否阻塞等待任务完成（默认 true）", default: true },
            timeout: { type: "number", description: "最大等待毫秒数（默认 30000）", default: 30000 },
        },
        required: ["task_id"],
    } as unknown as JSONSchema;

    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        const taskId = params.task_id as string;
        const task = backgroundTasks.get(taskId);

        if (!task) {
            return {
                tool_use_id: "",
                content: `未找到任务 "${taskId}"。可用的任务 ID: ${Array.from(backgroundTasks.keys()).join(", ") || "无"}`,
                is_error: true,
            };
        }

        const statusLabel: Record<string, string> = {
            running: "运行中",
            completed: "已完成",
            error: "出错",
        };

        let output = `## 任务: ${taskId}\n- 类型: ${task.type}\n- 描述: ${task.description}\n- 状态: ${statusLabel[task.status]}`;

        if (task.output) {
            output += `\n\n### 输出\n${task.output}`;
        }
        if (task.error) {
            output += `\n\n### 错误\n${task.error}`;
        }

        return { tool_use_id: "", content: output };
    }

    requiresApproval(): boolean { return false; }
}

// ─── TaskStopTool ───

export class TaskStopTool extends Tool {
    name = "TaskStop";
    description = "停止正在运行的后台任务。通过任务 ID 终止指定任务。";

    parameters = {
        type: "object" as const,
        properties: {
            task_id: { type: "string", description: "要停止的任务 ID" },
        },
        required: ["task_id"],
    } as unknown as JSONSchema;

    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        const taskId = params.task_id as string;
        const task = backgroundTasks.get(taskId);

        if (!task) {
            return {
                tool_use_id: "",
                content: `未找到任务 "${taskId}"`,
                is_error: true,
            };
        }

        if (task.status !== "running") {
            return {
                tool_use_id: "",
                content: `任务 "${taskId}" 已经结束 (状态: ${task.status})`,
            };
        }

        task.status = "completed";
        task.output = (task.output ?? "") + "\n[任务已被手动停止]";
        return { tool_use_id: "", content: `任务 "${taskId}" 已停止` };
    }

    requiresApproval(): boolean { return true; }
}
