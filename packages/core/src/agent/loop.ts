// ─── packages/core/src/agent/loop.ts ───
// Agent Loop — ReAct 模式的核心循环
// 推理 → 权限检查 → 工具调用 → 观察 → 再推理 → ... → 输出最终回答
//
// 本文档实现了 Agent 的 ReAct (Reasoning + Acting) 主循环，是整个系统的调度中枢。
// ReAct 是一种让 LLM 交替进行推理和行动的范式：模型先"思考"要做什么，
// 然后调用工具执行操作，观察结果后再决定下一步，直到任务完成。
//
// 核心流程:
//   1. 用户输入 → 构建初始消息上下文（system prompt + 历史 + user input）
//   2. 调用 LLM 流式推理（THINKING 状态）
//   3. 收到工具调用 → 权限检查（WAITING_APPROVAL 状态）
//   4. 执行工具 → 收集结果（EXECUTING 状态）
//   5. 将工具结果追加到上下文 → 回到步骤 2
//   6. 无工具调用或达到最大轮次 → 结束（DONE 状态）
//
// 设计要点:
//  - 工具调用是逐个顺序执行的（非并发），保证执行顺序可预测
//  - 连续 3 次工具错误自动保护性停止，防止死循环
//  - 连续 3 次 LLM 恢复也自动停止，防止恢复死循环
//  - 每次 LLM 调用前检查上下文使用率，超过阈值主动压缩（不等待 API 报错）
//  - 工具结果追加前估算 token 数，超过上限自动截断
//  - 支持 AbortSignal 中断，确保用户可以随时取消

import type { Message, ToolUse, ToolResult, TokenUsage } from "../types/messages";
import { AgentState } from "../types/agent";
import type { AgentConfig, TurnEvent } from "../types/agent";
import type { Tool, ToolContext, ISandbox, Logger } from "../types/tools";
import type { PermissionManager } from "../permission/manager";
import { ErrorRecoveryManager } from "./error-recovery/manager";
import { RecoveryStrategy, ErrorCategory } from "./error-recovery/types";
import { Summarizer } from "../context/summarizer";
import { ObservabilityManager } from "../observability/manager";
import { filterToolsForPlanMode, getCurrentPlan } from "../tools/builtin/plan-mode";
import { TodoWriteTool } from "../tools/builtin/todo";
import { CacheManager } from "../context/cache-manager";
import { ContextMonitor } from "../context/monitor";

// ─── 默认常量 ───

/** LLM 恢复连续失败上限: 防止重试/切换Provider/压缩上下文的死循环 */
const MAX_LLM_RECOVERY = 3;

/** 工具单次结果最大 token 估算: 超过此值截断，防止撑爆上下文 */
const MAX_TOOL_RESULT_TOKENS = 8000;

/** token 估算系数: 英文约 4 字符/token，取 4 估算上界 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * 标记: AgentLoopContext — Agent 主循环的运行时依赖接口
 * 解决问题: Agent Loop 需要多个外部依赖（权限管理、沙箱、日志器等），
 *          将这些依赖集中定义为一个接口，方便注入和测试替换。
 */
export interface AgentLoopContext {
    /**
     * 标记: permissionManager — 权限管理器
     * 解决问题: 工具调用前需要检查用户是否授权，涉及文件读写、网络访问等敏感操作。
     */
    permissionManager: PermissionManager;

    /**
     * 标记: sandbox — 沙箱实例（可选）
     * 解决问题: 在隔离环境中执行工具调用，防止对主机产生不可逆影响。
     */
    sandbox?: ISandbox;

    /**
     * 标记: logger — 日志器（可选）
     * 解决问题: 记录 Agent 运行过程中的关键事件和错误，用于调试和审计。
     */
    logger?: Logger;

    /**
     * 标记: sessionId — 会话唯一标识
     * 解决问题: 区分不同的对话会话，用于工具上下文传递和日志关联。
     */
    sessionId: string;

    /**
     * 标记: workingDirectory — 工作目录路径
     * 解决问题: 工具执行时需要知道当前的工作目录，用于相对路径解析。
     */
    workingDirectory: string;

    /**
     * 标记: appendMessage — 追加消息的回调函数
     * 解决问题: Agent 在执行过程中可能需要向用户展示中间状态信息，
     *          通过此回调将消息推送到 UI 层显示。
     */
    appendMessage: (content: string) => Promise<void>;

    /**
     * 标记: signal — 取消信号（AbortSignal）
     * 解决问题: 用户可以在任意时刻取消 Agent 的运行，signal.aborted 变为 true 时主循环退出。
     */
    signal?: AbortSignal;

