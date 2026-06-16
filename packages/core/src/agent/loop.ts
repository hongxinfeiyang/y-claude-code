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
import type { ISandbox, Logger } from "../types/tools";
import type { PermissionManager } from "../permission/manager";
import { ErrorRecoveryManager } from "./error-recovery/manager";
import { RecoveryStrategy, ErrorCategory } from "./error-recovery/types";
import { Summarizer } from "../context/summarizer";
import { ObservabilityManager } from "../observability/manager";
import { TodoWriteTool } from "../tools/builtin/todo";
import { PlanState } from "./plan-state";
import { CacheManager } from "../context/cache-manager";
import { ContextMonitor } from "../context/monitor";
import { PlanModeManager } from "./plan-mode-manager";
import { MiddlewarePipeline } from "./middleware";
import { ContextCompactor } from "./context-compactor";
import { LLMCallManager } from "./llm-call-manager";
import { ToolExecutor, ToolExecutorState } from "./tool-executor";

// ─── 默认常量 ───

/** LLM 恢复连续失败上限: 防止重试/切换Provider/压缩上下文的死循环 */
const MAX_LLM_RECOVERY = 3;

/** 工具单次结果最大 token 估算: 超过此值截断，防止撑爆上下文 */
const MAX_TOOL_RESULT_TOKENS = 8000;

/** token 估算系数: 英文约 4 字符/token，CJK 约 1.5 字符/token */
const ASCII_CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 1.5;

/**
 * 标记: AgentServices — Agent 可选服务聚合
 * 解决问题: 将 8 个可选依赖从 AgentLoopContext 平铺结构中收敛为服务组，
 *          减少空值检查，使核心依赖和服务依赖分离清晰。
 */
export interface AgentServices {
    errorRecoveryManager?: ErrorRecoveryManager;
    observability?: ObservabilityManager;
    summarizer?: Summarizer;
    cacheManager?: CacheManager;
    contextMonitor?: ContextMonitor;
    sandbox?: ISandbox;
}

