// ─── packages/core/src/types/agent.ts ───
// Agent 类型定义 — Agent 运行配置、状态、回合事件、LLM Provider 接口
// 解决问题: 定义 Agent Loop 的完整类型体系，从启动参数到运行状态到流式产出的全链路数据类型，
//          同时通过 LLMProvider 接口屏蔽不同 LLM 厂商（Anthropic/OpenAI/DeepSeek）的差异

import type {
    Message, TokenUsage, ToolUse, ToolResult,
    LLMToolDefinition, ResponseChunk
} from "./messages";
import type { Tool } from "./tools";

// ─── Agent 运行状态 ───

/**
 * Agent 运行状态枚举 — Agent Loop 在其生命周期中经历的状态
 *
 * 解决问题:
 *   1. UI 层需要知道 Agent 当前在做什么，以便展示对应的加载动画和状态提示
 *   2. 事件处理逻辑需要根据当前状态决定可以接收什么事件、拒绝什么操作
 *      （如 EXECUTING 状态下不能发起新的 LLM 调用）
 *
 * 标记: "Agent 生命周期状态机" — 状态按 IDLE → THINKING → EXECUTING → ... → DONE 流转
 */
export enum AgentState {
    /**
     * 空闲状态 — Agent 等待用户输入
     *
     * 标记: "生命周期的起点和终点" — 用户提交消息后从 IDLE 进入 THINKING，
     *       一轮对话结束后回到 IDLE
     */
    IDLE = "idle",

    /**
     * LLM 推理中 — Agent 已将消息发送给 LLM，等待响应
     *
     * 标记: "AI 思考阶段" — 此状态下用户看到的可能是"正在思考..."动画
     */
    THINKING = "thinking",

    /**
     * 工具执行中 — LLM 已决定调用工具，Agent Loop 正在执行工具逻辑
     *
     * 标记: "系统操作阶段" — 如正在运行 bash 命令、读写文件等
     */
    EXECUTING = "executing",

    /**
     * 等待用户权限确认 — 工具调用被 requiresApproval 拦截，等待用户决定
     *
     * 标记: "人机交互的决策点" — 用户可选择允许、拒绝或始终允许
     */
    WAITING_APPROVAL = "waiting_approval",

    /**
     * 本轮对话结束 — LLM 返回 stop_reason: end_turn，所有工具结果已处理完毕
     *
     * 标记: "一轮对话的终点" — Agent 将控制权交还给用户
     */
    DONE = "done",

    /**
     * 发生错误 — LLM 调用失败、工具执行异常等
     *
     * 标记: "异常终止状态" — Agent 停止当前轮次，等待用户处理错误
     */
    ERROR = "error",

    /**
     * 错误恢复中 — Agent 正在执行错误恢复策略（重试、切换 Provider 等）
     *
     * 标记: "错误恢复状态" — ErrorRecoveryManager 接管控制权，执行恢复操作
     */
    RECOVERING = "recovering",

    /**
     * 计划模式中 — Agent 已进入计划模式，只能使用只读工具进行探索和设计
     *
     * 标记: "架构设计阶段" — Agent 可以 Read/Glob/Grep/WebFetch/WebSearch，但不能 Edit/Write/Bash
     */
    PLANNING = "planning",
}

// ─── Agent 运行配置 ───

/**
 * Agent 运行配置 — 启动 Agent Loop 时的参数集合
 *
 * 解决问题:
 *   1. 将 Agent 行为的所有可调参数集中在一个对象中，避免构造函数参数爆炸
 *   2. 支持不同场景下使用不同配置（如开发模式 vs 生产模式 的 maxToolRounds 不同）
 *   3. 配置对象可序列化，便于从用户配置文件和命令行参数中构建
 *
 * 标记: "Agent 的启动参数包" — 传递给 Agent Loop 的完整初始化数据
 */
export interface AgentConfig {
    /**
     * 模型标识 — 如 "claude-sonnet-4-6"、"gpt-4o"
     *
     * 解决问题: Provider 根据此标识选择具体的模型路由
     */
    model: string;