    /**
     * 标记: errorRecoveryManager — 错误恢复管理器（可选）
     * 解决问题: 统一处理 LLM 调用和工具执行的错误，提供重试、Provider 回退、熔断等能力。
     *         如果未提供，Agent Loop 使用默认的硬终止行为（向后兼容）。
     */
    errorRecoveryManager?: ErrorRecoveryManager;

    /**
     * 标记: summarizer — 对话摘要器（可选）
     * 解决问题: 在 CONTEXT_OVERFLOW 等场景下生成语义摘要而非丢弃消息。
     */
    summarizer?: Summarizer;

    /**
     * 标记: observability — 可观测性管理器（可选）
     * 解决问题: 记录 Transcript、收集 Metrics、追踪 Span。
     *         如果未提供，Agent Loop 正常运行但无可观测性数据。
     */
    observability?: ObservabilityManager;

    /**
     * 标记: cacheManager — Prompt Cache 管理器（可选）
     * 解决问题: 跟踪缓存状态、统计命中率、TTL 感知。
     */
    cacheManager?: CacheManager;

    /**
     * 标记: contextMonitor — 上下文窗口监控器（可选）
     * 解决问题: 实时追踪 token 使用率，接近窗口上限时主动告警。
     */
    contextMonitor?: ContextMonitor;
}

// ─── Thinking 阶段返回值 ───

interface ThinkingResult {
    /** 是否应退出 run() */
    exit: boolean;
    /** LLM 返回的工具调用列表 */
    toolUses: ToolUse[];
}

// ─── Execute 阶段返回值 ───

interface ExecuteResult {
    /** 是否因熔断等原因应终止循环 */
    abort: boolean;
    /** 收集的工具执行结果 */
    toolResults: ToolResult[];
}

/**
 * 标记: AgentLoop — ReAct 模式的核心循环控制器
 * 解决问题: 管理 Agent 的完整生命周期，包括状态机流转、LLM 请求调度、
 *          工具调用编排和错误恢复。是整个 Agent 系统的调度中枢。
 *
 * 状态机流转:
 *   IDLE → THINKING → WAITING_APPROVAL → EXECUTING → THINKING → ... → DONE
 *                                                    ↑______________|
 *                                                    工具结果追加后继续
 */
export class AgentLoop {
    /**
     * 标记: state — Agent 当前状态
     * 解决问题: 状态机控制 Agent 的行为流转，不同状态下执行不同逻辑。
     *          初始状态为 IDLE（空闲）。
     */
    private state: AgentState = AgentState.IDLE;

    /**
     * 标记: messages — 对话上下文（消息历史）
     * 解决问题: 累积整个对话的所有消息（system、user、assistant、tool_result），
     *          每次 LLM 调用时作为完整上下文传给 Provider。
     */
    private messages: Message[] = [];

    /**
     * 标记: toolRounds — 当前会话的工具调用轮次计数
     * 解决问题: 限制工具调用的最大轮次，防止 Agent 陷入无限调用循环。
     *          每轮可以包含多个工具调用，但只计一次。
     */
    private toolRounds: number = 0;

    /**
     * 标记: tokenUsage — Token 使用量统计
     * 解决问题: 记录本次会话中消耗的输入和输出 Token 总数，
     *          用于成本估算和上下文窗口管理。
     */
    private tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    /**
     * 标记: consecutiveErrors — 连续工具错误计数器
     * 解决问题: 跟踪连续错误的次数，当连续 3 次工具调用失败时保护性停止，
     *          防止 Agent 在错误状态下继续调用工具产生更多异常。
     */
    private consecutiveErrors: number = 0;

    /**
     * 标记: planMode — 是否处于计划模式
     * 解决问题: 在计划模式下限制工具列表为只读工具，Agent 只能探索代码和设计
     */
    private planMode: boolean = false;

    /**
     * 标记: originalTools — 进入计划模式前的完整工具列表
     * 解决问题: 退出计划模式时需要恢复完整的工具列表
     */
    private originalTools: Tool[] = [];

    /**
     * 标记: llmRecoveryCount — LLM 层恢复连续计数
     * 解决问题: LLM 层的 RETRY/SWITCH_PROVIDER/COMPACT_CONTEXT 不计入 consecutiveErrors，
     *          需要独立计数防止恢复死循环（如反复 COMPACT_CONTEXT 但始终溢出）。
     */
    private llmRecoveryCount: number = 0;