/**
 * 标记: AgentLoopContext — Agent 主循环的运行时依赖接口
 * 解决问题: Agent Loop 需要多个外部依赖（权限管理、沙箱、日志器等），
 *          将这些依赖集中定义为一个接口，方便注入和测试替换。
 *          核心必需依赖直接挂在 context 上，可选服务收敛到 services 子对象。
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

    /**
     * 标记: services — 可选服务聚合
     * 解决问题: 将可选依赖收敛为子对象，新代码优先使用 services.xxx 而非顶层可选字段。
     *          顶层可选字段保留向后兼容。
     */
    services?: AgentServices;
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
     * 标记: setState — 显式状态转换（带日志追踪）
     * 解决问题: 确保所有状态转换都经过单一入口，便于调试和审计。
     *          消除之前通过 return 隐式退出循环而不设置 state 的问题。
     */
    private setState(newState: AgentState, reason: string): void {
        if (this.state !== newState) {
            this.state = newState;
        }
    }

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

    /**
     * 标记: planState — 规划闸门状态
     * 解决问题: 规划状态由 AgentLoop 创建和拥有，解耦 TodoWriteTool 的静态耦合。
     *          通过 TodoWriteTool.setPlanState 注入，执行和闸门共享同一状态实例。
     */
    private planState: PlanState = new PlanState();

    /**
     * 标记: planModeManager — Plan Mode 状态管理器
     * 解决问题: 将 Plan Mode 的工具过滤、闸门检查、状态切换从 AgentLoop 中抽离。
     */
    private planModeManager: PlanModeManager = new PlanModeManager();

    /**
     * 标记: middleware — 中间件管道
     * 解决问题: 提供可插拔的拦截器机制，支持审计、限流、脱敏等横切关注点。
     */
    readonly middleware: MiddlewarePipeline = new MiddlewarePipeline();

    /**
     * 标记: compactor — 上下文压缩器
     * 解决问题: 将消息压缩逻辑从 AgentLoop 中抽离为独立模块。
     */
    private compactor: ContextCompactor = new ContextCompactor();

    /**
     * 标记: llmCallManager — LLM 调用管理器
     * 解决问题: 将流式调用、chunk 分发、token 追踪从 executeThinkingPhase 中抽离。
     */
    private llmCallManager: LLMCallManager = new LLMCallManager();

    /**
     * 标记: toolExecutor — 工具执行器
     * 解决问题: 将工具查找、熔断、权限、闸门、执行、错误处理管道从 executeToolPhase 中抽离。
     */
    private toolExecutor: ToolExecutor = new ToolExecutor();

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
        this.setState(AgentState.IDLE, "run() 初始化");
        this.toolRounds = 0;
        this.consecutiveErrors = 0;
        this.llmRecoveryCount = 0;
        this.tokenUsage = { inputTokens: 0, outputTokens: 0 };

        this.planEnforcementMode = config.planningEnforcement ?? "soft";
        this.planState.reset();
        TodoWriteTool.setPlanState(this.planState);
        this.planModeManager.reset(this.planEnforcementMode);

        this.messages = this.buildInitialMessages(userInput, config);

        const traceId = this.svc<ObservabilityManager>(loopCtx, "observability")?.startTurn(userInput) ?? "";
        const signal = loopCtx.signal ?? new AbortController().signal;

        // ─── ReAct 主循环 ───
        while (this.toolRounds < config.maxToolRounds) {
            // 用户中断检测
            if (signal.aborted) {
                this.setState(AgentState.DONE, "用户中断 (signal.aborted)");
                this.svc<ObservabilityManager>(loopCtx, "observability")?.endTurn(traceId, this.tokenUsage, this.toolRounds);
                yield { type: "done", usage: this.tokenUsage };
                return;
            }

            // ─── Phase 1: Thinking（LLM 推理） ───
            const thinkResult = yield* this.executeThinkingPhase(config, loopCtx, signal);
            if (thinkResult.exit) return;

            // 无工具调用 → 自然结束
            if (thinkResult.toolUses.length === 0) {
                const alert = this.svc<ContextMonitor>(loopCtx, "contextMonitor")?.getAlert();
                if (alert) {
                    const status = this.svc<ContextMonitor>(loopCtx, "contextMonitor")!.getStatus();
                    yield { type: "context_alert", health: status.health, message: alert, usagePercent: status.usagePercent };
                }
                this.setState(AgentState.DONE, "无工具调用，自然结束");
                this.svc<ObservabilityManager>(loopCtx, "observability")?.endTurn(traceId, this.tokenUsage, this.toolRounds);
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
        this.setState(AgentState.DONE, "达到最大工具调用轮次");
        this.svc<ObservabilityManager>(loopCtx, "observability")?.endTurn(traceId, this.tokenUsage, this.toolRounds);
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
        this.proactiveContextCheck(config, loopCtx);
        this.setState(AgentState.THINKING, "LLM 推理开始");

        const obs = this.svc<ObservabilityManager>(loopCtx, "observability");
        const llmSpanId = obs?.recordLLMCall(
            config.model, this.messages.length, this.tokenUsage.inputTokens,
        ) ?? "";

        try {
            // ─── 中间件: beforeLLMCall ───
            let effectiveConfig = config;
            const modifiedConfig = await this.middleware.runBeforeLLMCall(config);
            if (modifiedConfig !== config) {
                effectiveConfig = modifiedConfig;
                // 中间件可能修改了 provider/model 等，同步回 config 引用
                (config as { provider: typeof config.provider }).provider = modifiedConfig.provider;
            }

            const activeTools = this.planModeManager.filterTools(effectiveConfig.tools);

            const result = yield* this.llmCallManager.streamCall(this.messages, {
                provider: effectiveConfig.provider,
                model: effectiveConfig.model,
                maxTokensPerTurn: effectiveConfig.maxTokensPerTurn,
                thinkingEnabled: effectiveConfig.thinkingEnabled,
                thinkingTokens: effectiveConfig.thinkingTokens,
                signal,
                activeTools,
                errorRecoveryManager: this.svc<ErrorRecoveryManager>(loopCtx, "errorRecoveryManager"),
                cacheManager: this.svc<CacheManager>(loopCtx, "cacheManager"),
                contextMonitor: this.svc<ContextMonitor>(loopCtx, "contextMonitor"),
            }, this.tokenUsage);

            // ─── 中间件: afterLLMCall — 过滤/修改 tool_use 列表 ───
            let toolUses = result.toolUses;
            const filtered = await this.middleware.runAfterLLMCall(toolUses);
            if (filtered !== toolUses) {
                toolUses = filtered;
            }

            // 流式 error chunk 恢复
            if (result.hasError) {
                const recoveryResult = yield* this.handleLLMRecovery(
                    new Error(`LLM 调用错误: ${result.errorCategory}`),
                    config, loopCtx, "LLM error chunk",
                );
                if (recoveryResult === "abort") {
                    obs?.recordLLMResult(llmSpanId, this.tokenUsage, toolUses.length, true, result.errorCategory);
                    return { exit: true, toolUses: [] };
                }
                return { exit: false, toolUses: [] };
            }

            this.llmRecoveryCount = 0;
            obs?.recordLLMResult(llmSpanId, this.tokenUsage, toolUses.length, false);
            return { exit: false, toolUses };
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            obs?.recordError(err, ErrorCategory.NETWORK);

            const recoveryResult = yield* this.handleLLMRecovery(
                err, config, loopCtx, "LLM 调用异常",
            );
            if (recoveryResult === "abort") {
                obs?.recordLLMResult(llmSpanId, this.tokenUsage, 0, true, ErrorCategory.NETWORK);
                return { exit: true, toolUses: [] };
            }
            return { exit: false, toolUses: [] };
        }
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
        const result = yield* this.toolExecutor.executeAll(toolUses, {
            tools: config.tools,
            permissionManager: loopCtx.permissionManager,
            errorRecoveryManager: this.svc<ErrorRecoveryManager>(loopCtx, "errorRecoveryManager"),
            observability: this.svc<ObservabilityManager>(loopCtx, "observability"),
            planModeManager: this.planModeManager,
            workingDirectory: loopCtx.workingDirectory,
            sessionId: loopCtx.sessionId,
            appendMessage: loopCtx.appendMessage,
            sandbox: this.svc<ISandbox>(loopCtx, "sandbox"),
            logger: loopCtx.logger,
            signal,
            middleware: this.middleware,
        },
            (s) => {
                if (s === ToolExecutorState.WAITING_APPROVAL) this.setState(AgentState.WAITING_APPROVAL, "等待用户审批");
                else if (s === ToolExecutorState.EXECUTING) this.setState(AgentState.EXECUTING, "开始执行工具");
            },
            (isError) => {
                if (isError) {
                    this.consecutiveErrors++;
                    console.log(`[AgentLoop] 工具错误 #${this.consecutiveErrors}`);
                } else {
                    if (this.consecutiveErrors > 0) console.log(`[AgentLoop] 工具成功, consecutiveErrors 重置`);
                    this.consecutiveErrors = 0;
                }
            },
        );

        if (result.abort) {
            this.setState(AgentState.ERROR, "工具熔断保护触发");
        }
        return { abort: result.abort, toolResults: result.toolResults };
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
        yield* this.planModeManager.handleTransitions(toolUses);

        // ─── 连续错误保护: 工具层 + LLM 恢复层双重保护 ───
        if (this.consecutiveErrors >= 3) {
            yield {
                type: "error",
                error: new Error("连续 3 次工具调用失败，已保护性停止。请检查问题后重试。"),
            };
            this.setState(AgentState.ERROR, "连续 3 次工具错误，保护性停止");
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
        // ─── 中间件: afterRound — 统计/告警 ───
        await this.middleware.runAfterRound(this.toolRounds, toolResults);
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
        const erManager = this.svc<ErrorRecoveryManager>(loopCtx, "errorRecoveryManager");
        if (!erManager) {
            yield { type: "error", error: new Error(`${source}: ${error.message}`) };
            this.setState(AgentState.ERROR, "无可用的错误恢复管理器");
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
            this.setState(AgentState.ERROR, "LLM 恢复连续失败超过上限");
            return "abort";
        }

        const recovery = erManager.handleLLMError(error, config.model);

        if (recovery.action === "retry" && recovery.success) {
            this.svc<ObservabilityManager>(loopCtx, "observability")?.recordRecovery(recovery.strategy, true);
            this.setState(AgentState.RECOVERING, `恢复中: ${recovery.strategy}`);
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
                this.messages = this.compactor.compact(this.messages, this.svc<Summarizer>(loopCtx, "summarizer"));
                this.llmRecoveryCount = 0;
            }
            return "continue";
        }

        // 不可恢复
        yield { type: "error", error: new Error(`${source}: ${error.message}`) };
        this.setState(AgentState.ERROR, "LLM 错误不可恢复");
        return "abort";
    }

    // ─── 辅助: 服务解析 (消除 services?.xxx ?? loopCtx.xxx 重复) ───

    /** 解析可选服务：优先 services 子对象，回退顶层字段 */
    private svc<T>(loopCtx: AgentLoopContext, key: keyof AgentServices): T | undefined {
        return (loopCtx.services?.[key] ?? loopCtx[key as keyof AgentLoopContext]) as T | undefined;
    }

    // ─── 辅助: 主动上下文检查 ───

    /**
     * 标记: proactiveContextCheck — 主动上下文使用率检查
     * 解决问题: 不等 LLM 返回 CONTEXT_OVERFLOW 错误再压缩，
     *          而是在每次 LLM 调用前检查 ContextMonitor，超过告警阈值时主动压缩。
     *          这样可以把压缩的 token 成本从"错误恢复"变成"正常流程"。
     */
    private proactiveContextCheck(config: AgentConfig, loopCtx: AgentLoopContext): void {
        const monitor = this.svc<ContextMonitor>(loopCtx, "contextMonitor");
        if (!monitor) return;

        const status = monitor.getStatus();
        const threshold = config.contextCompressThreshold ?? 85;
        if (status.usagePercent >= threshold) {
            loopCtx.logger?.warn(
                `[AgentLoop] 上下文使用率 ${status.usagePercent.toFixed(1)}%，触发主动压缩`,
            );
            this.messages = this.compactor.compact(this.messages, this.svc<Summarizer>(loopCtx, "summarizer"));
        }
    }

    // ─── 辅助: 工具结果截断 ───

    /**
     * 标记: truncateToolResults — 截断过大的工具结果
     * 解决问题: 防止单个工具输出（如 cat 大文件）撑爆上下文窗口。
     *          基于字符类型估算 token 数（ASCII ~4 字符/token，CJK ~1.5 字符/token），
     *          超过上限时在安全边界（换行符）处截断。
     */
    private truncateToolResults(
        results: ToolResult[],
        loopCtx: AgentLoopContext,
    ): ToolResult[] {
        return results.map((r) => {
            if (r.is_error) return r;

            const contentStr = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
            const estimatedTokens = this.estimateTokens(contentStr);

            if (estimatedTokens <= MAX_TOOL_RESULT_TOKENS) return r;

            const maxChars = this.findSafeTruncationPoint(contentStr);
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

    /** 估算字符串的 token 数，区分 ASCII 和 CJK 字符 */
    private estimateTokens(str: string): number {
        let asciiChars = 0;
        let cjkChars = 0;
        let otherChars = 0;

        for (const ch of str) {
            const cp = ch.codePointAt(0) ?? 0;
            if (cp <= 0x7f) {
                asciiChars++;
            } else if (
                (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一汉字
                (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
                (cp >= 0x20000 && cp <= 0x2a6df) || // CJK 扩展 B
                (cp >= 0x3040 && cp <= 0x309f) || // 平假名
                (cp >= 0x30a0 && cp <= 0x30ff) || // 片假名
                (cp >= 0xac00 && cp <= 0xd7af) // 韩文
            ) {
                cjkChars++;
            } else {
                otherChars++;
            }
        }

        return Math.ceil(
            asciiChars / ASCII_CHARS_PER_TOKEN +
            cjkChars / CJK_CHARS_PER_TOKEN +
            otherChars / ASCII_CHARS_PER_TOKEN,
        );
    }

    /** 找到安全的截断点：优先在换行符处截断 */
    private findSafeTruncationPoint(contentStr: string): number {
        // 目标截断位置（以 ASCII 估算一个初始上限，然后回退找安全点）
        const targetByteLen = MAX_TOOL_RESULT_TOKENS * ASCII_CHARS_PER_TOKEN;

        if (contentStr.length <= targetByteLen) return contentStr.length;

        // 在目标位置附近找最后一个换行符
        const searchStart = Math.max(0, targetByteLen);
        const lastNewline = contentStr.lastIndexOf("\n", searchStart);

        // 如果找到且在合理范围内（不低于目标的 60%），使用它
        if (lastNewline > targetByteLen * 0.6) {
            // 确保不截断 UTF-8 代理对中间
            if (lastNewline + 1 < contentStr.length) {
                const nextCp = contentStr.codePointAt(lastNewline + 1);
                if (nextCp !== undefined && nextCp >= 0xdc00 && nextCp <= 0xdfff) {
                    // 低代理项，回退一个字符
                    return lastNewline - 1;
                }
            }
            return lastNewline + 1; // 包含换行符
        }

        // 回退：在原目标位置找安全截断点
        let pos = targetByteLen;
        while (pos > 0 && pos < contentStr.length) {
            const cp = contentStr.codePointAt(pos);
            // 跳过 UTF-16 低代理项
            if (cp !== undefined && cp >= 0xdc00 && cp <= 0xdfff) {
                pos--;
                continue;
            }
            break;
        }

        return Math.max(1, pos);
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
}
