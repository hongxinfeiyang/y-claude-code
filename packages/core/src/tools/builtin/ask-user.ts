// ─── packages/core/src/tools/builtin/ask-user.ts ───
// AskUserQuestion 工具 — Agent 主动向用户发起选择题交互
// 解决问题：在 Agent 需要用户决策的场景下（方案选择、参数确认），提供结构化的选择交互

import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";

/**
 * 单个问题的选项结构
 * 解决问题：每个选项包含 label（简短标签）和 description（详细说明），
 * 用户通过 label 快速识别，通过 description 理解选项含义
 */
interface QuestionOption {
    label: string;
    description: string;
}

/**
 * 单个问题定义
 * 解决问题：
 * - question: 完整的问题描述（供 Agent 说明问题背景和上下文）
 * - header: 简短的显示标签（在 UI 中作为问题标题，最多 12 字符）
 * - options: 可选答案列表（2-4 个）
 * - multiSelect: 是否允许多选（单选/多选两模式）
 */
interface Question {
    question: string;
    header: string;
    options: QuestionOption[];
    multiSelect?: boolean;
}

/**
 * AskUserQuestionTool — 用户交互工具
 *
 * 核心设计：
 * - 采用静态回调注入模式：CLI 层的 UI 渲染和交互逻辑通过 setAnswerCallback 注入
 * - 工具本身只负责参数校验和结果格式化，UI 渲染由回调完成
 * - 这种解耦使得工具可在不同 UI 层复用（终端 CLI、VS Code 扩展、Web UI 等）
 *
 * 典型使用场景：
 * - Agent 发现了多个可选的技术方案，询问用户选择
 * - Agent 需要确认文件路径、数据库名称等参数
 * - 复杂操作前的安全确认（"你确定要删除这些文件吗？"）
 */
export class AskUserQuestionTool extends Tool {
    /** 工具名称标识 */
    name = "AskUserQuestion";

    /**
     * 工具描述
     * 解决问题：告知模型此工具用于用户决策场景，
     * 支持单选和多选，适用于技术方案选择、参数确认等
     */
    description = "向用户展示选择题并收集回答。用于需要用户决策的场景（如选择技术方案、确认参数等）。支持单选和多选。";

    /**
     * 参数 JSON Schema 定义
     * 解决问题：
     * - questions: 问题数组（1-4 个），支持同时询问多个问题
     * - 每个 question 包含 question（完整描述）、header（简短标签）、options（选项列表）、multiSelect（多选标志）
     * - 选项数限制 2-4 个：少于 2 个没有选择意义，多于 4 个增加用户认知负担
     */
    parameters = {
        type: "object" as const,
        properties: {
            questions: {
                type: "array",
                description: "要询问用户的问题列表（1-4 个问题）",
                items: {
                    type: "object",
                    properties: {
                        question: { type: "string", description: "完整的问题描述" },
                        header: { type: "string", description: "问题简短标签（最多 12 字符）" },
                        options: {
                            type: "array",
                            description: "选项列表（2-4 个）",
                            items: {
                                type: "object",
                                properties: {
                                    label: { type: "string", description: "选项标签" },
                                    description: { type: "string", description: "选项说明" },
                                },
                            },
                        },
                        multiSelect: { type: "boolean", description: "是否允许多选", default: false },
                    },
                },
            },
        },
        required: ["questions"],
    } as unknown as JSONSchema;

    /**
     * 用户回答回调（静态属性，由 CLI 层注入）
     * 解决问题：
     * - 核心模块（packages/core）不依赖任何 UI 框架
     * - CLI 层启动时调用 setAnswerCallback 注入终端渲染逻辑
     * - VS Code 扩展等不同 UI 层可以注入各自的交互实现
     * - 静态属性确保整个进程只有一份注册（单例模式变体）
     */
    private static answerCallback: ((questions: Question[]) => Promise<Record<string, string | string[]>>) | null = null;

