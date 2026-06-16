// ─── packages/core/src/agent/plan-state.ts ───
// PlanState — 规划闸门状态持有者
// 解决问题: 将 TodoWriteTool 中的静态规划状态（todos、修改计数、漂移计数）
//          抽取为独立对象，由 AgentLoop 创建和拥有，TodoWriteTool 通过注入访问。
//          这样解耦了 AgentLoop 和 TodoWriteTool 之间的隐式静态耦合。
//
// 设计要点:
//   - PlanState 是纯数据 + 简单逻辑，不依赖任何外部模块
//   - 支持持久化（toPersistenceJSON / fromPersistenceJSON）
//   - 由 AgentLoop.run() 创建并注入到 TodoWriteTool，确保会话隔离

/**
 * PlanTodo — 单个计划任务
 * 状态三态: pending（待执行）/ in_progress（执行中）/ completed（已完成）
 */
export interface PlanTodo {
    /** 任务描述（祈使句，如"修复登录 bug"） */
    content: string;
    /** 任务状态 */
    status: "pending" | "in_progress" | "completed";
    /** 进行中的描述（如"正在修复登录 bug"），status 为 in_progress 时展示此文本 */
    activeForm: string;
}

export class PlanState {
    /** 当前任务列表 */
    todos: PlanTodo[] = [];
    /** 无计划时的修改操作计数 — 用于 enforceGate 的 soft/hard 分级 */
    modifyCallsWithoutPlan = 0;
    /** 计划漂移警告计数 — 用于 hard 模式下触发强制重规划 */
    driftWarnings = 0;

    /**
     * 是否存在活跃计划
     * 为什么判断依据是 todos 长度: 空列表 = 未调用 TodoWrite = 无计划
     */
    hasActivePlan(): boolean {
        return this.todos.length > 0;
    }

    /**
     * 递增无计划修改计数
     * 为什么是递增而非直接设置: enforceGate 需要累计值来判断首次提醒 vs 二次拒绝
     */
    trackModifyCallWithoutPlan(): number {
        this.modifyCallsWithoutPlan++;
        return this.modifyCallsWithoutPlan;
    }

    /**
     * 检查工具调用是否与当前 in_progress 任务对齐
     * 当前实现: 只要有 in_progress 任务即认为对齐（软性启发式）
     * 未来可扩展为更细粒度的匹配（如工具名与任务描述的关键词匹配）
     */
    checkPlanAlignment(_toolName: string): { aligned: boolean; warning?: string } {
        if (!this.hasActivePlan()) return { aligned: true };
        const active = this.todos.find((t) => t.status === "in_progress");
        if (!active) return { aligned: true };
        return { aligned: true };
    }

    /**
     * 递增漂移计数
     * 为什么需要独立计数: 漂移不同于无计划修改 — 有计划但偏离了计划，
     *   需要独立的阈值（3 次）来触发强制重规划。
     */
    trackDrift(): number {
        this.driftWarnings++;
        return this.driftWarnings;
    }

    /**
     * 重置所有状态 — 每次 run() 初始化时调用
     * 为什么每次 run() 都要重置: 规划状态是会话级状态，
     *   不应跨 Agent 对话保留。
     */
    reset(): void {
        this.todos = [];
        this.modifyCallsWithoutPlan = 0;
        this.driftWarnings = 0;
    }

    // ─── 持久化支持 ───

    /** 序列化为可持久化的 JSON 对象 */
    toPersistenceJSON(): object {
        return {
            todos: this.todos,
            modifyCallsWithoutPlan: this.modifyCallsWithoutPlan,
            driftWarnings: this.driftWarnings,
        };
    }

    /** 从持久化的 JSON 对象恢复状态 */
    fromPersistenceJSON(json: Record<string, unknown>): void {
        this.todos = (json.todos as PlanTodo[]) ?? [];
        this.modifyCallsWithoutPlan = (json.modifyCallsWithoutPlan as number) ?? 0;
        this.driftWarnings = (json.driftWarnings as number) ?? 0;
    }
}
