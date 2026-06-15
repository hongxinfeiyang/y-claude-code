// ─── packages/core/src/types/index.ts ───
// 类型体系统一导出入口（Barrel Export）
// 解决问题:
//   1. 外部消费者只需 import from "@anthropic-claude/core/types" 即可获取所有类型，
//      无需关心类型定义分布在哪个具体文件中
//   2. 控制导出范围：只导出需要暴露给外部使用的公开类型，
//      内部辅助类型保留在各自的文件中不导出
//   3. 重导出模式使文件结构变更不影响外部使用者（只需调整此文件即可）

// ─── 消息类型 ───
// 导出 LLM 对话的基础数据类型：消息角色、内容块、流式 chunk、token 统计
// 解决问题: 外部模块（UI、日志、序列化）需要消费和构建消息
export {
    type MessageRole,
    type ToolUse,
    type ToolResult,
    type TextBlock,
    type ImageBlock,
    type Message,
    type ResponseChunk,
    type TokenUsage,
    type LLMToolDefinition,
} from "./messages";

// ─── 工具类型 ───
// 导出工具系统的核心类型：参数 Schema、执行上下文、工具基类
// 解决问题: 内置工具和自定义工具插件需要使用这些类型来定义和实现工具
export { type SchemaProperty, type JSONSchema, type ToolContext, Tool } from "./tools";

// ─── Agent 类型 ───
// 导出 Agent 运行时的类型：状态枚举、启动配置、流式事件、Provider 接口
// 解决问题: Agent Loop、UI 层、Provider 实现方分别依赖这些类型完成各自职责
export {
    AgentState,
    type AgentConfig,
    type TurnEvent,
    type ChatOptions,
    type LLMProvider,
} from "./agent";

// ─── 配置类型 ───
// 导出用户配置的类型定义和默认值：Provider、权限、快捷指令等
// 解决问题: 配置加载、合并、验证模块需要这些类型来保证类型安全
export {
    type ProviderConfig,
    type PermissionRule,
    type Shortcut,
    type UserConfig,
    DEFAULT_USER_CONFIG,
} from "./config";

// ─── 会话类型 ───
// 导出会话管理的类型：会话数据、会话摘要、存储接口
// 解决问题: 会话持久化模块和 CLI 会话管理命令依赖这些类型
export { type SessionData, type SessionSummary, type SessionStore } from "./session";
