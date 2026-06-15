// ═══════════════════════════════════════════════════════════════════════════════
// packages/core/src/index.ts
// @y-claude-code/core 公共 API 入口 — 统一导出所有对外可用的类型和模块
//
// 【解决什么问题】
// 这是 core 包的 barrel export 文件，集中管理所有公共 API 的导出。
// 外部使用者（CLI、插件、测试）只需 import from "@y-claude-code/core"
// 即可获取全部公共类型和功能，无需关心内部文件结构。
//
// 【设计原则】
//   1. 只导出公开 API，内部实现细节（如 *.internal.ts）不出现在此文件
//   2. 按功能域分组导出，每组用分隔注释标注
//   3. 类型和值分开导出，类型用 `import type` 消费时可被 tree-shaking 优化
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
//  类型定义导出
//  数据模型层 — 整个系统中流通的基础数据结构
// ═══════════════════════════════════════════════════════════════════════════════

export {
    // AgentState — Agent 运行状态枚举（idle/thinking/executing/error 等）
    AgentState,
    // MessageRole — 消息角色类型（user/assistant/system）
    type MessageRole,
    // ToolUse — 工具调用请求的数据结构（工具名 + 输入参数）
    type ToolUse,
    // ToolResult — 工具执行结果的数据结构（输出 + 是否出错）
    type ToolResult,
    // TextBlock — 文本内容块（用于 LLM 请求/响应中的多模态内容块）
    type TextBlock,
    // ImageBlock — 图片内容块（base64 编码 + media type）
    type ImageBlock,
    // Message — LLM 对话消息（role + 内容块数组）
    type Message,
    // ResponseChunk — LLM 流式响应的单个数据块
    type ResponseChunk,
    // TokenUsage — token 用量统计（输入/输出 token 数）
    type TokenUsage,
    // LLMToolDefinition — 工具定义结构（JSON Schema 格式的工具描述）
    type LLMToolDefinition,
    // SchemaProperty — JSON Schema 中单个属性的定义
    type SchemaProperty,
    // JSONSchema — 完整的 JSON Schema 类型
    type JSONSchema,
    // ToolContext — 工具执行上下文（文件系统路径、权限管理器等）
    type ToolContext,
    // Tool — 工具基类接口（所有内置和自定义工具的父类型）
    Tool,
    // AgentConfig — Agent 配置项（模型、温度、max_tokens 等）
    type AgentConfig,
    // TurnEvent — Agent 单次循环的事件类型
    type TurnEvent,
    // ChatOptions — 对话选项（流式/非流式、温度等）
    type ChatOptions,
    // LLMProvider — LLM 提供商接口（anthropic/openai 等的抽象）
    type LLMProvider,
    // UserConfig — 用户配置数据类型
    type UserConfig,
    // DEFAULT_USER_CONFIG — 默认用户配置常量
    DEFAULT_USER_CONFIG,
    // SessionData — 会话数据（消息历史、token 用量等）
    type SessionData,
    // SessionSummary — 会话摘要（用于恢复历史对话）
    type SessionSummary,
    // SessionStore — 会话持久化存储接口
    type SessionStore,
} from "./types/index";

// ═══════════════════════════════════════════════════════════════════════════════
//  核心模块导出
//  业务逻辑层 — Agent 主循环、路由、工具系统
// ═══════════════════════════════════════════════════════════════════════════════

// ── Agent 主循环 ──
// AgentLoop — 驱动 AI Agent 的核心引擎，负责"思考→行动→观察"循环
export { AgentLoop } from "./agent/loop";