    /**
     * LLM Provider 实例 — 负责与 LLM API 通信
     *
     * 解决问题: 通过接口注入实现厂商解耦，切换模型只需替换 Provider 实例
     */
    provider: LLMProvider;

    /**
     * 最大工具调用轮次 — 防止 Agent 陷入无限循环
     *
     * 解决问题: LLM 可能反复调用工具而不给出最终回答（如不断修改文件），
     *          设置上限后 Agent Loop 到达上限会强制要求 LLM 给出总结
     */
    maxToolRounds: number;

    /** 单轮 LLM 调用最大 token 数 — 防止单次响应过于冗长 */
    maxTokensPerTurn: number;

    /**
     * 系统提示词 — 定义 AI 的角色、行为规范和约束
     *
     * 解决问题: 通过 System Prompt 注入项目规则（CLAUDE.md）、
     *          安全策略、输出格式要求等全局指令
     *
     * 标记: "AI 的行为宪章" — 在每轮对话中作为第一条 system 消息发送
     */
    systemPrompt: string;

    /**
     * 已注册的工具列表 — LLM 可见的工具集合
     *
     * 解决问题: Agent 将列表中每个 Tool 的 name/description/parameters
     *          转换为 LLMToolDefinition 发送给 LLM，LLM 据此决定是否调用工具
     */
    tools: Tool[];

    /**
     * 是否启用思考模式 — 对应 Anthropic Extended Thinking
     *
     * 解决问题: 复杂推理任务（数学、代码分析）需要 LLM 在内部进行深度思考，
     *          启用后 LLM 会产出 thinking 类型的 chunk
     */
    thinkingEnabled: boolean;

    /** 思考预算 token 数 — Extended Thinking 的最大思考 token */
    thinkingTokens?: number;

    /** 额外配置 — 透传给 Provider，支持厂商特有参数 */
    extra?: Record<string, unknown>;

    /**
     * 重试配置 — 控制 LLM 调用失败时的重试行为
     * 解决问题: 用户可根据网络环境和使用场景自定义退避参数
     */
    retryConfig?: {
        /** 最大重试次数，默认 3 */
        maxRetries?: number;
        /** 基础延迟毫秒数，默认 1000 */
        baseDelayMs?: number;
        /** 最大延迟毫秒数，默认 30000 */
        maxDelayMs?: number;
        /** 指数退避乘数，默认 2 */
        backoffMultiplier?: number;
    };

    /**
     * 熔断器配置 — 控制工具级熔断保护的触发阈值
     */
    circuitBreakerConfig?: {
        /** 熔断阈值: 窗口内失败次数达到此值触发熔断，默认 5 */
        failureThreshold?: number;
        /** 统计窗口毫秒数，默认 60000 */
        windowMs?: number;
        /** 熔断打开后的半开等待毫秒数，默认 30000 */
        halfOpenMs?: number;
    };

    /**
     * 备用 LLM Provider — 主 Provider 不可用时的回退选项
     * 解决问题: 避免单 Provider 故障导致 Agent 完全不可用
     */
    fallbackProvider?: LLMProvider;

    /**
     * 计划模式文件路径 — 当启用 Plan Mode 时，plan 内容将写入此文件
     * 解决问题: EnterPlanMode 工具需要知道将 plan 写入何处
     */
    planFile?: string;

    /**
     * 规划强制执行模式
     * - "off": 不强制执行（向后兼容）
     * - "soft": 软提醒（默认，无计划时首次修改注入提示，二次修改硬拒绝）
     * - "hard": 硬模式（无计划拒绝所有修改，计划漂移 3 次后强制重规划）
     */
    planningEnforcement?: "off" | "soft" | "hard";
}

// ─── 回合事件 ───

/**
 * 回合事件 — Agent Loop 产出的流式事件联合类型
 *
 * 解决问题:
 *   1. Agent Loop 是一个异步流式过程，UI 需要实时感知每一步的进展
 *   2. 通过 Union Type 让消费者（UI、日志、Hook 系统）可以按 type 分发处理不同事件
 *   3. 支持 tui/web/cli 等多种 UI 形态消费同一事件流
 *
 * 标记: "Agent Loop 的输出总线" — 所有外部可见的 Agent 行为都通过 TurnEvent 暴露
 */
