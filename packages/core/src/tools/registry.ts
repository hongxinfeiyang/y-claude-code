// ─── packages/core/src/tools/registry.ts ───
// 工具注册中心 — 管理所有已注册工具的添加、查找、LLM 定义导出

import { Tool } from "../types/tools";
import type { LLMToolDefinition } from "../types/messages";
import {
    ReadTool, WriteTool, EditTool, BashTool,
    GlobTool, GrepTool, WebFetchTool, WebSearchTool,
    AgentTool, AskUserQuestionTool, EnterPlanModeTool,
    ExitPlanModeTool, TodoWriteTool, CronCreateTool,
    CronDeleteTool, CronListTool, ScheduleWakeupTool,
    TaskOutputTool, TaskStopTool, SkillTool, NotebookEditTool,
    EnterWorktreeTool, ExitWorktreeTool
} from "./builtin/index";

export class ToolRegistry {
    private tools: Map<string, Tool> = new Map();

    register(tool: Tool, options?: { replace?: boolean }): void {
        if (this.tools.has(tool.name)) {
            if (!options?.replace) {
                throw new Error(`工具 "${tool.name}" 已注册，不允许重复注册`);
            }
        }
        this.tools.set(tool.name, tool);
    }

    registerAll(tools: Tool[]): void {
        for (const tool of tools) {
            this.register(tool);
        }
    }

    get(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    listNames(): string[] {
        return Array.from(this.tools.keys());
    }

    listAll(): Tool[] {
        return Array.from(this.tools.values());
    }

    toLLMDefinitions(): LLMToolDefinition[] {
        return this.listAll().map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: {
                type: "object",
                properties: tool.parameters.properties as Record<string, unknown>,
                required: tool.parameters.required,
            },
        }));
    }

    /** 创建预注册全部 23 个内置工具的注册表 */
    static createDefault(): ToolRegistry {
        const registry = new ToolRegistry();
        registry.registerAll([
            // 文件操作
            new ReadTool(),
            new WriteTool(),
            new EditTool(),
            new BashTool(),
            // 搜索
            new GlobTool(),
            new GrepTool(),
            // 网络
            new WebFetchTool(),
            new WebSearchTool(),
            // 协作
            new AgentTool(),
            new AskUserQuestionTool(),
            // 计划模式
            new EnterPlanModeTool(),
            new ExitPlanModeTool(),
            // Worktree 隔离
            new EnterWorktreeTool(),
            new ExitWorktreeTool(),
            // 任务管理
            new TodoWriteTool(),
            // 定时任务
            new CronCreateTool(),
            new CronDeleteTool(),
            new CronListTool(),
            new ScheduleWakeupTool(),
            // 后台任务
            new TaskOutputTool(),
            new TaskStopTool(),
            // Skill 和 Notebook
            new SkillTool(),
            new NotebookEditTool(),
        ]);
        return registry;
    }
}