// ── 错误恢复模块 ──
// ErrorRecoveryManager — 错误恢复主控制器（分类、重试、回退、熔断）
export { ErrorRecoveryManager } from "./agent/error-recovery/manager";
export type { ErrorRecoveryConfig } from "./agent/error-recovery/manager";
// ErrorClassifier — 错误分类器
export { ErrorClassifier } from "./agent/error-recovery/classifier";
// RetryManager — 指数退避重试管理器
export { RetryManager } from "./agent/error-recovery/retry";
// CircuitBreakerManager — 熔断器管理器
export { CircuitBreakerManager, CircuitState } from "./agent/error-recovery/circuit-breaker";
// ProviderFailoverManager — LLM Provider 回退管理器
export { ProviderFailoverManager } from "./agent/error-recovery/failover";
// 错误恢复相关类型和常量
export {
    ErrorCategory,
    RecoveryStrategy,
    DEFAULT_RETRY_CONFIG,
    DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "./agent/error-recovery/types";
export type {
    ErrorInfo,
    RecoveryResult,
    RetryConfig,
    CircuitBreakerConfig,
    ProviderFailoverConfig,
} from "./agent/error-recovery/types";

// ── 意图路由 ──
// IntentRouter — 分析用户输入意图，决定走对话/命令/技能等不同路径
export { IntentRouter, IntentType } from "./router/intent-router";
// RouterDispatcher — 根据路由结果分发到对应的处理器
export { RouterDispatcher } from "./router/dispatcher";

// ── 工具注册表 ──
// ToolRegistry — 工具注册与查找中心，管理所有可用工具的元数据和实例
export { ToolRegistry } from "./tools/registry";

// ═══════════════════════════════════════════════════════════════════════════════
//  内置工具导出
//  工具实现层 — Agent 可以调用的各种操作（文件读写、搜索、Shell 等）
// ═══════════════════════════════════════════════════════════════════════════════

export {
    ReadTool,            // 文件读取工具 — 读取文件内容，支持行范围指定
    WriteTool,           // 文件写入工具 — 创建或覆盖文件
    EditTool,            // 文件编辑工具 — 精确字符串替换
    BashTool,            // Shell 执行工具 — 运行 Bash 命令
    GlobTool,            // 文件匹配工具 — 按通配符模式查找文件
    GrepTool,            // 内容搜索工具 — 在文件中搜索匹配文本
    WebFetchTool,        // 网页抓取工具 — 获取并解析网页内容
    WebSearchTool,       // 网页搜索工具 — 执行在线搜索
    AgentTool,           // 子 Agent 工具 — 委派任务给独立的子 Agent
    executeSubAgentsInParallel, // 并行子代理执行器
    AskUserQuestionTool, // 用户提问工具 — AI 向用户发问以澄清需求
    EnterPlanModeTool,   // 进入计划模式 — 限制为只读工具进行代码探索和设计
    ExitPlanModeTool,    // 退出计划模式 — 提交方案供用户审批
    filterToolsForPlanMode, // 计划模式工具过滤器
    TodoWriteTool,       // 任务列表管理 — Agent 创建和跟踪结构化任务
    CronCreateTool,      // 定时任务创建
    CronDeleteTool,      // 定时任务删除
    CronListTool,        // 定时任务列表
    ScheduleWakeupTool,  // 动态调度唤醒
    TaskOutputTool,      // 后台任务输出获取
    TaskStopTool,        // 后台任务停止
    SkillTool,           // 项目 Skill 调用
    NotebookEditTool,    // Jupyter Notebook 编辑
    EnterWorktreeTool,   // 进入 git worktree — 创建隔离工作环境
    ExitWorktreeTool,    // 退出 git worktree — 清理或保留隔离环境
    setCronScheduler,    // 注入 CronScheduler 实例
    registerBackgroundTask, // 注册后台任务
    updateBackgroundTask,   // 更新后台任务状态
    setSkillLoader,      // 注入 SkillLoader 实例（供 SkillTool）
} from "./tools/builtin/index";

// ═══════════════════════════════════════════════════════════════════════════════
//  LLM 相关导出
//  大语言模型层 — 提供商适配、token 计数、缓存管理
// ═══════════════════════════════════════════════════════════════════════════════

// AnthropicProvider — Anthropic Claude API 的适配器实现
export { AnthropicProvider } from "./llm/anthropic";
// OpenAIProvider — OpenAI API 的适配器实现（GPT 系列模型）
export { OpenAIProvider } from "./llm/openai";
// createProvider — 根据配置创建 LLM 提供商的工厂函数
// listConfiguredProviders — 列出所有已配置的可用提供商
// isProviderAvailable — 检查指定提供商是否已配置且可用
export {
    createProvider,
    listConfiguredProviders,
    isProviderAvailable,
} from "./llm/factory";
// TokenCounter — Token 计数工具，用于估算消息和文本的 token 消耗
export { TokenCounter } from "./llm/token-counter";
// markCacheable — 标记消息块可被 LLM 缓存（用于 Anthropic prompt caching）
// calculateCacheHitRate — 计算 prompt caching 的命中率
export { markCacheable, calculateCacheHitRate } from "./llm/token-counter";
// CacheStats — 缓存统计数据类型
export type { CacheStats } from "./llm/token-counter";

// ═══════════════════════════════════════════════════════════════════════════════
//  配置与会话管理导出
//  基础设施层 — 配置加载、会话持久化、权限管理
// ═══════════════════════════════════════════════════════════════════════════════

// ConfigLoader — 配置加载器，从 settings.json / settings.local.json 加载用户配置
// configLoader — 预创建的全局单例配置加载器
export { ConfigLoader, configLoader } from "./config/loader";

// ContextBuilder — 上下文构建器，组装每次 LLM 请求的 system prompt + messages
export { ContextBuilder } from "./context/builder";
// Summarizer — LLM 驱动对话摘要器，渐进式压缩长对话历史
export { Summarizer, DEFAULT_SUMMARIZE_CONFIG } from "./context/summarizer";
export type { SummarizeConfig } from "./context/summarizer";
// buildSystemPrompt — System Prompt 构建器
// rebuildBasePrompt — 快速重建基础 Prompt（不含 Skill）
export { buildSystemPrompt, rebuildBasePrompt } from "./context/system-prompt";
export type { SystemPromptEnv, SystemPromptOptions } from "./context/system-prompt";
// CacheManager — Prompt Cache 管理器（断点标记 + 命中率统计 + TTL 感知）
export { CacheManager, DEFAULT_CACHE_CONFIG } from "./context/cache-manager";
export type { CacheConfig, CacheState } from "./context/cache-manager";
// ContextMonitor — 上下文窗口实时监控器
export { ContextMonitor, DEFAULT_MONITOR_CONFIG } from "./context/monitor";
export type { ContextMonitorConfig, ContextStatus, ContextHealth } from "./context/monitor";

// PermissionManager — 权限管理器，处理工具调用的允许/拒绝/持久化策略
export { PermissionManager } from "./permission/manager";

// SessionManager — 会话管理，管理多轮对话的消息历史和状态恢复
// FileSessionStore — 基于文件系统的会话持久化存储实现
export { SessionManager, FileSessionStore } from "./session/manager";

// SkillLoader — Skill 加载器，加载和执行自定义 Skill 脚本
// SkillDefinition — Skill 定义的数据结构类型
export { SkillLoader } from "./skills/loader";
export type { SkillDefinition } from "./skills/loader";

// HookManager — 钩子管理器，管理生命周期事件（onSubmit/onStop 等）的回调
export { HookManager } from "./hooks/manager";
// HookEvent / HookConfig / HookHandler — 钩子系统的类型定义
export type { HookEvent, HookConfig, HookHandler } from "./hooks/types";

// MemoryStore — 记忆存储，管理 AI 长期记忆的增删查
export { MemoryStore } from "./memory/store";
// MemoryEntry / MemoryType / MemoryIndexEntry — 记忆系统的数据类型
export type { MemoryEntry, MemoryType, MemoryIndexEntry } from "./memory/types";

// Logger — 日志记录器（可配置日志级别和输出目标）
// createNoopLogger — 创建空操作日志器的工厂（用于测试和静默模式）
export { Logger, createNoopLogger } from "./utils/logger";
// LogLevel — 日志级别类型（debug/info/warn/error）
export type { LogLevel } from "./utils/logger";

// CronScheduler — 定时任务调度器，管理周期性任务
export { CronScheduler } from "./utils/cron";

// AutoUpdateManager — 自动更新检查管理器
export { AutoUpdateManager } from "./utils/auto-update";
export type { VersionInfo, AutoUpdateConfig } from "./utils/auto-update";

// TelemetryManager — 匿名遥测数据收集管理器
export { TelemetryManager } from "./utils/telemetry";
export type { TelemetryEvent, TelemetryEventType, TelemetryConfig } from "./utils/telemetry";

// TmuxManager — Tmux 终端多路复用管理器
export { TmuxManager } from "./utils/tmux";
export type { TmuxWindowConfig, TmuxPaneConfig, TmuxSessionInfo, TmuxEnvironment } from "./utils/tmux";
// CronJob — 定时任务的数据结构类型
export type { CronJob } from "./utils/cron";

// sanitizeInput / sanitizeOutput / isPathSafe — 安全工具函数
// 输入净化、输出净化、路径安全检查
export { sanitizeInput, sanitizeOutput, isPathSafe } from "./utils/security";

// AgentLoopContext — Agent 主循环的上下文类型（注入到每个工具调用中）
export type { AgentLoopContext } from "./agent/loop";

// ═══════════════════════════════════════════════════════════════════════════════
//  可观测性模块导出
//  Transcript 记录 / Metrics 收集 / Tracing 追踪
// ═══════════════════════════════════════════════════════════════════════════════

// ObservabilityManager — 可观测性主控制器
export { ObservabilityManager } from "./observability/manager";
// TranscriptWriter — JSONL 对话记录器
export { TranscriptWriter } from "./observability/transcript";
// MetricsCollector — 性能指标收集器
export { MetricsCollector } from "./observability/metrics";
// Tracer — 链路追踪器
export { Tracer } from "./observability/tracer";
// 可观测性相关类型和常量
export { DEFAULT_OBSERVABILITY_CONFIG } from "./observability/types";
export type {
    TranscriptEvent,
    TranscriptEventType,
    Span,
    MetricCounter,
    MetricHistogram,
    MetricGauge,
    MetricsSnapshot,
    TranscriptConfig,
    MetricsConfig,
    TracingConfig,
    ObservabilityConfig,
} from "./observability/types";
