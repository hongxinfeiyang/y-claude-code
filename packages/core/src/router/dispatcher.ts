// ─── packages/core/src/router/dispatcher.ts ───
// 路由分发器（RouterDispatcher）
//
// 【标记是什么】
// RouterDispatcher 是意图识别的"下游执行器"。它接收 IntentRouter 的分类结果，
// 根据意图类型将请求分发到三条不同的执行路径：命令执行、工具调用、Agent Loop。
//
// 【解决什么问题】
// 1. 解耦路由与执行：IntentRouter 只负责"识别意图"，Dispatcher 负责"执行意图"，
//    两个职责分离，各自可独立测试和扩展。
// 2. 统一的权限守门：所有 DIRECT_TOOL 路径都会经过 PermissionManager 检查，
//    确保即使绕过了 LLM，工具执行仍然受到权限管控。
// 3. 优雅降级：当命令 handler 未注册或工具不在注册表中时，自动回退到 Agent Loop，
//    不会因为配置缺失而导致用户输入被丢弃。
// 4. 统一返回类型：所有执行路径通过 DispatchResult 联合类型标准化输出，
//    让上层调用者（CLI/UI 层）可以用统一的方式处理不同路径的结果。

import type { ToolRegistry } from "../tools/registry";
import type { AgentConfig, TurnEvent } from "../types/agent";
import type { ToolContext, ISandbox, Logger } from "../types/tools";
import type { PermissionManager } from "../permission/manager";
import { IntentRouter, IntentType } from "./intent-router";
import type { RouteResult } from "./intent-router";

/**
 * 分发结果联合类型
 *
 * 【标记是什么】
 * 四种可能的执行结果，每种对应不同的展示方式。
 *
 * 【解决什么问题】
 * 让上层调用者可以通过 type 字段做 switch 分发，根据不同结果类型
 * 采取不同的 UI 渲染策略（命令结果显示为文本、工具结果显示为代码块、
 * Agent Loop 结果显示为流式对话、拒绝结果显示为警告）。
 */
export type DispatchResult =
    /** 内置命令执行结果，直接输出文本 */
    | { type: "command"; output: string }
    /** 工具调用结果，output 为工具返回值字符串，error 标记是否出错 */
    | { type: "tool_result"; output: string; error: boolean }
    /** Agent Loop 结果，返回异步生成器以支持流式输出 Turn 事件 */
    | { type: "agent_loop"; stream: AsyncGenerator<TurnEvent> }
    /** 权限拒绝，message 包含拒绝原因 */
    | { type: "denied"; message: string };

/**
 * 命令处理函数类型
 *
 * 【标记是什么】
 * 接收命令参数和 Agent 配置，返回字符串或 Promise<string>。
 *
 * 【解决什么问题】
 * 统一命令 handler 的签名，让不同命令的实现方式保持一致。
 * 支持同步和异步两种返回方式，适应不同的命令处理场景
 * （如 /help 同步返回文本，/model 可能需要异步验证）。
 */
type CommandHandler = (args: string, config: AgentConfig) => Promise<string> | string;

/**
 * 路由分发器
 *
 * 【标记是什么】
 * 将 IntentRouter 的分类结果调度到对应执行路径的核心调度器。
 * 持有两张内部表：
 * 1. router           — IntentRouter 实例，负责输入分类
 * 2. toolRegistry     — 工具注册表，存放所有可用工具的执行定义
 * 3. commandHandlers  — 命令名 → 处理函数的映射（由上层通过 registerCommandHandler 注入）
 *
 * 【解决什么问题】
 * 作为意图识别和实际执行之间的"调度中枢"，负责：
 * - 命令匹配 → 调用 handler 执行（无 handler 时回退到 Agent Loop）
 * - 工具匹配 → 权限检查 → 调用 tool.execute()
 * - 无法匹配 → 委托给 Agent Loop（LLM 推理）
 * 同时确保所有路径都有对应的错误处理和回退机制。
 */
export class RouterDispatcher {
    /** 意图路由器实例，用于对用户输入做初步分类 */
    private router: IntentRouter;

    /** 工具注册表，提供工具查找和执行能力 */
    private toolRegistry: ToolRegistry;

    /**
     * 命令 handler 注册表
     * 【标记是什么】命令名到处理函数的映射
     * 【解决什么问题】让不同命令可以有完全不同的实现逻辑，// 通过 registerCommandHandler 动态注册
     */
    private commandHandlers: Map<string, CommandHandler> = new Map();

    /**
     * @param toolRegistry — 工具注册表实例，Dispatcher 通过它查找和执行工具
     */
    constructor(toolRegistry: ToolRegistry) {
        this.router = new IntentRouter();
        this.toolRegistry = toolRegistry;
    }

