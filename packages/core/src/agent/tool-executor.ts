// ─── packages/core/src/agent/tool-executor.ts ───
// ToolExecutor — 工具执行管道
// 解决问题: 将 executeToolPhase 中的工具查找、熔断检查、权限校验、
//          规划闸门、工具执行、错误处理从 AgentLoop 中抽离为独立模块。
//          抽离原因: 这 ~140 行管道逻辑是一个自包含的处理链，
//          只依赖外部服务（PermissionManager、ErrorRecoveryManager 等），
//          不依赖 AgentLoop 内部状态，天然适合独立。

import type { TurnEvent } from "../types/agent";
import type { ToolUse, ToolResult } from "../types/messages";
import type { Tool, ToolContext, ISandbox, Logger } from "../types/tools";
import type { PermissionManager } from "../permission/manager";
import type { ErrorRecoveryManager } from "./error-recovery/manager";
import { RecoveryStrategy } from "./error-recovery/types";
import type { ObservabilityManager } from "../observability/manager";
import { PlanModeManager } from "./plan-mode-manager";

/**
 * ToolExecutorContext — 工具执行管道所需的全部运行时依赖
 * 解决问题: 将 6 个外部服务（权限、恢复、可观测、PlanMode、沙箱、日志）
 *          收敛为一个上下文对象，避免 executeAll 参数列表过长。
 */
export interface ToolExecutorContext {
    /** 已注册的工具列表 */
    tools: Tool[];
    /** 权限管理器 — 执行前检查用户是否授权 */
    permissionManager: PermissionManager;
    /** 错误恢复管理器（可选） — 处理工具错误、熔断检查 */
    errorRecoveryManager?: ErrorRecoveryManager;
    /** 可观测性管理器（可选） — 记录工具调用 Span */
    observability?: ObservabilityManager;
    /** Plan Mode 管理器 — 规划闸门检查 */
    planModeManager: PlanModeManager;
    /** 当前工作目录 */
    workingDirectory: string;
    /** 会话 ID */
    sessionId: string;
    /** 向 UI 推送消息的回调 */
    appendMessage: (content: string) => Promise<void>;
    /** 沙箱实例（可选） — 隔离执行 Bash 命令 */
    sandbox?: ISandbox;
    /** 日志器（可选） */
    logger?: Logger;
    /** 取消信号 */
    signal: AbortSignal;
}

