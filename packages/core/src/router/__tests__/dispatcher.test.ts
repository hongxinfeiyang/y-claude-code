// ─── packages/core/src/router/__tests__/dispatcher.test.ts ───
// RouterDispatcher 单元测试 — 验证三路分发：命令/工具/自然语言

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RouterDispatcher } from "../dispatcher";
import { ToolRegistry } from "../../tools/registry";
import { ReadTool, WriteTool, BashTool } from "../../tools/builtin/index";
import { createMockToolContext, createMockPermissionManager } from "../../../__tests__/helpers";
import type { AgentConfig, TurnEvent } from "../../types/agent";
import type { LLMProvider } from "../../types/agent";

function createMockAgentLoop() {
    return async function* (): AsyncGenerator<TurnEvent> {
        yield { type: "text", content: "LLM 响应" };
        yield { type: "done", usage: { input: 10, output: 5, cache: 0 } };
    };
}

function createMockProvider(): LLMProvider {
    return {
        name: "mock",
        chat: async function* () {},
        contextWindow: () => 200000,
        countTokens: async () => 0,
        supportsFeature: () => true,
    };
}

function createTestConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
        model: "claude-sonnet-4-6",
        provider: createMockProvider(),
        maxToolRounds: 10,
        maxTokensPerTurn: 4096,
        systemPrompt: "test prompt",
        tools: [],
        thinkingEnabled: false,
        ...overrides,
    };
}

describe("RouterDispatcher — 路径分发", () => {
    let registry: ToolRegistry;
    let dispatcher: RouterDispatcher;

    beforeEach(() => {
        registry = new ToolRegistry();
        registry.registerAll([new ReadTool(), new WriteTool()]);
        dispatcher = new RouterDispatcher(registry);
    });

    // ─── BUILTIN_COMMAND 路径 ───
    it("已注册的内置命令应返回 command 类型结果", async () => {
        // /fast 是 IntentRouter 预注册的命令，handler 需手动注册
        dispatcher.registerCommandHandler("/fast", () => "快速模式已激活");

        const result = await dispatcher.dispatch(
            "/fast",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(),
                toolContextFactory: () => createMockToolContext(),
            },
        );

        expect(result.type).toBe("command");
        if (result.type === "command") {
            expect(result.output).toBe("快速模式已激活");
        }
    });

    it("带参数的命令应正确传递参数", async () => {
        dispatcher.registerCommandHandler("/model", (args) => `切换到: ${args || "查看中"}`);

        const result = await dispatcher.dispatch(
            "/model claude-opus-4-7",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(),
                toolContextFactory: () => createMockToolContext(),
            },
        );

        expect(result.type).toBe("command");
        if (result.type === "command") {
            expect(result.output).toContain("claude-opus-4-7");
        }
    });

    it("自定义命令需先注册到 IntentRouter 再注册 handler", async () => {
        // 1. 先注册到 IntentRouter 使其能被路由识别
        dispatcher.getRouter().registerCommand("/deploy", /^\/deploy\b/);
        // 2. 再注册 handler
        dispatcher.registerCommandHandler("/deploy", (args) => `部署完成: ${args}`);

        const result = await dispatcher.dispatch(
            "/deploy production",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(),
                toolContextFactory: () => createMockToolContext(),
            },
        );

        expect(result.type).toBe("command");
        if (result.type === "command") {
            expect(result.output).toContain("production");
        }
    });

    it("BUILTIN_COMMAND 无 handler 时应回退到 agent_loop", async () => {
        // /loop 已在 IntentRouter 注册但无对应 handler
        const result = await dispatcher.dispatch(
            "/loop",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(),
                toolContextFactory: () => createMockToolContext(),
            },
        );

        expect(result.type).toBe("agent_loop");
    });

    // ─── DIRECT_TOOL 路径 ───
    it("匹配 Read 工具模式时应直接执行并返回 tool_result", async () => {
        const result = await dispatcher.dispatch(
            "读取 /tmp",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(true),
                toolContextFactory: () => createMockToolContext({ workingDirectory: "/tmp" }),
            },
        );

        // Read 工具在注册表中且不需要审批 → 直接执行
        expect(result.type).toBe("tool_result");
    });

    it("DIRECT_TOOL 匹配到工具但工具不在注册表时应回退 agent_loop", async () => {
        // "搜索 TODO" 匹配 Grep 模式，但 Grep 不在测试 registry 中
        const result = await dispatcher.dispatch(
            "搜索 TODO",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(true),
                toolContextFactory: () => createMockToolContext(),
            },
        );

        // 工具未注册 → 回退到 agent_loop
        expect(result.type).toBe("agent_loop");
    });

    it("需要审批的工具被拒绝时应返回 denied", async () => {
        // Bash 需要审批，先加入 registry
        const bashRegistry = new ToolRegistry();
        bashRegistry.registerAll([new BashTool(), new ReadTool()]);
        const bashDispatcher = new RouterDispatcher(bashRegistry);

        // "执行 echo hello" 匹配 Bash → 需要审批 → 拒绝
        const denyingPm = createMockPermissionManager(false);
        const result = await bashDispatcher.dispatch(
            "执行 echo hello",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: denyingPm,
                toolContextFactory: () => createMockToolContext(),
            },
        );

        expect(result.type).toBe("denied");
    });

    // ─── NATURAL_LANGUAGE 路径 ───
    it("自然语言输入应走 agent_loop", async () => {
        const result = await dispatcher.dispatch(
            "帮我重构这个函数",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(),
                toolContextFactory: () => createMockToolContext(),
            },
        );

        expect(result.type).toBe("agent_loop");
    });

    it("空输入应走 agent_loop", async () => {
        const result = await dispatcher.dispatch(
            "",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(),
                toolContextFactory: () => createMockToolContext(),
            },
        );

        expect(result.type).toBe("agent_loop");
    });

    // ─── agent_loop 流验证 ───
    it("agent_loop 结果应可迭代获取 TurnEvent", async () => {
        const result = await dispatcher.dispatch(
            "hello world",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(),
                toolContextFactory: () => createMockToolContext(),
            },
        );

        expect(result.type).toBe("agent_loop");
        if (result.type === "agent_loop") {
            const events: TurnEvent[] = [];
            for await (const event of result.stream) {
                events.push(event);
            }
            expect(events.length).toBe(2);
            expect(events[0].type).toBe("text");
            expect(events[1].type).toBe("done");
        }
    });
});

describe("RouterDispatcher — registerCommandHandler", () => {
    it("后注册的同名 handler 应覆盖先注册的", async () => {
        const registry = new ToolRegistry();
        const dispatcher = new RouterDispatcher(registry);

        dispatcher.registerCommandHandler("/help", () => "v1");
        dispatcher.registerCommandHandler("/help", () => "v2");

        const result = await dispatcher.dispatch(
            "/help",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(),
                toolContextFactory: () => createMockToolContext(),
            },
        );

        expect(result.type).toBe("command");
        if (result.type === "command") {
            expect(result.output).toBe("v2");
        }
    });

    it("未注册 handler 的命令应回退到 agent_loop", async () => {
        const registry = new ToolRegistry();
        const dispatcher = new RouterDispatcher(registry);

        // /init 在 IntentRouter 中注册但无 handler
        const result = await dispatcher.dispatch(
            "/init",
            createTestConfig(),
            createMockAgentLoop(),
            {
                permissionManager: createMockPermissionManager(),
                toolContextFactory: () => createMockToolContext(),
            },
        );

        expect(result.type).toBe("agent_loop");
    });
});
