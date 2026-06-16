// ─── packages/core/src/agent/plan-mode-manager.ts ───
// PlanModeManager — Plan Mode 状态管理
// 解决问题: 将 Plan Mode 的三层检查逻辑从 AgentLoop 中抽离为独立模块。
//          负责: 模式切换检测、工具过滤、规划闸门执行。
//          AgentLoop 只需调用三个钩子即可，无需关心 Plan Mode 内部状态。

import type { ToolUse } from "../types/messages";
import type { TurnEvent } from "../types/agent";
import { filterToolsForPlanMode, getCurrentPlan } from "../tools/builtin/plan-mode";
import { TodoWriteTool } from "../tools/builtin/todo";

/**
 * PlanEnforcementMode — 规划强制执行级别
 * - "off": 不强制执行（向后兼容，Plan Mode 仅做工具过滤）
 * - "soft": 软提醒（首次修改注入提示，二次修改硬拒绝）
 * - "hard": 硬模式（无计划拒绝所有修改，漂移 3 次后强制重规划）
 */
export type PlanEnforcementMode = "off" | "soft" | "hard";

export class PlanModeManager {
    /** 当前是否处于计划模式 */
    private planMode = false;
    /** 强制执行级别 */
    private enforcementMode: PlanEnforcementMode = "soft";

    /**
     * 修改类工具名集合 — 只有这些工具才需要规划闸门检查
     * 为什么是这三个: Read/Glob/Grep 等只读工具在 Plan Mode 下本身就被过滤掉了，
     * 不需要闸门；Write/Edit/Bash 是实际的修改操作，需要检查。
     */
    private static readonly MODIFY_TOOLS = new Set(["Write", "Edit", "Bash"]);

    get isPlanMode(): boolean { return this.planMode; }

    /**
     * 重置 Plan Mode 状态（每次 run() 初始化时调用）
     * 为什么每次 run() 都要重置: Plan Mode 是单次 Agent 会话内的状态，
     * 不应跨 run() 调用保留。
     */
    reset(enforcement: PlanEnforcementMode): void {
        this.planMode = false;
        this.enforcementMode = enforcement;
    }

    // ─── 钩子 1: beforeLLMCall — 过滤工具列表 ───

    /**
     * 在 LLM 调用前过滤工具列表
     * 为什么计划模式下要过滤工具: LLM 在计划阶段应只能探索和设计，
     * 不应执行修改操作。限制为只读工具强制执行这一约束。
     */
    filterTools(tools: import("../types/tools").Tool[]): import("../types/tools").Tool[] {
        if (!this.planMode) return tools;
        return filterToolsForPlanMode(tools);
    }

    // ─── 钩子 2: beforeToolExecution — 规划闸门检查 ───

    /**
     * 在修改工具执行前检查规划闸门
     * 为什么需要三级闸门 (off/soft/hard):
     *   - off: 完全跳过，用于熟悉系统的用户或简单任务
     *   - soft: 首次修改提醒、二次拒绝，平衡提示与自由
     *   - hard: 无计划拒绝修改，适合团队强制要求任务规划的场景
     *
     * @returns blocked=true 时调用方应拒绝执行，message 为提示文本
     */
    enforceGate(toolName: string): { blocked: boolean; message?: string } {
        // off 模式 — 完全跳过闸门
        if (this.enforcementMode === "off") return { blocked: false };
        // 只读工具 — 不需要计划
        if (!PlanModeManager.MODIFY_TOOLS.has(toolName)) return { blocked: false };

        // 已有计划 — 检查是否漂移
        if (TodoWriteTool.hasActivePlan()) {
            const alignment = TodoWriteTool.checkPlanAlignment(toolName);
            if (!alignment.aligned) {
                const drifts = TodoWriteTool.trackDrift();
                // 漂移 3 次 + hard 模式 — 强制拒绝，要求更新计划
                if (drifts >= 3 && this.enforcementMode === "hard") {
                    return {
                        blocked: true,
                        message: `计划漂移警告 (第 ${drifts} 次): 当前操作 "${toolName}" 似乎与正在执行的任务无关。请更新 TodoWrite 或解释此操作的必要性。`,
                    };
                }
                return { blocked: false, message: alignment.warning };
            }
            return { blocked: false };
        }

        // 无计划 — 按修改次数决定行为
        const modifyCount = TodoWriteTool.trackModifyCallWithoutPlan();
        // 第 2 次无计划修改 — 硬拒绝
        if (modifyCount >= 2) {
            return {
                blocked: true,
                message: `需要先创建任务计划。已执行 ${modifyCount} 个修改操作但未使用 TodoWrite。请立即调用 TodoWrite 将任务分解为具体步骤后继续。`,
            };
        }

        // 首次无计划修改 — 软提醒
        return {
            blocked: false,
            message: "提醒: 建议先用 TodoWrite 创建任务计划来跟踪进度。",
        };
    }

    // ─── 钩子 3: afterToolExecution — 检测 EnterPlanMode / ExitPlanMode ───

    /**
     * 检测并处理 Plan Mode 状态切换
     * 为什么在工具执行后检测: EnterPlanMode/ExitPlanMode 是特殊的工具调用，
     * 它们在 executeToolPhase 中被执行，状态切换应在 finalizeRound 中完成。
     *
     * @returns 异步生成器，yield plan_mode_entered / plan_mode_exited 事件
     */
    async *handleTransitions(toolUses: ToolUse[]): AsyncGenerator<TurnEvent, void> {
        for (const toolUse of toolUses) {
            if (toolUse.name === "EnterPlanMode") {
                // 防止重复进入: 已在计划模式时忽略再次 EnterPlanMode
                if (!this.planMode) {
                    this.planMode = true;
                    yield { type: "plan_mode_entered", message: "已进入计划模式，仅可使用只读工具进行代码探索和方案设计" };
                }
            } else if (toolUse.name === "ExitPlanMode") {
                // 防止重复退出: 非计划模式时忽略 ExitPlanMode
                if (this.planMode) {
                    this.planMode = false;
                    yield { type: "plan_mode_exited", plan: getCurrentPlan() || "计划已提交，退出计划模式" };
                }
            }
        }
    }
}