    /**
     * 分发用户输入 — Dispatcher 的核心入口方法
     *
     * 【标记是什么】
     * 接收用户输入、Agent 配置、Agent Loop 工厂函数和运行时环境，
     * 根据路由结果分发到对应的执行路径。
     *
     * 【解决什么问题】
     * 将"识别"和"执行"串联起来，提供统一的分发入口。调用者只需传入输入和
     * 必要的运行时依赖，不需要关心内部分发逻辑。通过 agentLoopFactory 参数
     * 的依赖注入，避免了 Dispatcher 直接依赖 Agent Loop 的实现细节。
     *
     * @param input              — 用户原始输入字符串
     * @param config             — Agent 配置（模型、温度等）
     * @param agentLoopFactory   — Agent Loop 工厂函数，由上层注入以避免循环依赖
     * @param runtime            — 运行时环境，包含权限管理器和工具上下文工厂
     * @returns 分发结果，类型由 DispatchResult 联合类型约束
     */
    async dispatch(
        input: string,
        config: AgentConfig,
        agentLoopFactory: (input: string, config: AgentConfig) => AsyncGenerator<TurnEvent>,
        runtime: {
            permissionManager: PermissionManager;
            toolContextFactory: () => ToolContext;
        },
    ): Promise<DispatchResult> {
        // ─── 第一步：路由分类 ───
        // 调用 IntentRouter 对用户输入进行分类，得到意图类型和提取的参数
        const route = this.router.route(input);

        switch (route.type) {
            // ─── BUILTIN_COMMAND 路径 ───
            // 【解决什么问题】
            // 内置命令（/help、/clear、/model）不需要 LLM 参与，直接查找已注册的
            // handler 执行。如果 handler 不存在（如未识别的命令），回退到 Agent Loop
            // 让 LLM 尝试理解并给出友好提示，而不是直接报错。
            case IntentType.BUILTIN_COMMAND: {
                const handler = this.commandHandlers.get(route.command ?? "");
                if (handler) {
                    const output = await handler(route.commandArgs ?? "", config);
                    return { type: "command", output };
                }
                // handler 未注册时回退到 Agent Loop，确保用户输入不丢失
                return { type: "agent_loop", stream: agentLoopFactory(input, config) };
            }

            // ─── DIRECT_TOOL 路径 ───
            // 【解决什么问题】
            // 用户输入被识别为明确的工具调用（如"读取 a.ts"），跳过 LLM 推理直接执行。
            // 执行前必须经过权限检查：如果工具需要用户确认（如 Write、Bash），
            // 则弹出权限对话框，用户拒绝则返回 denied 结果。
            // 如果工具不在注册表中，回退到 Agent Loop 让 LLM 选择替代方案。
            case IntentType.DIRECT_TOOL: {
                const toolName = route.toolName ?? "";
                const tool = this.toolRegistry.get(toolName);

                if (!tool) {
                    // 工具不在注册表中，回退到 Agent Loop
                    // 【解决什么问题】
                    // 避免因工具未注册而直接报错，给 LLM 机会选择替代工具或
                    // 通过其他方式完成用户意图。
                    return { type: "agent_loop", stream: agentLoopFactory(input, config) };
                }

                // ─── 构建 ToolUse 对象进行权限检查 ───
                // 【解决什么问题】
                // 即使跳过了 LLM，权限控制仍然生效。
                // Write、Bash 等敏感工具仍然需要用户确认才能执行。
                const toolUse = { id: "direct", name: toolName, input: route.toolParams ?? {} };

                if (tool.requiresApproval(toolUse.input)) {
                    // 弹出权限确认（由 CLI 层注入的 PermissionManager 处理）
                    const approved = await runtime.permissionManager.check(toolUse);
                    if (!approved) {
                        return { type: "denied", message: `用户拒绝了工具调用: ${toolName}` };
                    }
                }

                // ─── 直接执行工具 ───
                // 【解决什么问题】
                // 权限检查通过后，直接调用 tool.execute() 执行工具。
                // try/catch 确保工具执行异常不会导致进程崩溃，
                // 而是返回包含错误信息的 DispatchResult。
                try {
                    const ctx = runtime.toolContextFactory();
                    const result = await tool.execute(toolUse.input, ctx);
                    const content = typeof result.content === "string"
                        ? result.content
                        : JSON.stringify(result.content);
                    return {
                        type: "tool_result",
                        output: content,
                        error: result.is_error ?? false,
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : "工具执行异常";
                    return {
                        type: "tool_result",
                        output: `执行失败: ${message}`,
                        error: true,
                    };
                }
            }

            // ─── NATURAL_LANGUAGE 路径（兜底）───
            // 【解决什么问题】
            // 所有规则都无法匹配时，进入 Agent Loop 由 LLM 进行多步推理。
            // 这是整个系统的"安全网"，确保任何复杂问题都不会被丢弃。
            case IntentType.NATURAL_LANGUAGE:
            default:
                return { type: "agent_loop", stream: agentLoopFactory(input, config) };
        }
    }

    /**
     * 获取内部 IntentRouter 实例
     * 【标记是什么】暴露 IntentRouter 引用给外部调用者
     * 【解决什么问题】允许外部动态注册新的命令和工具模式（如插件系统）
     */
    getRouter(): IntentRouter {
        return this.router;
    }

    /**
     * 注册命令 handler
     * 让外部使用者（CLI、插件等）为特定斜杠命令注册自定义处理逻辑。
     * 若不注册任何 handler，BUILTIN_COMMAND 路径会回退到 Agent Loop。
     */
    registerCommandHandler(command: string, handler: CommandHandler): void {
        this.commandHandlers.set(command, handler);
    }
}
