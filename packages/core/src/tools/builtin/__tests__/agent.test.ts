// ─── packages/core/src/tools/builtin/__tests__/agent.test.ts ───
// AgentTool 单元测试 — 子代理 prompt 构建、环境信息、参数校验、并行执行

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentTool, executeSubAgentsInParallel } from "../agent";

// ─── 辅助：获取工具私有方法 ───
function getPrivate(tool: AgentTool) {
    return tool as unknown as {
        collectEnvInfo(): string;
        buildSubAgentPrompt(type: string, task: string): string;
    };
}

// ─── 辅助：创建带 provider 的 context ───
function mockContext(overrides: Record<string, unknown> = {}) {
    return {
        sessionId: "test-session",
        workingDirectory: "/test",
        provider: { name: "anthropic", chat: async function* () {} },
        tools: [],
        permissionManager: {},
        appendMessage: async () => {},
        ...overrides,
    };
}

describe("AgentTool — worktree 隔离 rejection", () => {
    const tool = new AgentTool();

    it("isolation='worktree' 时应返回错误", async () => {
        const result = await tool.execute(
            { description: "test", prompt: "test", isolation: "worktree" },
            mockContext() as never,
        );
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("EnterWorktree");
    });

    it("isolation='process' 应正常处理", async () => {
        const result = await tool.execute(
            { description: "test", prompt: "test", isolation: "process" },
            mockContext() as never,
        );
        // process 隔离可以正常执行（prompt 构建成功），但会因为没有 AgentLoop mock 而走到
        // provider 验证 → 应该检查 provider 存在
        expect(result.is_error).toBeFalsy();
    });
});

describe("AgentTool — 最小 provider 校验", () => {
    const tool = new AgentTool();

    it("缺少 provider 时应返回错误", async () => {
        const contextWithoutProvider = {
            sessionId: "test",
            workingDirectory: "/test",
            tools: [],
        };
        const result = await tool.execute(
            { description: "test", prompt: "test" },
            contextWithoutProvider as never,
        );
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("LLM Provider");
    });
});

describe("AgentTool — 后台模式", () => {
    const tool = new AgentTool();

    it("run_in_background=true 应返回任务 ID", async () => {
        const result = await tool.execute(
            { description: "background task", prompt: "do something", run_in_background: true },
            mockContext() as never,
        );
        expect(result.content).toContain("后台启动");
        expect(result.content).toContain("subagent-");
        expect(result.content).toContain("background task");
    });
});

describe("AgentTool — 环境信息收集", () => {
    const tool = new AgentTool();
    const priv = getPrivate(tool);

    it("应包含操作系统信息", () => {
        const info = priv.collectEnvInfo();
        expect(info).toContain("操作系统");
    });

    it("应包含 Shell 路径", () => {
        const info = priv.collectEnvInfo();
        expect(info).toContain("Shell:");
    });

    it("应包含用户主目录", () => {
        const info = priv.collectEnvInfo();
        expect(info).toContain("用户主目录");
    });

    it("应包含当前日期", () => {
        const info = priv.collectEnvInfo();
        expect(info).toContain("当前日期");
        // 日期格式应为 YYYY-MM-DD
        expect(info).toMatch(/\d{4}-\d{2}-\d{2}/);
    });
});

