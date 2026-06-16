// ─── packages/core/src/tools/builtin/todo.ts ───
// TodoWrite 工具 — Agent 创建和管理结构化任务列表
// 解决问题：复杂多步骤任务需要跟踪进度，TodoWrite 让 Agent 自我管理任务状态

import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";
import { PlanState, PlanTodo } from "../../agent/plan-state";

/**
 * TodoWriteTool — 任务列表管理工具
 *
 * 使用场景：
 * - 复杂多步骤任务（3+ 步骤）需要跟踪进度
 * - Agent 需要对外展示当前工作状态
 * - 用户需要了解剩余工作量
 *
 * 设计考量：
 * - 规划状态通过 PlanState 对象管理，由 AgentLoop 注入
 * - 保留静态方法兼容，当未注入 PlanState 时使用内部默认实例
 */
export class TodoWriteTool extends Tool {
    name = "TodoWrite";
    description = "创建和管理结构化任务列表，用于跟踪复杂多步骤任务的进度。每个任务有 content（描述）、status（pending/in_progress/completed）、activeForm（进行中的描述）。同时只能有一个 in_progress 任务。";

    parameters = {
        type: "object" as const,
        properties: {
            todos: {
                type: "array",
                description: "任务列表",
                items: {
                    type: "object",
                    properties: {
                        content: { type: "string", description: "任务描述（祈使句，如'修复登录 bug'）" },
                        status: {
                            type: "string",
                            description: "任务状态",
                            enum: ["pending", "in_progress", "completed"],
                        },
                        activeForm: { type: "string", description: "进行中的描述（如'正在修复登录 bug'）" },
                    },
                },
            },
        },
        required: ["todos"],
    } as unknown as JSONSchema;

    /** 可注入的规划状态实例，未注入时使用内部默认实例 */
    private static _planState: PlanState | null = null;
    private static _defaultPlanState: PlanState = new PlanState();

    private static get planState(): PlanState {
        return TodoWriteTool._planState ?? TodoWriteTool._defaultPlanState;
    }

    /** 注入外部 PlanState（由 AgentLoop 在 run() 初始化时调用） */
    static setPlanState(state: PlanState): void {
        TodoWriteTool._planState = state;
    }

    /** 清除外部注入，回退到默认实例 */
    static clearPlanState(): void {
        TodoWriteTool._planState = null;
    }

    static getTodos(): Array<{ content: string; status: string; activeForm: string }> {
        return [...TodoWriteTool.planState.todos];
    }

    /** AgentLoop 闸门：是否存在活跃计划 */
    static hasActivePlan(): boolean {
        return TodoWriteTool.planState.hasActivePlan();
    }

    /** AgentLoop 闸门：递增无计划修改计数，返回当前计数 */
    static trackModifyCallWithoutPlan(): number {
        return TodoWriteTool.planState.trackModifyCallWithoutPlan();
    }

    /** AgentLoop 闸门：检查工具调用是否与当前 in_progress 任务对齐 */
    static checkPlanAlignment(_toolName: string): { aligned: boolean; warning?: string } {
        return TodoWriteTool.planState.checkPlanAlignment(_toolName);
    }

    /** AgentLoop 闸门：递增漂移计数 */
    static trackDrift(): number {
        return TodoWriteTool.planState.trackDrift();
    }

    /** AgentLoop 闸门：重置会话状态 */
    static resetSession(): void {
        TodoWriteTool.planState.reset();
    }

    /** 记忆持久化：序列化当前任务状态 */
    static toPersistenceJSON(): object {
        return TodoWriteTool.planState.toPersistenceJSON();
    }

    /** 记忆持久化：从序列化数据恢复状态 */
    static fromPersistenceJSON(json: Record<string, unknown>): void {
        TodoWriteTool.planState.fromPersistenceJSON(json);
    }

    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        const todos = params.todos as Array<{ content: string; status: string; activeForm: string }> | undefined;

        if (!todos?.length) {
            return { tool_use_id: "", content: "todos 参数不能为空", is_error: true };
        }

        // 校验：只能有一个 in_progress
        const inProgress = todos.filter((t) => t.status === "in_progress");
        if (inProgress.length > 1) {
            return {
                tool_use_id: "",
                content: `不能有多个 in_progress 任务，当前有 ${inProgress.length} 个: ${inProgress.map((t) => t.content).join(", ")}`,
                is_error: true,
            };
        }

        TodoWriteTool.planState.todos = todos as PlanTodo[];

        // 格式化展示
        const statusIcons: Record<string, string> = { pending: " ", in_progress: "▸", completed: "✓" };
        const lines = todos.map((t) => {
            const icon = statusIcons[t.status] ?? " ";
            const name = t.status === "in_progress" ? t.activeForm : t.content;
            return `- [${icon}] ${name}`;
        });

        return {
            tool_use_id: "",
            content: `任务列表已更新:\n${lines.join("\n")}`,
        };
    }

    requiresApproval(): boolean {
        return false;
    }
}
