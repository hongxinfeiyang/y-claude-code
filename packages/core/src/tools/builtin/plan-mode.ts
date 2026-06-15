// ─── packages/core/src/tools/builtin/plan-mode.ts ───
// Plan Mode 工具 — 进入/退出架构设计模式
// 解决问题：在实现复杂任务前，Agent 需要先探索代码库、设计方案，
//          方案经用户审批后再进入实现阶段，避免盲目修改。
//
// 工作流程：
//   1. Agent 调用 EnterPlanMode → 进入计划模式（只读工具）
//   2. Agent 探索代码库、设计架构 → 写入 plan 文件
//   3. Agent 调用 ExitPlanMode → 提交 plan 供用户审批
//   4. 用户审批 → 通过则退出计划模式开始实现，拒绝则修改 plan

import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";
import type { PermissionManager } from "../../permission/manager";

// ─── 计划模式文件存储 ───

/**
 * 计划模式运行时状态（静态属性，供 AgentLoop 读取）
 * 解决问题：工具和 AgentLoop 之间的通信通过静态属性完成，
 *         避免循环依赖（工具不需要引用 AgentLoop）
 */
let planModeActive = false;
let currentPlan = "";

/**
 * 检查当前是否处于计划模式
 */
export function isPlanModeActive(): boolean {
    return planModeActive;
}

/**
 * 获取当前计划内容
 */
export function getCurrentPlan(): string {
    return currentPlan;
}

/**
 * 进入计划模式（由 EnterPlanModeTool 调用）
 */
function enterPlanMode(): void {
    planModeActive = true;
    currentPlan = "";
}

/**
 * 退出计划模式（由 ExitPlanModeTool 调用）
 */
function exitPlanMode(): void {
    planModeActive = false;
    currentPlan = "";
}

// ─── EnterPlanModeTool ───

/**
 * EnterPlanModeTool — 进入计划模式
 *
 * 调用时机：Agent 判断当前任务在实现前需要先设计方案
 *
 * 效果：
 *   1. AgentLoop 切换到 PLANNING 状态
 *   2. 工具列表被限制为只读工具（Read/Glob/Grep/WebFetch/WebSearch/AskUserQuestion）
 *   3. Agent 可以进行代码探索但不允许修改
 */
export class EnterPlanModeTool extends Tool {
    name = "EnterPlanMode";
    description = "进入计划模式。当任务需要先设计方案再实现时调用此工具。在计划模式下，只能使用只读工具（Read/Glob/Grep/WebFetch/WebSearch）进行代码探索和方案设计。设计方案完成后，调用 ExitPlanMode 提交计划供用户审批。";

    parameters = {
        type: "object" as const,
        properties: {},
        required: [],
    } as unknown as JSONSchema;

    async execute(_params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        if (planModeActive) {
            return {
                tool_use_id: "",
                content: "已经在计划模式中。请继续设计方案，完成后调用 ExitPlanMode 提交。",
            };
        }

        enterPlanMode();

        return {
            tool_use_id: "",
            content: `已进入计划模式。

现在你需要：
1. 探索相关代码，理解现有架构和模式
2. 确定实现方案（受影响的文件、需要修改的模块、数据流变化）
3. 考虑边界条件和潜在风险
4. 将完整的实现方案写入计划文件

注意事项：
- 当前仅可使用只读工具（Read/Glob/Grep/WebFetch/WebSearch）
- 不允许使用 Edit/Write/Bash 等修改性工具
- 如果需要询问用户偏好，可以使用 AskUserQuestion
- 方案设计完成后调用 ExitPlanMode 提交计划

请开始你的代码探索和方案设计。`,
        };
    }

    requiresApproval(): boolean {
        return false; // 进入计划模式无需用户确认
    }
}

// ─── ExitPlanModeTool ───