    /**
     * CLI 层注入回答回调
     *
     * @param cb - 回调函数，接收问题列表，返回用户回答映射 { questionId: answer }
     *
     * 解决问题：解耦工具定义和 UI 实现。工具的 execute 方法
     * 通过此回调将问题传递给 UI 层，UI 层负责渲染交互界面并收集答案。
     *
     * 调用时机：在 CLI 启动初始化阶段调用一次。
     */
    static setAnswerCallback(cb: (questions: Question[]) => Promise<Record<string, string | string[]>>): void {
        AskUserQuestionTool.answerCallback = cb;
    }

    /**
     * 执行用户交互
     *
     * @param params - 包含 questions 数组的运行时数据
     * @param _context - 未使用的上下文
     * @returns ToolResult - 用户回答或错误信息
     *
     * 执行流程：
     * 1. 参数校验（问题数 1-4、每题选项数 2-4）
     * 2. 检查回调是否已注入（未注入则报错）
     * 3. 调用回调等待用户回答
     * 4. 格式化结果返回给 Agent
     */
    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        const questions = params.questions as Question[];

        // ─── 参数校验：问题数不能为空 ───
        // 解决问题：空问题列表无意义，提前拦截
        if (!questions?.length) {
            return { tool_use_id: "", content: "questions 参数不能为空", is_error: true };
        }

        // ─── 参数校验：问题数量上限 4 个 ───
        // 解决问题：过多问题会在终端中占据大量垂直空间，且用户决策负担过重
        if (questions.length > 4) {
            return { tool_use_id: "", content: "最多支持 4 个问题", is_error: true };
        }

        // ─── 参数校验：每题选项数 2-4 个 ───
        // 解决问题：
        // - 少于 2 个选项没有选择意义（不如直接输出确认）
        // - 多于 4 个选项增加 UI 复杂度和用户认知负担
        for (const q of questions) {
            if (q.options.length < 2 || q.options.length > 4) {
                return {
                    tool_use_id: "",
                    content: `问题 "${q.question}" 的选项数必须在 2-4 个之间`,
                    is_error: true,
                };
            }
        }

        // ─── 检查回调是否已注入 ───
        // 解决问题：如果 CLI 层启动时忘记调用 setAnswerCallback，
        // 这里给出明确错误提示而非静默失败或空指针异常
        if (!AskUserQuestionTool.answerCallback) {
            return {
                tool_use_id: "",
                content: "CLI 层未注册 AskUserQuestion 的回调函数",
                is_error: true,
            };
        }

        try {
            // ─── 调用 CLI 层回调，展示 UI 并收集用户回答 ───
            // 解决问题：回调是异步的（等待用户输入），Agent 在此期间挂起。
            // 回调返回的 Map 以 question 文本为 key，value 可以是 string（单选）或 string[]（多选）
            const answers = await AskUserQuestionTool.answerCallback(questions);

            // ─── 格式化回答 ───
            // 解决问题：将用户回答格式化为 Markdown 粗体列表，
            // 方便 Agent 后续引用用户的选择结果
            // - 单选：直接显示选中的 label
            // - 多选：用逗号连接所有选中的 label
            // - 未回答：显示 "(未回答)"
            const response = questions
                .map((q) => {
                    const answer = answers[q.question];
                    const answerStr = Array.isArray(answer) ? answer.join(", ") : (answer ?? "(未回答)");
                    return `**${q.header}**: ${answerStr}`;
                })
                .join("\n");

            return { tool_use_id: "", content: `用户回答:\n${response}` };
        } catch (error) {
            // ─── 用户取消或交互出错 ───
            // 解决问题：如果用户在 UI 中取消了交互（如按 Esc 关闭对话框），
            // 回调可能 reject 或抛出异常，此处捕获并转换为友好的错误信息
            const message = error instanceof Error ? error.message : "用户取消";
            return { tool_use_id: "", content: `用户交互失败: ${message}`, is_error: true };
        }
    }

    /**
     * 是否需要用户确认
     * 解决问题：此工具本身就是向用户提问的交互式工具，
     * 如果再次要求确认会形成"确认的确认"的循环，所以不需要
     */
    requiresApproval(): boolean {
        return false; // 本身就是交互式工具，不需要再次确认
    }
}
