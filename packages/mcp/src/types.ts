// ─── packages/mcp/src/types.ts ───
// MCP 协议类型定义 — Model Context Protocol JSON-RPC 消息格式
// 解决问题：MCP（Model Context Protocol）定义了 AI 模型与外部工具/服务之间的标准化通信协议。
// 本模块定义完整的 JSON-RPC 消息类型、工具描述结构、服务配置等类型，
// 使 TypeScript 编译器能在编译时检查协议消息的正确性，避免运行时协议错误。

// ─── JSON-RPC 基础消息类型 ───
// MCP 基于 JSON-RPC 2.0 协议，使用请求-响应模式和通知模式进行通信
// 解决问题：统一 MCP Server 和 Client 之间的消息格式，使用行业标准协议降低对接成本

/**
 * JSON-RPC 请求消息
 * 用于 Client 向 Server 发起调用（如 initialize、tools/call 等）
 * 包含唯一 id 用于关联响应
 */
export interface JSONRPCRequest {
    /** JSON-RPC 协议版本，固定 "2.0" */
    jsonrpc: "2.0";
    /** 请求 ID，用于将响应与请求关联，支持数字和字符串 */
    id: number | string;
    /** 要调用的方法名，如 "tools/list"、"resources/read" 等 */
    method: string;
    /** 方法参数，可选，具体结构由方法定义 */
    params?: Record<string, unknown>;
}

/**
 * JSON-RPC 响应消息
 * 用于 Server 向 Client 返回调用结果或错误
 */
export interface JSONRPCResponse {
    /** JSON-RPC 协议版本，固定 "2.0" */
    jsonrpc: "2.0";
    /** 对应请求的 ID，用于 Client 匹配 pending 请求 */
    id: number | string;
    /** 成功时的返回结果，与 error 互斥 */
    result?: unknown;
    /** 失败时的错误信息，与 result 互斥 */
    error?: { code: number; message: string; data?: unknown };
}

/**
 * JSON-RPC 通知消息（无 id，不期待响应）
 * 用于单向通知场景，如 initialized 通知、进度更新等
 * 解决问题：某些协议交互不需要响应（如 Server 初始化完成通知），
 * 使用通知模式减少不必要的请求-响应往返
 */
export interface JSONRPCNotification {
    /** JSON-RPC 协议版本，固定 "2.0" */
    jsonrpc: "2.0";
    /** 通知方法名 */
    method: string;
    /** 通知参数，可选 */
    params?: Record<string, unknown>;
}

// ─── MCP 工具相关类型 ───
// 定义 MCP Server 暴露的工具的描述格式和调用结果
// 解决问题：AI 需要知道可用工具的名称、功能描述、参数 schema 才能正确调用，
// 这些类型定义了工具元数据和调用结果的标准格式

/**
 * MCP 工具定义
 * 描述一个 MCP Server 提供的工具，包含名称、功能描述和输入参数的 JSON Schema
 * 被 AI 模型用来理解可用工具并生成正确的工具调用
 */
export interface MCPToolDefinition {
    /** 工具名称，在同一个 Server 内唯一 */
    name: string;
    /** 工具功能描述，用于 AI 理解何时使用该工具 */
    description: string;
    /** 输入参数的 JSON Schema 定义，描述参数的类型、属性和必填项 */
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
}

/**
 * MCP 工具调用结果
 * 封装工具执行后的返回内容，支持文本和图片内容
 */
export interface MCPToolCallResult {
    /** 返回内容数组，每个元素可以是文本或图片 */
    content: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
    /** 是否为错误结果，true 表示工具调用虽然完成但返回了错误 */
    isError?: boolean;
}

// ─── MCP 服务器信息类型 ───
// 定义 MCP Server 的元数据，用于 Client 识别和适配不同 Server

/**
 * MCP 服务信息
 * 从 initialize 响应中获取，描述 Server 的身份和能力
 */
export interface MCPServerInfo {
    /** 服务名称 */
    name: string;
    /** 服务版本号 */
    version: string;
    /** MCP 协议版本 */
    protocolVersion: string;
    /** 服务能力声明：tools、resources、prompts 等 */
    capabilities: {
        tools?: Record<string, unknown>;
        resources?: Record<string, unknown>;
        prompts?: Record<string, unknown>;
    };
}

/**
 * MCP 服务端配置
 * 定义如何启动和连接到一个 MCP Server 进程
 * 解决问题：MCP Server 是独立进程，Client 需要知道启动命令、参数、环境变量
 * 等信息才能通过 stdio 与之连接
 */
export interface MCPServerConfig {
    /** 服务名称，用于在 UI 中标识和区分不同的 MCP Server */
    name: string;
    /** 启动命令，如 "node"、"python" 等可执行文件路径 */
    command: string;
    /** 命令参数，如 ["server.js", "--port", "3000"] */
    args: string[];
    /** 环境变量，会与当前进程环境合并后传递给 MCP Server 进程 */
    env?: Record<string, string>;
    /** 连接超时 (ms)，超过此时间未完成 initialize 则视为连接失败 */
    connectTimeout?: number;
}
