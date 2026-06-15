// ─── packages/mcp/src/client.ts ───
// MCP Client — 通过 stdio 与 MCP Server 进程通信，使用 JSON-RPC 协议
// 解决问题：MCP Server 是独立进程，Client 需要管理进程生命周期、序列化/反序列化
// JSON-RPC 消息、处理请求-响应匹配、处理连接超时和异常退出。核心设计：
//   1. stdio 通信 — 通过 stdin/stdout 与子进程交互，无需端口管理
//   2. 逐行 JSON — 每行一个 JSON-RPC 消息，用 readline 模块解析
//   3. 请求-响应映射 — 用 Map 维护 pending 请求，id 匹配响应
//   4. 初始化握手 — 遵循 MCP 协议: initialize 请求 → initialized 通知

import { ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCNotification,
    MCPToolDefinition,
    MCPToolCallResult,
    MCPServerInfo,
    MCPServerConfig,
} from "./types";

// ─── MCPClient ───
// MCP 客户端，管理与一个 MCP Server 进程的完整生命周期
// 使用场景：在 Claude Code 启动时根据配置启动 MCP Server，注册其工具到 ToolRegistry

export class MCPClient {
    /** MCP Server 子进程引用，null 表示未启动或已断开 */
    private process: ChildProcess | null = null;

    /** 自增请求 ID，每次 sendRequest 递增，确保每个请求有唯一标识 */
    private requestId = 0;

    /** 待处理的请求映射表 (id → {resolve, reject})，用于异步响应匹配 */
    private pendingRequests: Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map();

    /** 服务器元信息，initialize 完成后赋值 */
    private serverInfo: MCPServerInfo | null = null;

    /** 缓存的工具列表，listTools 调用后缓存，避免重复请求 */
    private tools: MCPToolDefinition[] = [];

    /** MCP Server 的显示名称 */
    readonly serverName: string;

    /** MCP Server 启动配置 */
    private config: MCPServerConfig;

    /**
     * @param config - MCP Server 启动配置（命令、参数、环境变量等）
     */
    constructor(config: MCPServerConfig) {
        this.serverName = config.name;
        this.config = config;
    }

    // ══════════════════════════════════════════════════════════════════
    // 连接管理
    // ══════════════════════════════════════════════════════════════════

    /**
     * 启动 MCP Server 进程并完成 MCP 协议初始化握手
     *
     * 初始化流程（遵循 MCP 协议规范）：
     *   1. spawn 子进程（传入命令、参数、环境变量）
     *   2. 建立 readline 接口逐行读取 stdout 中的 JSON-RPC 消息
     *   3. 发送 initialize 请求（携带客户端版本和能力声明）
     *   4. 收到 initialize 响应后发送 initialized 通知（握手完成）
     *   5. 设置连接超时定时器，超时则拒绝 Promise
     *
     * @returns MCP Server 元信息（名称、版本、能力声明等）
     */
    async connect(): Promise<MCPServerInfo> {
        return new Promise((resolve, reject) => {
            // 连接超时保护：超过配置时间未完成初始化则失败
            // 原因：防止 Server 进程卡死或启动失败导致 Client 永久等待
            const timeout = setTimeout(() => {
                reject(new Error(`MCP Server "${this.serverName}" 连接超时`));
            }, this.config.connectTimeout ?? 30_000);

            // 启动 MCP Server 子进程
            // stdio 配置: stdin/stdout 用于 JSON-RPC 通信，stderr 透传（用于调试）
            this.process = spawn(this.config.command, this.config.args, {
                env: { ...process.env, ...this.config.env },
                stdio: ["pipe", "pipe", "pipe"],
            });

            // ─── 逐行读取 stdout ───
            // MCP 协议使用换行分隔的 JSON 流（每行一个完整的 JSON-RPC 消息）
            // 使用 readline 而非直接读取 Buffer，因为 JSON 消息边界与 Buffer chunk 边界不一致
            const rl = createInterface({ input: this.process.stdout! });
            rl.on("line", (line: string) => {
                try {
                    const message = JSON.parse(line) as JSONRPCResponse | JSONRPCNotification;
                    // 只处理响应消息（有 id），通知消息由上层按需处理
                    if ("id" in message && message.id !== undefined) {
                        const pending = this.pendingRequests.get(message.id);
                        if (pending) {
                            if (message.error) {
                                pending.reject(new Error(message.error.message));
                            } else {
                                pending.resolve(message.result);
                            }
                            this.pendingRequests.delete(message.id);
                        }
                    }
                } catch {
                    // 非法的 JSON 行或非 JSON 内容（如 Server 的调试输出），静默忽略
                }
            });

            // 进程级错误（如命令不存在、权限不足）直接拒绝
            this.process.on("error", (err) => reject(err));

            // 进程异常退出处理：如果在初始化完成前退出则视为连接失败
            this.process.on("exit", (code) => {
                if (code !== 0 && !this.serverInfo) {
                    reject(new Error(`MCP Server 异常退出，code: ${code}`));
                }
            });

            // ─── 发送 initialize 请求，开始 MCP 协议握手 ───
            this.sendRequest("initialize", {
                protocolVersion: "2025-03-26",                       // MCP 协议版本
                capabilities: { tools: {} },                        // 声明客户端支持工具调用能力
                clientInfo: { name: "y-claude-code", version: "0.1.0" },
            })
                .then((result) => {
                    clearTimeout(timeout);                          // 握手成功，清除超时定时器
                    this.serverInfo = result as MCPServerInfo;
                    // MCP 协议要求：initialize 响应后必须发送 initialized 通知
                    this.sendNotification("notifications/initialized", {});
                    resolve(this.serverInfo);
                })
                .catch(reject);
        });
    }