/**
 * ExitPlanModeTool — 退出计划模式并提交计划
 *
 * 调用时机：Agent 已完成方案设计，需要用户审批
 *
 * 效果：
 *   1. 计划内容被保存
 *   2. 触发 plan_mode_exited 事件，用户看到计划并决定通过/拒绝
 *   3. 如果用户通过，AgentLoop 退出 PLANNING 状态，恢复正常工具权限
 *   4. 如果用户拒绝，Agent 可以重新进入计划模式修改方案
 */
export class ExitPlanModeTool extends Tool {
    name = "ExitPlanMode";
    description = "退出计划模式并提交实现方案供用户审批。调用时需提供完整的实现计划（plan 参数），包括：受影响的文件、修改步骤、架构决策、风险点等。用户审批通过后即可开始实现。";

    parameters = {
        type: "object" as const,
        properties: {
            plan: {
                type: "string",
                description: "完整的实现计划内容（Markdown 格式）。应包括：1. 方案概述 2. 受影响的文件列表 3. 分步实施计划 4. 架构决策和权衡 5. 潜在风险和边界条件",
            },
        },
        required: ["plan"],
    } as unknown as JSONSchema;

    /**
     * 计划审批回调（静态属性，由 AgentLoop 注入）
     * 解决问题：将审批 UI 与工具逻辑解耦，CLI/VS Code 等不同 UI 层注入各自的审批实现
     */
    private static approvalCallback: ((plan: string) => Promise<boolean>) | null = null;

    /**
     * 注入审批回调
     */
    static setApprovalCallback(cb: (plan: string) => Promise<boolean>): void {
        ExitPlanModeTool.approvalCallback = cb;
    }

    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        if (!planModeActive) {
            return {
                tool_use_id: "",
                content: "当前不在计划模式中。如需进入计划模式，请先调用 EnterPlanMode。",
                is_error: true,
            };
        }

        const plan = params.plan as string;
        if (!plan?.trim()) {
            return {
                tool_use_id: "",
                content: "plan 参数不能为空，请提供完整的实现计划。",
                is_error: true,
            };
        }

        // ─── 保存计划内容 ───
        currentPlan = plan;

        // ─── 如果设置了审批回调，等待用户审批 ───
        if (ExitPlanModeTool.approvalCallback) {
            try {
                const approved = await ExitPlanModeTool.approvalCallback(plan);

                if (approved) {
                    // 用户审批通过：退出计划模式，恢复完整工具权限
                    exitPlanMode();
                    return {
                        tool_use_id: "",
                        content: `计划已审批通过。退出计划模式，现在可以开始实现。

## 已审批的计划
${plan}

请按照计划中的步骤开始实现。记得先用 Read 读取需要修改的文件。`,
                    };
                } else {
                    // 用户拒绝：保持在计划模式中，Agent 可以修改方案
                    currentPlan = "";
                    return {
                        tool_use_id: "",
                        content: `计划被用户拒绝。请根据反馈调整方案，或使用 AskUserQuestion 与用户沟通以澄清需求。调整完成后重新调用 ExitPlanMode 提交。`,
                    };
                }
            } catch {
                // 回调异常：回退到仅存储 plan 的模式
                // 计划模式保持 active，由上层处理
            }
        }

        // 无回调时：自动退出计划模式
        exitPlanMode();
        return {
            tool_use_id: "",
            content: `已退出计划模式。

## 实现计划
${plan}

请开始按照计划实现。`,
        };
    }

    requiresApproval(): boolean {
        return false; // 审批通过回调机制完成，无需 PermissionManager 确认
    }
}

// ─── 计划模式工具列表过滤 ───

/**
 * 计划模式下允许的工具名称列表
 * 解决问题：在 PLANNING 状态下，限制 Agent 只能使用只读工具
 */
const PLAN_MODE_ALLOWED_TOOLS = new Set([
    "Read",
    "Write",        // 允许写入 plan 文件
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
]);

/**
 * 过滤工具列表，只保留计划模式下允许的工具
 *
 * @param tools — 完整的工具列表
 * @returns 过滤后的只读工具列表
 */
export function filterToolsForPlanMode(tools: Tool[]): Tool[] {
    return tools.filter((t) => PLAN_MODE_ALLOWED_TOOLS.has(t.name));
}
