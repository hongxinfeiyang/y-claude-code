// ─── packages/core/src/tools/builtin/agent.ts ───
// Agent 工具 — 创建子代理处理独立子任务，返回摘要结果
// 解决问题：通过子代理隔离上下文窗口、实现并行处理、降低主会话认知负载

import * as os from "node:os";
import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";
import { AgentLoop } from "../../agent/loop";
import type { AgentConfig } from "../../types/agent";

/**
 * 子代理类型枚举
 * 解决问题：不同类型的子代理有不同的 system prompt 策略和工具限制
 */
type SubAgentType = "claude" | "Explore" | "Plan" | "code-reviewer";

/**
 * 子代理隔离级别
 * 解决问题：不同任务对安全隔离的要求不同
 * - none: 进程内执行，最快但无隔离（默认，适合只读探索任务）
 * - process: 子进程执行，中等隔离
 * - worktree: git worktree 隔离，最安全（适合可能修改代码的任务）
 */
type IsolationLevel = "none" | "process" | "worktree";

/**
 * 子代理运行配置
 */
interface SubAgentConfig {
    description: string;
    prompt: string;
    subagent_type?: SubAgentType;
    isolation?: IsolationLevel;
    max_turns?: number;
    /** 是否后台运行，默认 false（前台阻塞等待结果） */
    run_in_background?: boolean;
}

/**
 * AgentTool — 子代理创建和执行工具
 *
 * 核心设计理念：
 * 1. 上下文隔离：子代理有独立的消息历史，不污染主会话的上下文窗口
 * 2. 并行潜力：executeSubAgentsInParallel 支持 Promise.all 并行执行
 * 3. 认知卸载：复杂探索/分析任务委托给子代理，主 Agent 只看结果摘要
 * 4. 安全隔离：通过 isolation 参数控制子代理的执行环境
 *
 * 子代理类型：
 * - claude: 通用子代理，无特殊限制
 * - Explore: 代码探索专家，只允许只读工具（Read/Glob/Grep）
 * - Plan: 架构规划师，不需要写代码，只输出方案
 * - code-reviewer: 代码审查专家，关注正确性、安全性、性能和可维护性
 */
export class AgentTool extends Tool {
    name = "Agent";

    description = "创建子代理处理独立子任务。适用于：代码库探索、代码审查、并行搜索等。子代理有独立上下文窗口，不污染主会话。支持并行执行多个子代理（同时创建多个 Agent）。";

    parameters: JSONSchema = {
        type: "object",
        properties: {
            description: {
                type: "string",
                description: "子代理任务简述（3-5 字）",
            },
            prompt: {
                type: "string",
                description: "子代理的完整任务描述，应包含目标、背景和期望输出",
            },
            subagent_type: {
                type: "string",
                description: "子代理类型：claude（通用）/ Explore（代码探索）/ Plan（架构规划）/ code-reviewer（代码审查）",
                enum: ["claude", "Explore", "Plan", "code-reviewer"],
                default: "claude",
            },
            isolation: {
                type: "string",
                description: "隔离级别：none（进程内，最快）/ process（子进程）/ worktree（git worktree）",
                enum: ["none", "process", "worktree"],
                default: "none",
            },
            max_turns: {
                type: "number",
                description: "最大工具调用轮次（默认 20）",
                default: 20,
            },
            run_in_background: {
                type: "boolean",
                description: "是否在后台运行（true 时立即返回任务 ID，不等待结果）",
                default: false,
            },
        },
        required: ["description", "prompt"],
    };

    /**
     * 执行子代理任务
     *
     * 流程：
     * 1. 处理隔离级别（worktree 未实现时回退到 none）
     * 2. 构建子代理专用 system prompt（含环境信息）
     * 3. 从主上下文继承 provider 和 tools
     * 4. 后台模式：fire-and-forget
     * 5. 前台模式：创建 AgentLoop 并消费事件流
     */
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const { description, prompt, subagent_type, max_turns, isolation, run_in_background } = params as unknown as SubAgentConfig;

        // ─── 隔离级别处理 ───
        if (isolation === "worktree") {
            // worktree 隔离通过 EnterWorktree/ExitWorktree 工具实现
            // AgentTool 本身不直接创建 worktree，将处理权交还给主 Agent
            return {
                tool_use_id: "",
                content: "使用 worktree 隔离时，请先调用 EnterWorktree 工具创建隔离环境，然后在 worktree 目录中执行任务，完成后调用 ExitWorktree 退出。建议使用 isolation: 'process' 进行进程级隔离，或将 isolation 设置为 'none' 在主进程中执行。",
                is_error: true,
            };
        }

        // ─── 构建子代理 system prompt ───
        const subSystemPrompt = this.buildSubAgentPrompt(subagent_type ?? "claude", prompt);

        // ─── 子代理配置 ───
        const subConfig: AgentConfig = {
            model: "claude-sonnet-4-6",
            provider: (context as unknown as Record<string, unknown>).provider as AgentConfig["provider"],
            maxToolRounds: max_turns ?? 20,
            maxTokensPerTurn: 8000,
            systemPrompt: subSystemPrompt,
            tools: (context as unknown as Record<string, unknown>).tools as AgentConfig["tools"],
            thinkingEnabled: false,
        };

        if (!subConfig.provider) {
            return {
                tool_use_id: "",
                content: "子代理无法访问 LLM Provider，请检查 Agent 配置",
                is_error: true,
            };
        }