export class ToolExecutor {
    /**
     * 逐个执行工具调用管道
     *
     * 为什么顺序执行而非并发:
     *   工具调用之间可能存在依赖（如 Read → Edit），顺序执行保证可预测性。
     *   同一轮中的多个 tool_use 按 LLM 返回顺序逐个处理。
     *
     * 为什么用回调通知状态变更而非直接修改 AgentLoop 状态:
     *   ToolExecutor 不应知道 AgentLoop 的存在，通过 onStateChange / onConsecutiveError
     *   回调解耦，AgentLoop 自行决定如何响应（设置 state、递增错误计数等）。
     *
     * @param toolUses - LLM 返回的工具调用列表
     * @param ctx - 运行时依赖
     * @param onStateChange - 状态变更回调（"WAITING_APPROVAL" / "EXECUTING"）
     * @param onConsecutiveError - 连续错误回调（true=发生错误, false=执行成功）
     * @returns { toolResults, abort } — abort 为 true 表示熔断触发需终止 Agent 循环
     */
    async *executeAll(
        toolUses: ToolUse[],
        ctx: ToolExecutorContext,
        onStateChange: (state: string) => void,
        onConsecutiveError: (isError: boolean) => void,
    ): AsyncGenerator<TurnEvent, { toolResults: ToolResult[]; abort: boolean }> {
        const toolResults: ToolResult[] = [];

        for (const toolUse of toolUses) {
            yield { type: "tool_call", tool: toolUse };

            // ─── 可观测性: 记录工具调用 Span ───
            const toolSpanId = ctx.observability?.recordToolCall(
                toolUse.name,
                Object.keys(toolUse.input),
            ) ?? "";

            // ─── 步骤 1: 查找工具 ───
            // 为什么 LLM 可能返回不存在的工具名: LLM 幻觉或配置变更导致
            // tools 列表与 LLM 训练数据不一致。返回 is_error 让 LLM 自行纠正。
            const tool = ctx.tools.find((t) => t.name === toolUse.name);
            if (!tool) {
                const recovery = ctx.errorRecoveryManager?.handleToolNotFound(toolUse.name);
                toolResults.push({
                    tool_use_id: toolUse.id,
                    content: recovery?.error ?? `未知工具: ${toolUse.name}`,
                    is_error: true,
                });
                onConsecutiveError(true);
                continue;
            }

            // ─── 步骤 2: 熔断器检查 ───
            // 为什么在权限检查之前: 如果工具已熔断，没必要再弹权限确认窗。
            // 熔断状态由 ErrorRecoveryManager 内部维护（CLOSED → OPEN → HALF_OPEN）。
            if (ctx.errorRecoveryManager && !ctx.errorRecoveryManager.checkCircuitBreaker(toolUse.name)) {
                const remainingMs = ctx.errorRecoveryManager.circuitBreaker.getRemainingOpenMs(toolUse.name);
                toolResults.push({
                    tool_use_id: toolUse.id,
                    content: `工具 "${toolUse.name}" 已触发熔断保护，${Math.ceil(remainingMs / 1000)}s 后可重试`,
                    is_error: true,
                });
                onConsecutiveError(true);
                continue;
            }

            // ─── 步骤 3: 权限检查 ───
            // 为什么 willPromptUser 在 check 之前调用:
            //   willPromptUser 是同步的，用于判断是否需要展示"等待确认"UI 状态；
            //   check 是异步的（可能弹窗等待用户输入），两者分离避免重复匹配。
            if (tool.requiresApproval(toolUse.input)) {
                if (ctx.permissionManager.willPromptUser(toolUse)) {
                    onStateChange("WAITING_APPROVAL");
                    yield { type: "approval_request", tool: toolUse };
                }

                const approved = await ctx.permissionManager.check(toolUse);
                if (!approved) {
                    const recovery = ctx.errorRecoveryManager?.handlePermDenied(toolUse.name);
                    toolResults.push({
                        tool_use_id: toolUse.id,
                        content: recovery?.error ?? "用户拒绝了此操作",
                        is_error: true,
                    });
                    onConsecutiveError(true);
                    continue;
                }
            }

            // ─── 步骤 4: 规划闸门检查 ───
            // 为什么在权限后、执行前: 权限是安全底线（不可绕过），
            // 规划闸门是工作流建议（软性约束），顺序体现优先级。
            const gateResult = ctx.planModeManager.enforceGate(toolUse.name);
            if (gateResult.blocked) {
                toolResults.push({
                    tool_use_id: toolUse.id,
                    content: gateResult.message!,
                    is_error: true,
                });
                onConsecutiveError(true);
                continue;
            }

            // ─── 步骤 5: 执行工具 ───
            const toolCtx: ToolContext = {
                workingDirectory: ctx.workingDirectory,
                sessionId: ctx.sessionId,
                appendMessage: ctx.appendMessage,
                sandbox: ctx.sandbox,
                logger: ctx.logger,
                signal: ctx.signal,
            };

            onStateChange("EXECUTING");
            try {
                const result = await tool.execute(toolUse.input, toolCtx);
                // 软提醒注入: 闸门返回了提醒信息但未阻止执行时，
                // 将提醒前置到工具结果中，LLM 在下一轮可以看到。
                const finalResult = gateResult.message
                    ? { ...result, content: `[规划提醒] ${gateResult.message}\n${result.content}` }
                    : result;
                toolResults.push({ ...finalResult, tool_use_id: toolUse.id });
                onConsecutiveError(false);
                // 执行成功 → 通知熔断器（重置窗口内失败计数）
                ctx.errorRecoveryManager?.recordToolSuccess(toolUse.name);
                yield { type: "tool_result", result };
                ctx.observability?.recordToolResult(
                    toolSpanId, toolUse.name, false,
                    typeof result.content === "string" ? result.content : JSON.stringify(result.content),
                );
            } catch (error) {
                // ─── 步骤 6: 错误处理 ───
                // 为什么工具错误不直接终止循环:
                //   大部分工具错误（文件不存在、命令执行失败等）应反馈给 LLM
                //   让其自行调整策略。只有 CIRCUIT_BREAK（系统性故障）才终止。
                const err = error instanceof Error ? error : new Error(String(error));
                let errorMessage = `工具执行失败: ${err.message}`;

                if (ctx.errorRecoveryManager) {
                    const recovery = ctx.errorRecoveryManager.handleToolError(err, toolUse.name);
                    // 熔断触发 — 这是唯一需要终止 Agent 循环的工具错误场景
                    if (recovery.strategy === RecoveryStrategy.CIRCUIT_BREAK) {
                        yield {
                            type: "error",
                            error: new Error(recovery.error ?? "工具熔断保护触发"),
                            category: "circuit_breaker" as never,
                        };
                        return { toolResults, abort: true };
                    }
                    errorMessage = recovery.error ?? errorMessage;
                }

                const errorResult: ToolResult = {
                    tool_use_id: toolUse.id,
                    content: errorMessage,
                    is_error: true,
                };
                toolResults.push(errorResult);
                onConsecutiveError(true);
                yield { type: "tool_result", result: errorResult };
                ctx.observability?.recordToolResult(toolSpanId, toolUse.name, true, errorMessage);
            }
        }

        return { toolResults, abort: false };
    }
}
