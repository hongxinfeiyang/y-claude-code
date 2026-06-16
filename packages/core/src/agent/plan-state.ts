// ─── packages/core/src/agent/plan-state.ts ───
// PlanState — 规划闸门状态持有者
// 解决问题: 将 TodoWriteTool 中的静态规划状态（todos、修改计数、漂移计数）
//          抽取为独立对象，由 AgentLoop 创建和拥有，TodoWriteTool 通过注入访问。
//          这样解耦了 AgentLoop 和 TodoWriteTool 之间的隐式静态耦合。

export interface PlanTodo {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
}

export class PlanState {
    todos: PlanTodo[] = [];
    modifyCallsWithoutPlan = 0;
    driftWarnings = 0;

    hasActivePlan(): boolean {
        return this.todos.length > 0;
    }

    trackModifyCallWithoutPlan(): number {
        this.modifyCallsWithoutPlan++;
        return this.modifyCallsWithoutPlan;
    }

    checkPlanAlignment(_toolName: string): { aligned: boolean; warning?: string } {
        if (!this.hasActivePlan()) return { aligned: true };
        const active = this.todos.find((t) => t.status === "in_progress");
        if (!active) return { aligned: true };
        return { aligned: true };
    }

    trackDrift(): number {
        this.driftWarnings++;
        return this.driftWarnings;
    }

    reset(): void {
        this.todos = [];
        this.modifyCallsWithoutPlan = 0;
        this.driftWarnings = 0;
    }

    toPersistenceJSON(): object {
        return {
            todos: this.todos,
            modifyCallsWithoutPlan: this.modifyCallsWithoutPlan,
            driftWarnings: this.driftWarnings,
        };
    }

    fromPersistenceJSON(json: Record<string, unknown>): void {
        this.todos = (json.todos as PlanTodo[]) ?? [];
        this.modifyCallsWithoutPlan = (json.modifyCallsWithoutPlan as number) ?? 0;
        this.driftWarnings = (json.driftWarnings as number) ?? 0;
    }
}