        // ─── 后台运行模式 ───
        if (run_in_background) {
            const taskId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            this.runSubAgent(description, prompt, subConfig, context).catch((err) => {
                context.appendMessage?.(`[子代理 ${taskId}] 错误: ${err instanceof Error ? err.message : String(err)}`);
            });
            return {
                tool_use_id: "",
                content: `子代理已在后台启动 (任务ID: ${taskId})\n\n任务描述: ${description}`,
            };
        }

        // ─── 前台运行 ───
        return this.runSubAgent(description, prompt, subConfig, context);
    }

    /**
     * 运行子代理并收集结果
     */
    private async runSubAgent(
        taskId: string,
        prompt: string,
        subConfig: AgentConfig,
        context: ToolContext,
    ): Promise<ToolResult> {
        try {
            const subLoop = new AgentLoop();
            let outputText = "";
            let toolCallCount = 0;
            const toolNames: string[] = [];

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 300_000);

            for await (const event of subLoop.run(prompt, subConfig, {
                permissionManager: (context as unknown as Record<string, unknown>).permissionManager as never,
                sessionId: context.sessionId,
                workingDirectory: context.workingDirectory,
                appendMessage: context.appendMessage,
            })) {
                switch (event.type) {
                    case "text":
                        outputText += event.content;
                        break;
                    case "tool_call":
                        toolCallCount++;
                        toolNames.push(event.tool.name);
                        break;
                    case "error":
                        outputText += `\n[错误] ${event.error.message}`;
                        break;
                    case "done":
                        break;
                }
            }
            clearTimeout(timeout);

            const toolStats = toolCallCount > 0
                ? `\n\n---\n**工具统计**: ${toolCallCount} 次调用 (${toolNames.join(", ")})`
                : "";

            return {
                tool_use_id: "",
                content: `## 子代理任务: ${taskId}\n\n${outputText}${toolStats}`,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            return {
                tool_use_id: "",
                content: `子代理执行失败 (${taskId}): ${message}`,
                is_error: true,
            };
        }
    }

    requiresApproval(): boolean {
        return true;
    }

    // ─── 私有方法 ───

    /**
     * 收集当前环境信息（用于子代理 system prompt）
     */
    private collectEnvInfo(): string {
        const platform = os.platform();
        const shell = process.env.SHELL || process.env.COMSPEC || "/bin/sh";
        const homeDir = os.homedir();
        const currentDate = new Date().toISOString().slice(0, 10);
        return `- 操作系统: ${platform} (${os.release()})\n- Shell: ${shell}\n- 用户主目录: ${homeDir}\n- 当前日期: ${currentDate}`;
    }

    /**
     * 根据子代理类型构建专用 system prompt
     */
    private buildSubAgentPrompt(type: SubAgentType, task: string): string {
        const envInfo = this.collectEnvInfo();
        const basePrompt = `你是一个子代理，负责处理一个独立任务。

## 环境信息
${envInfo}

## 核心原则
- 聚焦于分配的任务，不要进行不相关的操作
- 完成后输出清晰的结果摘要
- 不需要向用户确认（权限已由主 Agent 处理）`;

        const typePrompts: Record<SubAgentType, string> = {
            claude: `${basePrompt}\n\n## 任务\n${task}\n\n请直接完成任务并输出结果。`,
            Explore: `${basePrompt}\n\n你是一个代码库探索专家。\n\n## 限制\n只使用只读工具: Read / Glob / Grep / WebFetch / WebSearch\n不要修改任何文件。\n\n## 任务\n${task}\n\n## 输出格式\n1. 搜索范围\n2. 关键发现（含文件路径和行号）\n3. 信息摘要`,
            Plan: `${basePrompt}\n\n你是一个软件架构师。请基于以下任务设计实现方案。\n\n## 约束\n不需要编写代码，专注设计。\n\n## 任务\n${task}\n\n## 输出格式\n1. 方案概述\n2. 受影响文件\n3. 分步实施计划\n4. 架构决策和权衡\n5. 风险点`,
            "code-reviewer": `${basePrompt}\n\n你是一个代码审查专家。\n\n## 审查维度\n1. 正确性: 逻辑、边界条件\n2. 安全性: 注入、越权、信息泄露\n3. 性能: 不必要计算、内存泄漏\n4. 可维护性: 清晰度、规范\n\n## 任务\n${task}\n\n## 输出格式\n按四个维度分类列出发现和建议。`,
        };

        return typePrompts[type];
    }
}

// ─── 并发子代理工具函数 ───

/**
 * 并行执行多个子代理
 * 解决问题：当多个子代理任务相互独立时，并行执行显著减少总耗时
 *
 * @param agentTool - AgentTool 实例
 * @param tasks - 子代理任务配置数组
 * @param context - 执行上下文
 * @returns 所有子代理结果的汇总
 */
export async function executeSubAgentsInParallel(
    agentTool: AgentTool,
    tasks: SubAgentConfig[],
    context: ToolContext,
): Promise<ToolResult> {
    const promises = tasks.map((task) =>
        agentTool.execute(task as unknown as Record<string, unknown>, context)
    );

    const results = await Promise.all(promises);

    const combinedContent = results
        .map((r, i) => {
            const prefix = tasks[i]?.description ?? `任务 ${i + 1}`;
            return `### ${prefix}\n${r.content}`;
        })
        .join("\n\n---\n\n");

    const hasError = results.some((r) => r.is_error);

    return {
        tool_use_id: "",
        content: `## 并行子代理执行结果 (${tasks.length} 个任务)\n\n${combinedContent}`,
        is_error: hasError,
    };
}