export type TurnEvent =
    /**
     * 文本增量 — LLM 正在逐步输出文本回答
     *
     * 解决问题: 用户不想等 LLM 完整回答完毕才看到文字，流式文本提供实时反馈
     */
    | { type: "text"; content: string }

    /**
     * 工具调用 — LLM 决定调用某个工具
     *
     * 解决问题: UI 需要知道 LLM 正在使用什么工具（如展示"正在运行 Bash..."）
     */
    | { type: "tool_call"; tool: ToolUse }

    /**
     * 工具结果 — 工具执行完毕，返回结果给 LLM
     *
     * 解决问题: 通知 UI 工具执行完成（如展示命令输出、文件变更摘要）
     */
    | { type: "tool_result"; result: ToolResult }

    /**
     * 思考内容 — LLM 的内部推理过程（仅 Extended Thinking 模式）
     *
     * 解决问题: 用户可以选择查看 AI 的推理链，增强可解释性和信任度
     */
    | { type: "thinking"; content: string }

    /**
     * 权限请求 — 工具调用触发 requiresApproval，等待用户确认
     *
     * 解决问题: UI 需要弹出确认对话框，展示工具名称和参数，让用户决定放行或拒绝
     */
    | { type: "approval_request"; tool: ToolUse }

    /**
     * 错误事件 — 本轮执行中出现异常
     *
     * 解决问题: UI 需要展示错误信息，并可能需要用户介入处理。
     * category 字段为 ErrorCategory 枚举值字符串，供 ErrorRecoveryManager 消费
     */
    | { type: "error"; error: Error; category?: string }

    /**
     * 恢复事件 — ErrorRecoveryManager 正在执行恢复操作
     *
     * 解决问题: UI 展示恢复状态（如"正在重试..."、"正在切换 Provider..."）
     */
    | { type: "recovering"; strategy: string; message: string }

    /**
     * 回合结束 — 本轮对话正常完成
     *
     * 解决问题:
     *   1. 通知 UI 本轮对话已结束，可以恢复输入框
     *   2. 附带 TokenUsage 用于统计和成本展示
     */
    | { type: "done"; usage: TokenUsage }

    /**
     * 进入计划模式 — Agent 调用了 EnterPlanMode，进入架构设计阶段
     *
     * 解决问题: 通知 UI 切换到计划模式展示（限制工具、展示计划进度）
     */
    | { type: "plan_mode_entered"; message: string }

    /**
     * 退出计划模式 — Agent 调用了 ExitPlanMode，提交计划等待用户审批
     *
     * 解决问题: 通知 UI 展示计划内容，等待用户审批
     */
    | { type: "plan_mode_exited"; plan: string }

    /**
     * 上下文告警 — 上下文窗口使用率超过阈值
     *
     * 解决问题: 通知 UI 显示告警信息，提示用户执行 compact
     */
    | { type: "context_alert"; health: string; message: string; usagePercent: number };

// ─── LLM 调用选项 ───

/**
 * LLM 调用选项 — 每次 LLM API 调用的参数集合
 *
 * 解决问题:
 *   1. 将 LLM 调用的所有控制参数集中管理，便于调整和透传
 *   2. 支持取消信号 — 用户中断对话时通过 AbortSignal 取消正在进行的 API 请求
 *   3. 工具定义随调用传递 — 支持动态工具注册（不同轮次可用不同的工具集）
 *
 * 标记: "API 调用参数包" — 被 LLMProvider.chat() 方法消费
 */
export interface ChatOptions {
    /** 模型标识 */
    model: string;

    /** 最大输出 token 数 — 控制 LLM 响应长度上限 */
    maxTokens: number;

    /**
     * 温度参数 (0-1) — 控制输出的随机性
     * 0 = 确定性输出（适合代码生成）
     * 1 = 最大随机性（适合创意写作）
     */
    temperature?: number;

