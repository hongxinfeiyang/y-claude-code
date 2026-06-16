// ─── packages/core/src/agent/plan-mode-manager.ts ───
// PlanModeManager — Plan Mode 状态管理
// 解决问题: 将 Plan Mode 的三层检查逻辑从 AgentLoop 中抽离为独立模块。
//          负责: 模式切换检测、工具过滤、规划闸门执行。
//          AgentLoop 只需调用三个钩子即可。

import type { ToolUse } from "../types/messages";
import type { AgentConfig, TurnEvent } from "../types/agent";
import { filterToolsForPlanMode, getCurrentPlan } from "../tools/builtin/plan-mode";
import { TodoWriteTool } from "../tools/builtin/todo";

export type PlanEnforcementMode = "off" | "soft" | "hard";

export class PlanModeManager {
    private planMode = false;
    private enforcementMode: PlanEnforcementMode = "soft";

    private static readonly MODIFY_TOOLS = new Set(["Write", "Edit", "Bash"]);

    get isPlanMode(): boolean { return this.planMode; }

    reset(enforcement: PlanEnforcementMode): void {
        this.planMode = false;
        this.enforcementMode = enforcement;
    }

    // ─── 钩子 1: beforeLLMCall — 过滤工具列表 ───

    filterTools(tools: import("../types/tools").Tool[]): import("../types/tools").Tool[] {
        if (!this.planMode) return tools;
        return filterToolsForPlanMode(tools);
    }

    // ─── 钩子 2: beforeToolExecution — 规划闸门检查 ───

    enforceGate(toolName: string): { blocked: boolean; message?: string } {
        if (this.enforcementMode === "off") return { blocked: false };
        if (!PlanModeManager.MODIFY_TOOLS.has(toolName)) return { blocked: false };

        if (TodoWriteTool.hasActivePlan()) {
            const alignment = TodoWriteTool.checkPlanAlignment(toolName);
            if (!alignment.aligned) {
                const drifts = TodoWriteTool.trackDrift();
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

        const modifyCount = TodoWriteTool.trackModifyCallWithoutPlan();
        if (modifyCount >= 2) {
            return {
                blocked: true,
                message: `需要先创建任务计划。已执行 ${modifyCount} 个修改操作但未使用 TodoWrite。请立即调用 TodoWrite 将任务分解为具体步骤后继续。`,
            };
        }

        return {
            blocked: false,
            message: "提醒: 建议先用 TodoWrite 创建任务计划来跟踪进度。",
        };
    }

    // ─── 钩子 3: afterToolExecution — 检测 EnterPlanMode / ExitPlanMode ───

    async *handleTransitions(toolUses: ToolUse[]): AsyncGenerator<TurnEvent, void> {
        for (const toolUse of toolUses) {
            if (toolUse.name === "EnterPlanMode") {
                if (!this.planMode) {
                    this.planMode = true;
                    yield { type: "plan_mode_entered", message: "已进入计划模式，仅可使用只读工具进行代码探索和方案设计" };
                }
            } else if (toolUse.name === "ExitPlanMode") {
                if (this.planMode) {
                    this.planMode = false;
                    yield { type: "plan_mode_exited", plan: getCurrentPlan() || "计划已提交，退出计划模式" };
                }
            }
        }
    }
}
