// ─── packages/core/src/tools/builtin/cron.ts ───
// Cron 工具 — 创建/删除/列出定时任务
// 解决问题: Agent 可以安排周期性任务（如定期检查、定时提醒等）

import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";
import { CronScheduler } from "../../utils/cron";

// CronScheduler 单例（由 CLI 初始化时注入）
let schedulerInstance: CronScheduler | null = null;

export function setCronScheduler(scheduler: CronScheduler): void {
    schedulerInstance = scheduler;
}

// ─── CronCreateTool ───

export class CronCreateTool extends Tool {
    name = "CronCreate";
    description = "创建定时任务。用于安排周期性执行的任务（如定时检查、自动化脚本）。使用标准 5 字段 cron 表达式（分 时 日 月 周）。";

    parameters = {
        type: "object" as const,
        properties: {
            cron: {
                type: "string",
                description: "标准 5 字段 cron 表达式，使用用户本地时区。如 '*/5 * * * *'（每 5 分钟）、'0 9 * * *'（每天 9 点）",
            },
            prompt: {
                type: "string",
                description: "定时触发时要执行的任务描述",
            },
            recurring: {
                type: "boolean",
                description: "是否重复执行。true = 按 cron 周期重复，false = 只执行一次",
                default: true,
            },
        },
        required: ["cron", "prompt"],
    } as unknown as JSONSchema;

    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        if (!schedulerInstance) {
            return { tool_use_id: "", content: "CronScheduler 未初始化，定时任务不可用", is_error: true };
        }

        const cron = params.cron as string;
        const prompt = params.prompt as string;
        const recurring = params.recurring !== false;

        try {
            const jobData = {
                cron,
                prompt,
                recurring,
                durable: false,
            };
            const job = schedulerInstance.add(jobData);

            return {
                tool_use_id: "",
                content: `定时任务已创建:\n- ID: ${job.id}\n- Cron: ${cron}\n- 任务: ${prompt}\n- 重复: ${recurring ? "是" : "否（仅一次）"}`,
            };
        } catch (error) {
            return {
                tool_use_id: "",
                content: `创建定时任务失败: ${error instanceof Error ? error.message : String(error)}`,
                is_error: true,
            };
        }
    }

    requiresApproval(): boolean { return true; }
}

// ─── CronDeleteTool ───

export class CronDeleteTool extends Tool {
    name = "CronDelete";
    description = "删除定时任务。通过任务 ID 删除之前创建的定时任务。";

    parameters = {
        type: "object" as const,
        properties: {
            id: { type: "string", description: "要删除的定时任务 ID（CronCreate 返回的 ID）" },
        },
        required: ["id"],
    } as unknown as JSONSchema;

    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        if (!schedulerInstance) {
            return { tool_use_id: "", content: "CronScheduler 未初始化", is_error: true };
        }

        const id = params.id as string;
        const removed = schedulerInstance.remove(id);

        return {
            tool_use_id: "",
            content: removed ? `定时任务 "${id}" 已删除` : `未找到定时任务 "${id}"`,
            is_error: !removed,
        };
    }

    requiresApproval(): boolean { return true; }
}

// ─── CronListTool ───

export class CronListTool extends Tool {
    name = "CronList";
    description = "列出所有定时任务。显示当前活跃的定时任务及其状态。";

    parameters = {
        type: "object" as const,
        properties: {},
        required: [],
    } as unknown as JSONSchema;

    async execute(_params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        if (!schedulerInstance) {
            return { tool_use_id: "", content: "CronScheduler 未初始化", is_error: true };
        }

        const jobs = schedulerInstance.list();
        if (jobs.length === 0) {
            return { tool_use_id: "", content: "当前没有定时任务" };
        }

        const lines = jobs.map((j) =>
            `- [${j.id}] ${j.cron} — ${j.prompt} (${j.recurring ? "重复" : "单次"}, 创建于 ${j.createdAt})`
        );

        return {
            tool_use_id: "",
            content: `定时任务列表 (${jobs.length} 个):\n${lines.join("\n")}`,
        };
    }

    requiresApproval(): boolean { return false; }
}

// ─── ScheduleWakeupTool ───

export class ScheduleWakeupTool extends Tool {
    name = "ScheduleWakeup";
    description = "安排 Agent 在指定时间后自动唤醒继续工作。用于需要等待外部事件完成的场景。";

    parameters = {
        type: "object" as const,
        properties: {
            delaySeconds: {
                type: "number",
                description: "唤醒延迟秒数（60-3600 之间）",
                minimum: 60,
                maximum: 3600,
            },
            reason: {
                type: "string",
                description: "延迟原因简述（如'等待 CI 构建完成'）",
            },
            prompt: {
                type: "string",
                description: "唤醒后继续执行的任务描述",
            },
        },
        required: ["delaySeconds", "reason", "prompt"],
    } as unknown as JSONSchema;

    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        if (!schedulerInstance) {
            return { tool_use_id: "", content: "CronScheduler 未初始化", is_error: true };
        }

        const delaySeconds = params.delaySeconds as number;
        const reason = params.reason as string;
        const prompt = params.prompt as string;

        // 将延迟转换为 cron 表达式（一次性任务）
        const wakeTime = new Date(Date.now() + delaySeconds * 1000);
        const cronExpr = `${wakeTime.getMinutes()} ${wakeTime.getHours()} ${wakeTime.getDate()} ${wakeTime.getMonth() + 1} *`;

        const job = schedulerInstance.add({
            cron: cronExpr,
            prompt,
            recurring: false,
            durable: false,
        });

        return {
            tool_use_id: "",
            content: `已安排 ${delaySeconds}s 后唤醒\n- 原因: ${reason}\n- 任务: ${prompt}\n- 预计唤醒: ${wakeTime.toISOString()}`,
        };
    }

    requiresApproval(): boolean { return false; }
}