    // ══════════════════════════════════════════════════════════════════
    // 工具操作
    // ══════════════════════════════════════════════════════════════════

    /**
     * 列出 MCP Server 提供的所有工具
     * 调用 tools/list 方法获取工具列表并缓存，供后续工具调用和 UI 展示使用
     * @returns 工具定义列表，每个包含名称、描述和参数 schema
     */
    async listTools(): Promise<MCPToolDefinition[]> {
        const result = (await this.sendRequest("tools/list", {})) as { tools: MCPToolDefinition[] };
        this.tools = result.tools;
        return this.tools;
    }

    /**
     * 调用 MCP 工具
     * @param name - 工具名称（MCP Server 侧的原始名称，非适配器包装后的名称）
     * @param args - 工具参数，键值对形式
     * @returns 工具调用结果，包含内容和错误标记
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolCallResult> {
        const result = (await this.sendRequest("tools/call", {
            name,
            arguments: args,
        })) as MCPToolCallResult;
        return result;
    }

    // ══════════════════════════════════════════════════════════════════
    // 资源操作
    // ══════════════════════════════════════════════════════════════════

    /**
     * 列出 MCP Server 提供的所有资源
     * 资源是 MCP 协议中的只读数据源（如文件内容、数据库查询结果等）
     * @returns 资源列表
     */
    async listResources(): Promise<unknown[]> {
        const result = (await this.sendRequest("resources/list", {})) as { resources: unknown[] };
        return result.resources;
    }

    /**
     * 读取 MCP 资源
     * @param uri - 资源 URI，由 listResources 返回
     * @returns 资源内容，格式取决于资源类型
     */
    async readResource(uri: string): Promise<unknown> {
        return this.sendRequest("resources/read", { uri });
    }

    // ══════════════════════════════════════════════════════════════════
    // 状态查询
    // ══════════════════════════════════════════════════════════════════

    /**
     * 获取服务器元信息
     * @returns initialize 后获得的 ServerInfo，未连接时返回 null
     */
    getServerInfo(): MCPServerInfo | null {
        return this.serverInfo;
    }

    /**
     * 获取已缓存的工具列表（不发起网络请求）
     * @returns 上次 listTools 调用缓存的工具列表
     */
    getCachedTools(): MCPToolDefinition[] {
        return this.tools;
    }

    // ══════════════════════════════════════════════════════════════════
    // 生命周期管理
    // ══════════════════════════════════════════════════════════════════

    /**
     * 断开与 MCP Server 的连接并终止子进程
     * 清理所有待处理的请求（它们将永远不会被完成）
     */
    disconnect(): void {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this.pendingRequests.clear();
    }

    // ══════════════════════════════════════════════════════════════════
    // 私有方法 — 底层 JSON-RPC 通信
    // ══════════════════════════════════════════════════════════════════

    /**
     * 发送 JSON-RPC 请求并返回 Promise（请求-响应模式）
     *
     * 原理：生成唯一 id → 在 Map 中注册 {resolve, reject} → 发送 JSON →
     * 当 readline 收到对应 id 的响应时触发 resolve/reject
     * 设计原因：Node.js 子进程的 stdout 是单向流，无法用请求-响应一一对应，
     * 必须通过 id 匹配机制实现异步响应
     *
     * @param method - JSON-RPC 方法名
     * @param params - 方法参数
     * @returns 响应中的 result 字段
     */
    private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
        const id = ++this.requestId;
        const request: JSONRPCRequest = { jsonrpc: "2.0", id, method, params };
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.sendRaw(JSON.stringify(request));
        });
    }

    /**
     * 发送 JSON-RPC 通知（无 id，不期待响应）
     * 用于单向通知场景，如 initialized、进度报告等
     * @param method - 通知方法名
     * @param params - 通知参数
     */
    private sendNotification(method: string, params: Record<string, unknown>): void {
        const notification: JSONRPCNotification = { jsonrpc: "2.0", method, params };
        this.sendRaw(JSON.stringify(notification));
    }

    /**
     * 向 MCP Server 进程的 stdin 写入原始数据
     * 每条消息后追加换行符，因为 MCP 协议使用换行分隔的 JSON 流
     * @param data - 要写入的 JSON 字符串
     */
    private sendRaw(data: string): void {
        if (!this.process?.stdin) {
            throw new Error("MCP 进程未启动");
        }
        this.process.stdin.write(data + "\n");
    }
}