describe("AgentTool — buildSubAgentPrompt", () => {
    const tool = new AgentTool();
    const priv = getPrivate(tool);
    const task = "分析 auth 模块";

    it("claude 类型应包含 base prompt 和 task", () => {
        const prompt = priv.buildSubAgentPrompt("claude", task);
        expect(prompt).toContain("子代理");
        expect(prompt).toContain("环境信息");
        expect(prompt).toContain("分析 auth 模块");
        expect(prompt).toContain("直接完成任务并输出结果");
    });

    it("Explore 类型应包含只读限制", () => {
        const prompt = priv.buildSubAgentPrompt("Explore", task);
        expect(prompt).toContain("代码库探索专家");
        expect(prompt).toContain("只使用只读工具");
        expect(prompt).toContain("不要修改任何文件");
        expect(prompt).toContain("文件路径和行号");
    });

    it("Plan 类型应包含架构约束", () => {
        const prompt = priv.buildSubAgentPrompt("Plan", task);
        expect(prompt).toContain("软件架构师");
        expect(prompt).toContain("不需要编写代码");
        expect(prompt).toContain("方案概述");
        expect(prompt).toContain("架构决策和权衡");
    });

    it("code-reviewer 类型应包含四个审查维度", () => {
        const prompt = priv.buildSubAgentPrompt("code-reviewer", task);
        expect(prompt).toContain("代码审查专家");
        expect(prompt).toContain("正确性");
        expect(prompt).toContain("安全性");
        expect(prompt).toContain("性能");
        expect(prompt).toContain("可维护性");
    });

    it("所有类型都应包含环境信息", () => {
        for (const type of ["claude", "Explore", "Plan", "code-reviewer"]) {
            const prompt = priv.buildSubAgentPrompt(type, task);
            expect(prompt).toContain("操作系统");
            expect(prompt).toContain("Shell:");
            expect(prompt).toContain("用户主目录");
            expect(prompt).toContain("当前日期");
        }
    });
});

describe("AgentTool — executeSubAgentsInParallel", () => {
    let tool: AgentTool;

    beforeEach(() => {
        tool = new AgentTool();
    });

    it("并行执行应返回所有结果", async () => {
        // Mock execute 返回成功结果
        const origExecute = tool.execute.bind(tool);
        let callCount = 0;
        tool.execute = vi.fn().mockImplementation(async (_params: Record<string, unknown>, _ctx: never) => {
            callCount++;
            return {
                tool_use_id: "",
                content: `Task ${callCount} result`,
                is_error: false,
            };
        });

        const ctx = mockContext() as never;
        const result = await executeSubAgentsInParallel(tool, [
            { description: "Task A", prompt: "do A" },
            { description: "Task B", prompt: "do B" },
            { description: "Task C", prompt: "do C" },
        ], ctx);

        expect(result.content).toContain("并行子代理执行结果");
        expect(result.content).toContain("Task A");
        expect(result.content).toContain("Task B");
        expect(result.content).toContain("Task C");
        expect(result.content).toContain("---");
        expect(result.is_error).toBe(false);

        // 恢复原始方法
        tool.execute = origExecute;
    });

    it("任意子代理出错应标记 is_error=true", async () => {
        const origExecute = tool.execute.bind(tool);
        tool.execute = vi.fn().mockImplementation(async (params: Record<string, unknown>, _ctx: never) => {
            const desc = params.description as string;
            return {
                tool_use_id: "",
                content: `${desc} result`,
                is_error: desc === "Task B",
            };
        });

        const result = await executeSubAgentsInParallel(tool, [
            { description: "Task A", prompt: "do A" },
            { description: "Task B", prompt: "do B" },
        ], mockContext() as never);

        expect(result.is_error).toBe(true);

        tool.execute = origExecute;
    });
});

describe("AgentTool — 元数据", () => {
    const tool = new AgentTool();

    it("name 应为 Agent", () => {
        expect(tool.name).toBe("Agent");
    });

    it("requiresApproval 应返回 true", () => {
        expect(tool.requiresApproval()).toBe(true);
    });

    it("parameters.required 应包含 description 和 prompt", () => {
        expect(tool.parameters.required).toContain("description");
        expect(tool.parameters.required).toContain("prompt");
    });

    it("parameters 应包含 subagent_type 及其 enum", () => {
        const p = tool.parameters.properties.subagent_type;
        expect(p).toBeDefined();
        expect(p.enum).toContain("claude");
        expect(p.enum).toContain("Explore");
        expect(p.enum).toContain("Plan");
        expect(p.enum).toContain("code-reviewer");
    });

    it("parameters 应包含 run_in_background (默认 false)", () => {
        const p = tool.parameters.properties.run_in_background;
        expect(p).toBeDefined();
        expect(p.default).toBe(false);
    });

    it("parameters 应包含 max_turns (默认 20)", () => {
        const p = tool.parameters.properties.max_turns;
        expect(p).toBeDefined();
        expect(p.default).toBe(20);
    });
});