    /**
     * 可用工具定义列表 — 本次调用中 LLM 可以使用的工具
     *
     * 解决问题: LLM 需要知道当前有哪些工具可以调用，
     *          工具定义随每次调用传递，支持运行时动态增删工具
     */
    tools?: LLMToolDefinition[];

    /** 是否启用思考模式 — 覆盖 AgentConfig 中的全局设置 */
    thinking?: boolean;

    /** 思考预算 token 数 — 覆盖 AgentConfig 中的全局设置 */
    thinkingTokens?: number;

    /**
     * 取消信号 — 用于中断正在进行的 LLM 请求
     *
     * 解决问题: 用户按 Ctrl+C 或切换对话时，应立即取消 API 请求以节省费用
     */
    signal?: AbortSignal;
}

// ─── LLM Provider 接口 ───

/**
 * LLM Provider 抽象接口 — 多厂商适配的核心契约
 *
 * 解决问题:
 *   1. Anthropic、OpenAI、DeepSeek 等厂商的 API 格式不同，通过此接口统一调用方式
 *   2. 切换模型厂商只需替换 Provider 实现，Agent Loop 代码无需修改
 *   3. 支持能力检测（supportsFeature），让 Agent Loop 根据 Provider 能力调整行为
 *      （如不支持 thinking 的 Provider 自动禁用思考模式）
 *
 * 标记: "多 LLM 厂商的统一入口" — Agent Loop 只依赖 LLMProvider 接口，不依赖具体厂商 SDK
 */
export interface LLMProvider {
    /**
     * 流式对话 — 发送消息列表并返回异步事件流
     *
     * 解决问题:
     *   1. LLM 响应可能很慢，流式返回让 UI 可以实时展示输出
     *   2. 支持中途取消（通过 options.signal），避免浪费 token
     *
     * @param messages - 完整的对话历史（包含本轮用户消息）
     * @param options  - 调用参数（模型、工具、温度等）
     * @returns 异步 ResponseChunk 事件流
     *
     * 标记: "LLM 调用的核心入口" — Agent Loop 每轮推理都通过此方法获取 LLM 响应
     */
    chat(
        messages: Message[],
        options: ChatOptions,
    ): AsyncIterable<ResponseChunk>;

    /**
     * 获取模型上下文窗口大小
     *
     * 解决问题:
     *   1. 不同模型的上下文窗口差异很大（32K ~ 1M tokens），
     *      Agent 需要知道上限以决定何时压缩历史或清理上下文
     *   2. 在上下文接近上限时提前警告用户
     *
     * @param model - 模型标识
     * @returns 上下文窗口 token 数
     *
     * 标记: "上下文容量的查询接口"
     */
    contextWindow(model: string): number;

    /**
     * 估算消息列表的 token 数
     *
     * 解决问题:
     *   1. 在发送消息前预判 token 消耗，避免超出上下文窗口导致 API 报错
     *   2. 用于 TokenUsage 统计和成本预估
     *
     * 标记: "token 计数的预检接口" — 不同 Provider 使用不同的 tokenizer
     */
    countTokens(messages: Message[]): Promise<number>;

    /**
     * 检测 Provider 是否支持某个特性
     *
     * 解决问题:
     *   1. 不同厂商的能力差异很大（如 DeepSeek 不支持 vision），
     *      特性检测让 Agent Loop 可以自动适配，而不是硬编码厂商判断
     *   2. 支持的检测维度：
     *      - thinking: Anthropic Extended Thinking
     *      - caching:  Prompt Cache
     *      - vision:   图片理解
     *      - tools:    工具调用（Function Calling）
     *
     * 标记: "Provider 能力查询接口" — 驱动 Agent Loop 的条件行为分支
     */
    supportsFeature(feature: "thinking" | "caching" | "vision" | "tools"): boolean;

    /**
     * Provider 名称 — 如 "anthropic"、"openai"、"deepseek"
     *
     * 解决问题: 日志、错误提示、用户配置中需要标识当前使用的 Provider
     *
     * 标记: "Provider 的身份标识" — 只读属性，创建后不可变
     */
    readonly name: string;
}