    /**
     * 标记: planEnforcementMode — 规划强制执行模式
     * 解决问题: "off" 不执行、"soft" 软提醒、"hard" 硬拒绝修改
     */
    private planEnforcementMode: "off" | "soft" | "hard" = "soft";

    // ─── 规划闸门：enforcePlanningGate ───

    /** 修改类工具名集合 */
    private static readonly MODIFY_TOOLS = new Set(["Write", "Edit", "Bash"]);

    /**
     * 标记: enforcePlanningGate — 在修改工具执行前检查是否已有计划
     * 解决问题: 无计划时首次修改软提醒，二次修改硬拒绝；有计划时检测漂移
     */
    private enforcePlanningGate(
        toolName: string,
    ): { blocked: boolean; message?: string } {
        if (this.planEnforcementMode === "off") return { blocked: false };
        if (!AgentLoop.MODIFY_TOOLS.has(toolName)) return { blocked: false };

        if (TodoWriteTool.hasActivePlan()) {
            const alignment = TodoWriteTool.checkPlanAlignment(toolName);
            if (!alignment.aligned) {
                const drifts = TodoWriteTool.trackDrift();
                if (drifts >= 3 && this.planEnforcementMode === "hard") {
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

    /**
     * 标记: run — Agent 主循环入口，返回异步事件流
     * 解决问题: 接收用户输入，通过 ReAct 循环完成推理和工具调用，
     *          以 TurnEvent 异步生成器的形式逐步输出事件，
     *          上层 UI 通过消费此事件流实现实时更新。
     *
     * @param userInput - 用户输入的自然语言文本
     * @param config - Agent 配置（系统提示词、模型选择、工具列表、最大轮次等）
     * @param loopCtx - 运行时依赖上下文（权限、沙箱、信号等）
     * @returns 异步生成器，yield TurnEvent 事件（text / thinking / tool_call / tool_result / error / done）
     */
    async *run(
        userInput: string,
        config: AgentConfig,
        loopCtx: AgentLoopContext,
    ): AsyncGenerator<TurnEvent> {
        // ─── 初始化: 每次 run() 调用都重置内部状态 ───
        this.state = AgentState.IDLE;
        this.toolRounds = 0;
        this.consecutiveErrors = 0;
        this.llmRecoveryCount = 0;
        this.planMode = false;
        this.originalTools = [];
        this.tokenUsage = { inputTokens: 0, outputTokens: 0 };

        this.planEnforcementMode = config.planningEnforcement ?? "soft";
        TodoWriteTool.resetSession();

        this.messages = this.buildInitialMessages(userInput, config);

        const traceId = loopCtx.observability?.startTurn(userInput) ?? "";
        const signal = loopCtx.signal ?? new AbortController().signal;

        // ─── ReAct 主循环 ───
        while (this.toolRounds < config.maxToolRounds) {
            // 用户中断检测
            if (signal.aborted) {
                this.state = AgentState.DONE;
                loopCtx.observability?.endTurn(traceId, this.tokenUsage, this.toolRounds);
                yield { type: "done", usage: this.tokenUsage };
                return;
            }

            // ─── Phase 1: Thinking（LLM 推理） ───
            const thinkResult = yield* this.executeThinkingPhase(config, loopCtx, signal);
            if (thinkResult.exit) return;

            // 无工具调用 → 自然结束
            if (thinkResult.toolUses.length === 0) {
                const alert = loopCtx.contextMonitor?.getAlert();
                if (alert) {
                    const status = loopCtx.contextMonitor!.getStatus();
                    yield { type: "context_alert", health: status.health, message: alert, usagePercent: status.usagePercent };
                }
                this.state = AgentState.DONE;
                loopCtx.observability?.endTurn(traceId, this.tokenUsage, this.toolRounds);
                yield { type: "done", usage: this.tokenUsage };
                return;
            }

            // 追加 assistant 消息到对话历史
            this.messages.push({
                role: "assistant",
                content: thinkResult.toolUses.map((tu) => ({
                    type: "tool_use" as const,
                    id: tu.id,
                    name: tu.name,
                    input: tu.input,
                })),
            });

            // ─── Phase 2: Execute（工具执行） ───
            const execResult = yield* this.executeToolPhase(
                thinkResult.toolUses, config, loopCtx, signal,
            );

            // ─── Phase 3: Finalize（收尾检查 + 结果追加） ───
            // 即使 execResult.abort 为 true，也必须调用 finalizeRound
            // 将 tool_results 追加到 this.messages，否则残留的 tool_calls
            // 无对应 tool_results 会导致下一次 LLM API 调用被拒绝 (400).
            const shouldContinue = yield* this.finalizeRound(
                execResult.toolResults, thinkResult.toolUses, config, loopCtx,
            );
            if (!shouldContinue || execResult.abort) return;
        }

        // ─── 达到最大轮次限制 ───
        yield {
            type: "error",
            error: new Error(`达到最大工具调用轮次 (${config.maxToolRounds})，对话已终止`),
        };
        this.state = AgentState.DONE;
        loopCtx.observability?.endTurn(traceId, this.tokenUsage, this.toolRounds);
        yield { type: "done", usage: this.tokenUsage };
    }

    // ─── Phase 1: Thinking ───

    /**
     * 标记: executeThinkingPhase — 执行 LLM 推理阶段
     * 解决问题: 将 LLM 调用、流式响应处理、错误恢复封装为独立的子生成器，
     *          避免主循环体膨胀。
     *
     * 阶段内行为:
     *   1. 主动检查上下文使用率，超过阈值预压缩
     *   2. 计划模式下过滤工具为只读子集
     *   3. 调用 LLM Provider 的流式 chat 接口
     *   4. 流式 error chunk 交给 ErrorRecoveryManager 处理
     *   5. LLM 异常交给 ErrorRecoveryManager 处理
     *   6. LLM 恢复次数超过上限时终止
     */
    private async *executeThinkingPhase(
        config: AgentConfig,
        loopCtx: AgentLoopContext,
        signal: AbortSignal,
    ): AsyncGenerator<TurnEvent, ThinkingResult> {
        // ─── 主动上下文检查: 超过告警阈值时预压缩，不等 API 报错 ───
        this.proactiveContextCheck(config, loopCtx);

        this.state = AgentState.THINKING;

        let toolUses: ToolUse[] = [];
        let hasError = false;
        let errorCategory: ErrorCategory | undefined;
        let llmSpanId = "";

        try {
            llmSpanId = loopCtx.observability?.recordLLMCall(
                config.model,
                this.messages.length,
                this.tokenUsage.inputTokens,
            ) ?? "";

            const activeTools = this.planMode && this.originalTools.length > 0
                ? filterToolsForPlanMode(this.originalTools)
                : config.tools;

            const chunks = config.provider.chat(this.messages, {
                model: config.model,
                maxTokens: config.maxTokensPerTurn,
                tools: activeTools.map((t) => this.toolToLLMFormat(t)),
                thinking: config.thinkingEnabled,
                thinkingTokens: config.thinkingTokens,
                signal,
            });

            for await (const chunk of chunks) {
                switch (chunk.type) {
                    case "text":
                        yield { type: "text", content: chunk.content };
                        break;
                    case "thinking":
                        yield { type: "thinking", content: chunk.content };
                        break;
                    case "tool_use":
                        toolUses.push({
                            id: chunk.id,
                            name: chunk.name,
                            input: chunk.input as Record<string, unknown>,
                        });
                        break;
                    case "stop":
                        if (chunk.usage) {
                            this.tokenUsage.inputTokens = chunk.usage.inputTokens;
                            this.tokenUsage.outputTokens = chunk.usage.outputTokens;
                            this.tokenUsage.cacheCreationInputTokens = chunk.usage.cacheCreationInputTokens;
                            this.tokenUsage.cacheReadInputTokens = chunk.usage.cacheReadInputTokens;
                            loopCtx.cacheManager?.updateFromUsage(this.tokenUsage);
                        }
                        loopCtx.contextMonitor?.update(this.tokenUsage);
                        // LLM 调用成功，重置 LLM 恢复计数
                        this.llmRecoveryCount = 0;
                        break;
                    case "error":
                        errorCategory = this.classifyChunkError(chunk.code);
                        yield {
                            type: "error",
                            error: new Error(`LLM 调用错误 [${chunk.code}]: ${chunk.message}`),
                            category: errorCategory,
                        };
                        hasError = true;
                        break;
                }
            }
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            loopCtx.observability?.recordError(err, ErrorCategory.NETWORK);

            const recoveryResult = yield* this.handleLLMRecovery(
                err, config, loopCtx, "LLM 调用异常",
            );
            if (recoveryResult === "abort") return { exit: true, toolUses: [] };
            // 恢复成功：config 可能已被更新（Provider 切换），回到 ThinkingResult 让主循环重试
            return { exit: false, toolUses: [] };
        }

        // ─── 流式 error chunk 恢复 ───
        if (hasError) {
            const recoveryResult = yield* this.handleLLMRecovery(
                new Error(`LLM 调用错误: ${errorCategory}`),
                config, loopCtx, "LLM error chunk",
            );
            if (recoveryResult === "abort") {
                loopCtx.observability?.recordLLMResult(llmSpanId, this.tokenUsage, toolUses.length, true, errorCategory);
                return { exit: true, toolUses: [] };
            }
            return { exit: false, toolUses: [] };
        }

        loopCtx.observability?.recordLLMResult(llmSpanId, this.tokenUsage, toolUses.length, false);
        return { exit: false, toolUses };
    }

    // ─── Phase 2: Execute ───

    /**
     * 标记: executeToolPhase — 执行工具调用阶段
     * 解决问题: 逐个执行 LLM 返回的工具调用，包括查找、权限、熔断检查、执行、错误处理。
     *
     * @returns ExecuteResult — abort 表示熔断触发需终止循环，toolResults 为收集的结果
     */
    private async *executeToolPhase(
        toolUses: ToolUse[],
        config: AgentConfig,
        loopCtx: AgentLoopContext,
        signal: AbortSignal,
    ): AsyncGenerator<TurnEvent, ExecuteResult> {
        const toolResults: ToolResult[] = [];

        for (const toolUse of toolUses) {
            yield { type: "tool_call", tool: toolUse };

            const toolSpanId = loopCtx.observability?.recordToolCall(
                toolUse.name,
                Object.keys(toolUse.input),
            ) ?? "";

            // ─── 查找工具 ───
            const tool = this.findTool(toolUse.name, config.tools);
            if (!tool) {
                const recovery = loopCtx.errorRecoveryManager
                    ? loopCtx.errorRecoveryManager.handleToolNotFound(toolUse.name)
                    : null;

                toolResults.push({
                    tool_use_id: toolUse.id,
                    content: recovery?.error ?? `未知工具: ${toolUse.name}`,
                    is_error: true,
                });
                this.consecutiveErrors++;
                continue;
            }

            // ─── 熔断器检查 ───
            if (loopCtx.errorRecoveryManager && !loopCtx.errorRecoveryManager.checkCircuitBreaker(toolUse.name)) {
                const remainingMs = loopCtx.errorRecoveryManager.circuitBreaker.getRemainingOpenMs(toolUse.name);
                toolResults.push({
                    tool_use_id: toolUse.id,
                    content: `工具 "${toolUse.name}" 已触发熔断保护，${Math.ceil(remainingMs / 1000)}s 后可重试`,
                    is_error: true,
                });
                this.consecutiveErrors++;
                continue;
            }

            // ─── 权限检查 ───
            if (tool.requiresApproval(toolUse.input)) {
                if (loopCtx.permissionManager.willPromptUser(toolUse)) {
                    this.state = AgentState.WAITING_APPROVAL;
                    yield { type: "approval_request", tool: toolUse };
                }

                const approved = await loopCtx.permissionManager.check(toolUse);
                if (!approved) {
                    const recovery = loopCtx.errorRecoveryManager
                        ? loopCtx.errorRecoveryManager.handlePermDenied(toolUse.name)
                        : null;

                    toolResults.push({
                        tool_use_id: toolUse.id,
                        content: recovery?.error ?? "用户拒绝了此操作",
                        is_error: true,
                    });
                    this.consecutiveErrors++;
                    continue;
                }
            }

            // ─── 规划闸门检查 ───
            const gateResult = this.enforcePlanningGate(toolUse.name);
            if (gateResult.blocked) {
                toolResults.push({
                    tool_use_id: toolUse.id,
                    content: gateResult.message!,
                    is_error: true,
                });
                this.consecutiveErrors++;
                continue;
            }

            // ─── 执行工具 ───
            const toolCtx: ToolContext = {
                workingDirectory: loopCtx.workingDirectory,
                sessionId: loopCtx.sessionId,
                appendMessage: loopCtx.appendMessage,
                sandbox: loopCtx.sandbox,
                logger: loopCtx.logger,
                signal,
            };

            this.state = AgentState.EXECUTING;
            try {
                const result = await tool.execute(toolUse.input, toolCtx);
                // 软提醒：注入提示到结果
                const finalResult = gateResult.message
                    ? { ...result, content: `[规划提醒] ${gateResult.message}\n${result.content}` }
                    : result;
                toolResults.push({ ...finalResult, tool_use_id: toolUse.id });
                this.consecutiveErrors = 0;
                if (loopCtx.errorRecoveryManager) {
                    loopCtx.errorRecoveryManager.recordToolSuccess(toolUse.name);
                }
                yield { type: "tool_result", result };
                loopCtx.observability?.recordToolResult(
                    toolSpanId, toolUse.name, false,
                    typeof result.content === "string" ? result.content : JSON.stringify(result.content),
                );
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                let errorMessage = `工具执行失败: ${err.message}`;

                if (loopCtx.errorRecoveryManager) {
                    const recovery = loopCtx.errorRecoveryManager.handleToolError(err, toolUse.name);

                    if (recovery.strategy === RecoveryStrategy.CIRCUIT_BREAK) {
                        yield {
                            type: "error",
                            error: new Error(recovery.error ?? "工具熔断保护触发"),
                            category: ErrorCategory.CIRCUIT_BREAKER,
                        };
                        this.state = AgentState.ERROR;
                        return { abort: true, toolResults };
                    }
                    errorMessage = recovery.error ?? errorMessage;
                }

                const errorResult: ToolResult = {
                    tool_use_id: toolUse.id,
                    content: errorMessage,
                    is_error: true,
                };
                toolResults.push(errorResult);
                this.consecutiveErrors++;
                yield { type: "tool_result", result: errorResult };
                loopCtx.observability?.recordToolResult(
                    toolSpanId, toolUse.name, true, errorMessage,
                );
            }
        }

        return { abort: false, toolResults };
    }

    // ─── Phase 3: Finalize ───

    /**
     * 标记: finalizeRound — 收尾当前轮次
     * 解决问题: 工具执行完毕后执行 Plan Mode 检测、连续错误检查、结果截断和上下文追加。
     *
     * @returns true 表示应继续循环，false 表示应终止
     */
    private async *finalizeRound(
        toolResults: ToolResult[],
        toolUses: ToolUse[],
        _config: AgentConfig,
        loopCtx: AgentLoopContext,
    ): AsyncGenerator<TurnEvent, boolean> {
        // ─── Plan Mode 状态切换检测 ───
        yield* this.handlePlanModeTransitions(toolUses);

        // ─── 连续错误保护: 工具层 + LLM 恢复层双重保护 ───
        if (this.consecutiveErrors >= 3) {
            yield {
                type: "error",
                error: new Error("连续 3 次工具调用失败，已保护性停止。请检查问题后重试。"),
            };
            this.state = AgentState.ERROR;
            return false;
        }

        // ─── 截断过大的工具结果 ───
        const truncatedResults = this.truncateToolResults(toolResults, loopCtx);

        // ─── 追加工具结果到对话上下文 ───
        this.messages.push({
            role: "user",
            content: truncatedResults.map((tr) => ({
                type: "tool_result" as const,
                tool_use_id: tr.tool_use_id,
                content: tr.content,
                is_error: tr.is_error,
            })),
        });

        this.toolRounds++;
        return true;
    }

    // ─── 辅助: LLM 恢复处理（含恢复死循环保护） ───

    /**
     * 标记: handleLLMRecovery — 统一处理 LLM 层错误恢复
     * 解决问题: LLM 调用异常和流式 error chunk 共用此恢复流程。
     *          新增 llmRecoveryCount 防止恢复死循环（如反复 COMPACT_CONTEXT 但始终溢出）。
     *
     * @returns "continue" 表示已恢复可继续，"abort" 表示应终止
     */
    private async *handleLLMRecovery(
        error: Error,
        config: AgentConfig,
        loopCtx: AgentLoopContext,
        source: string,
    ): AsyncGenerator<TurnEvent, "continue" | "abort"> {
        if (!loopCtx.errorRecoveryManager) {
            yield { type: "error", error: new Error(`${source}: ${error.message}`) };
            this.state = AgentState.ERROR;
            return "abort";
        }

        // ─── 恢复死循环保护: 连续恢复超过上限 → 终止 ───
        this.llmRecoveryCount++;
        if (this.llmRecoveryCount > MAX_LLM_RECOVERY) {
            loopCtx.logger?.error(
                `[AgentLoop] LLM 恢复连续失败 ${this.llmRecoveryCount} 次 (超过上限 ${MAX_LLM_RECOVERY})，终止循环`,
            );
            yield {
                type: "error",
                error: new Error(
                    `LLM 恢复连续失败 ${this.llmRecoveryCount} 次，已保护性停止。` +
                    `最后一次恢复策略: ${source}。请检查网络、API 配置或手动压缩上下文后重试。`,
                ),
            };
            this.state = AgentState.ERROR;
            return "abort";
        }

        const recovery = loopCtx.errorRecoveryManager.handleLLMError(error, config.model);

        if (recovery.action === "retry" && recovery.success) {
            loopCtx.observability?.recordRecovery(recovery.strategy, true);
            this.state = AgentState.RECOVERING;
            yield {
                type: "recovering",
                strategy: recovery.strategy,
                message: recovery.error ?? `正在${recovery.strategy === "switch_provider" ? "切换 Provider" : "重试"}...`,
            };
            if (recovery.provider && recovery.provider !== config.provider) {
                // 注意: config 是引用传入，主循环持有的 config 引用也会被更新
                (config as { provider: typeof config.provider }).provider = recovery.provider;
            }
            if (recovery.strategy === RecoveryStrategy.COMPACT_CONTEXT) {
                this.compactMessages(loopCtx.summarizer);
            }
            return "continue";
        }

        // 不可恢复
        yield { type: "error", error: new Error(`${source}: ${error.message}`) };
        this.state = AgentState.ERROR;
        return "abort";
    }

    // ─── 辅助: 主动上下文检查 ───

    /**
     * 标记: proactiveContextCheck — 主动上下文使用率检查
     * 解决问题: 不等 LLM 返回 CONTEXT_OVERFLOW 错误再压缩，
     *          而是在每次 LLM 调用前检查 ContextMonitor，超过告警阈值时主动压缩。
     *          这样可以把压缩的 token 成本从"错误恢复"变成"正常流程"。
     */
    private proactiveContextCheck(_config: AgentConfig, loopCtx: AgentLoopContext): void {
        const monitor = loopCtx.contextMonitor;
        if (!monitor) return;

        const status = monitor.getStatus();
        // 超过 85% (critical) 时主动压缩，为本次 LLM 响应留出空间
        if (status.usagePercent >= 85) {
            loopCtx.logger?.warn(
                `[AgentLoop] 上下文使用率 ${status.usagePercent.toFixed(1)}%，触发主动压缩`,
            );
            this.compactMessages(loopCtx.summarizer);
        }
    }

    // ─── 辅助: Plan Mode 检测 ───

    /**
     * 标记: handlePlanModeTransitions — 检测并处理 Plan Mode 状态切换
     * 解决问题: 将 EnterPlanMode/ExitPlanMode 的检测逻辑从主循环中抽离。
     */
    private async *handlePlanModeTransitions(
        toolUses: ToolUse[],
    ): AsyncGenerator<TurnEvent, void> {
        for (const toolUse of toolUses) {
            if (toolUse.name === "EnterPlanMode") {
                if (!this.planMode) {
                    this.originalTools = []; // 将在下次 executeThinkingPhase 中通过 filterToolsForPlanMode 处理
                    this.planMode = true;
                    this.state = AgentState.PLANNING;
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

    // ─── 辅助: 工具结果截断 ───

    /**
     * 标记: truncateToolResults — 截断过大的工具结果
     * 解决问题: 防止单个工具输出（如 cat 大文件）撑爆上下文窗口。
     *          基于字符数粗略估算 token 数，超过上限时截断并追加截断提示。
     */
    private truncateToolResults(
        results: ToolResult[],
        loopCtx: AgentLoopContext,
    ): ToolResult[] {
        return results.map((r) => {
            if (r.is_error) return r;

            const contentStr = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
            const estimatedTokens = Math.ceil(contentStr.length / CHARS_PER_TOKEN_ESTIMATE);

            if (estimatedTokens <= MAX_TOOL_RESULT_TOKENS) return r;

            // 截断: 保留前 MAX_TOOL_RESULT_TOKENS * CHARS_PER_TOKEN_ESTIMATE 个字符
            const maxChars = MAX_TOOL_RESULT_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
            const truncated = contentStr.slice(0, maxChars);
            const omittedChars = contentStr.length - maxChars;

            loopCtx.logger?.warn(
                `[AgentLoop] 工具结果过长 (est. ${estimatedTokens} tokens)，已截断，省略约 ${omittedChars} 字符`,
            );

            return {
                ...r,
                content: `${truncated}\n\n[... 结果过长已截断，省略约 ${omittedChars} 字符，原始估 ${estimatedTokens} tokens ...]`,
            };
        });
    }

    // ─── 公开 API ───

    /**
     * 标记: getState — 获取 Agent 当前状态
     * @returns 当前 AgentState 枚举值
     */
    getState(): AgentState { return this.state; }

    /**
     * 标记: getMessages — 获取当前累积的对话消息列表
     * @returns 当前所有消息的副本（不变更内部状态）
     */
    getMessages(): Message[] { return this.messages; }

    /**
     * 标记: loadHistory — 加载历史对话消息
     * @param messages - 要加载的历史消息列表
     */
    loadHistory(messages: Message[]): void {
        this.messages = [...messages];
    }

    // ─── 私有: 上下文构建 ───

    /**
     * 标记: buildInitialMessages — 构建初始消息上下文
     * 解决问题: 将 system prompt、已有对话历史和当前用户输入组合成第一条 LLM 请求的 messages。
     *
     * @param userInput - 用户输入的自然语言文本
     * @param config - Agent 配置（从中提取 systemPrompt）
     * @returns 组装好的初始消息列表
     */
    private buildInitialMessages(userInput: string, config: AgentConfig): Message[] {
        const messages: Message[] = [];
        if (config.systemPrompt) messages.push({ role: "system", content: config.systemPrompt });
        for (const msg of this.messages) messages.push(msg);
        messages.push({ role: "user", content: userInput });
        return messages;
    }

    /**
     * 标记: findTool — 在已注册工具列表中按名称查找工具
     *
     * @param name - 工具名称
     * @param tools - 已注册的 Tool 实例数组
     * @returns 匹配的 Tool 实例或 undefined
     */
    private findTool(name: string, tools: Tool[]): Tool | undefined {
        return tools.find((t) => t.name === name);
    }

    /**
     * 标记: toolToLLMFormat — 将 Tool 实例转换为 LLM 的函数定义格式（LLMToolDefinition）
     *
     * @param tool - 内部 Tool 实例
     * @returns LLM 兼容的工具定义对象
     */
    private toolToLLMFormat(tool: Tool) {
        return {
            name: tool.name,
            description: tool.description,
            input_schema: {
                type: "object" as const,
                properties: tool.parameters.properties as Record<string, unknown>,
                required: tool.parameters.required,
            },
        };
    }

    /**
     * 标记: classifyChunkError — 将 LLM 流式 error chunk 的 code 映射为 ErrorCategory
     *
     * @param code - LLM Provider 返回的错误码字符串
     * @returns ErrorCategory 枚举值
     */
    private classifyChunkError(code: string): ErrorCategory {
        switch (code) {
            case "rate_limit_error":
            case "rate_limit":
                return ErrorCategory.RATE_LIMIT;
            case "authentication_error":
            case "invalid_auth":
                return ErrorCategory.AUTH;
            case "invalid_request_error":
                return ErrorCategory.INVALID_REQUEST;
            case "context_length_exceeded":
            case "token_limit_exceeded":
                return ErrorCategory.CONTEXT_OVERFLOW;
            case "server_error":
            case "api_error":
            case "overloaded":
                return ErrorCategory.PROVIDER_ERROR;
            case "network_error":
            case "timeout":
            case "connection_error":
                return ErrorCategory.NETWORK;
            default:
                return ErrorCategory.PROVIDER_ERROR;
        }
    }

    /**
     * 标记: compactMessages — 压缩消息历史以回收 Token
     * 解决问题: 当上下文使用率过高或 LLM 返回 CONTEXT_OVERFLOW 时，削去最早的消息历史。
     *         优先使用 Summarizer 的累积摘要（语义保留），
     *         未配置 Summarizer 时使用简单截断（保留 system + 最近 50%）。
     */
    private compactMessages(summarizer?: Summarizer): void {
        const systemMessages = this.messages.filter((m) => m.role === "system");
        const nonSystemMessages = this.messages.filter((m) => m.role !== "system");

        if (nonSystemMessages.length <= 2) {
            return;
        }

        const keepCount = Math.max(2, Math.floor(nonSystemMessages.length / 2));
        const kept = nonSystemMessages.slice(-keepCount);

        let summaryContent: string;
        const accumulatedSummary = summarizer?.getAccumulatedSummary();
        if (accumulatedSummary) {
            summaryContent = `[上下文压缩]: 省略了 ${nonSystemMessages.length - keepCount} 条历史消息。\n以下是之前对话的摘要:\n${accumulatedSummary}`;
        } else {
            summaryContent = `[上下文压缩]: 省略了 ${nonSystemMessages.length - keepCount} 条历史消息`;
        }

        const summaryMessage: Message = {
            role: "user",
            content: summaryContent,
        };

        this.messages = [...systemMessages, summaryMessage, ...kept];
    }
}
