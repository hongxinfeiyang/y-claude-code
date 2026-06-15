// ─── packages/cli/src/__tests__/slash.test.ts ───
// 斜杠命令系统测试 — 覆盖注册、别名、执行、内置命令

import { describe, it, expect, beforeEach } from "vitest";
import {
    registerCommand,
    registerAlias,
    executeCommand,
    listCommands,
    registerBuiltinCommands,
} from "../commands/slash";

describe("斜杠命令系统 — 注册", () => {
    beforeEach(() => {
        // 注意：由于命令和别名是模块级 Map，需要在每个测试中清理
        // 使用 registerCommand 覆盖注册来做隔离测试
    });

    it("registerCommand 应注册新命令", () => {
        registerCommand("/test-cmd", () => "test result", "测试命令");
        const cmds = listCommands();
        expect(cmds.some((c) => c.name === "/test-cmd")).toBe(true);
    });

    it("registerCommand 覆盖同名命令应生效", () => {
        registerCommand("/override", () => "v1", "描述1");
        registerCommand("/override", () => "v2", "描述2");
        const cmds = listCommands();
        const found = cmds.filter((c) => c.name === "/override");
        expect(found.length).toBe(1);
        expect(found[0].description).toBe("描述2");
    });

    it("registerAlias 应注册别名", async () => {
        registerCommand("/full-name", () => "full result", "完整命令名");
        registerAlias("/fn", "/full-name");

        const result = await executeCommand("/fn");
        expect(result).toBe("full result");
    });

    it("listCommands 应返回所有已注册命令", () => {
        registerCommand("/cmd-a", () => "a", "desc a");
        registerCommand("/cmd-b", () => "b", "desc b");

        const cmds = listCommands();
        expect(cmds.length).toBeGreaterThanOrEqual(2);
        expect(cmds.find((c) => c.name === "/cmd-a")?.description).toBe("desc a");
        expect(cmds.find((c) => c.name === "/cmd-b")?.description).toBe("desc b");
    });
});

describe("斜杠命令系统 — 执行", () => {
    it("executeCommand 应调用对应 handler 并返回结果", async () => {
        registerCommand("/greet", (args) => `你好 ${args}`, "问候");
        const result = await executeCommand("/greet 世界");
        expect(result).toBe("你好 世界");
    });

    it("executeCommand 在无参数时应传空字符串", async () => {
        registerCommand("/ping", (args) => args === "" ? "pong" : `got: ${args}`, "ping");
        const result = await executeCommand("/ping");
        expect(result).toBe("pong");
    });

    it("executeCommand 在命令不存在时应返回 null", async () => {
        const result = await executeCommand("/nonexistent-cmd");
        expect(result).toBeNull();
    });

    it("executeCommand 应支持异步 handler", async () => {
        registerCommand("/async-cmd", async (args) => {
            return `async: ${args}`;
        }, "异步测试");

        const result = await executeCommand("/async-cmd hello");
        expect(result).toBe("async: hello");
    });

    it("executeCommand 应先解析别名再执行", async () => {
        registerCommand("/target", () => "target executed", "目标");
        registerAlias("/t", "/target");

        const result = await executeCommand("/t extra args");
        expect(result).toBe("target executed");
    });

    it("executeCommand 应处理传入的额外参数", async () => {
        registerCommand("/echo", (args) => args, "回显");
        const result = await executeCommand("/echo arg1 arg2 arg3");
        expect(result).toBe("arg1 arg2 arg3");
    });
});

describe("内置命令", () => {
    beforeEach(() => {
        registerBuiltinCommands();
    });

    it("/help 应返回可用命令列表", async () => {
        const result = await executeCommand("/help");
        expect(result).toContain("可用命令");
        expect(result).toContain("/help");
    });

    it("/h 别名应映射到 /help", async () => {
        const result = await executeCommand("/h");
        expect(result).toContain("可用命令");
    });

    it("/exit 应返回 exit", async () => {
        const result = await executeCommand("/exit");
        expect(result).toBe("exit");
    });

    it("/q 别名应映射到 /exit", async () => {
        const result = await executeCommand("/q");
        expect(result).toBe("exit");
    });

    it("/clear 不应抛异常", async () => {
        const result = await executeCommand("/clear");
        expect(result).toBeDefined();
    });

    it("/model 应返回模型切换信息", async () => {
        const result = await executeCommand("/model gpt-5");
        expect(result).toContain("gpt-5");
    });

    it("/model 无参数时应提示", async () => {
        const result = await executeCommand("/model");
        expect(result).toContain("当前模型");
    });

    it("/config 应返回配置提示", async () => {
        const result = await executeCommand("/config get model");
        expect(result).toContain("get model");
    });

    it("/memory 应返回记忆管理提示", async () => {
        const result = await executeCommand("/memory list");
        expect(result).toContain("list");
    });

    it("/skills 应列出可用 Skill", async () => {
        const result = await executeCommand("/skills");
        expect(result).toContain("code-review");
        expect(result).toContain("test-generator");
    });

    it("/fast 应返回切换信息", async () => {
        const result = await executeCommand("/fast");
        expect(result).toContain("快速模式");
    });

    it("/compact 应返回压缩提示", async () => {
        const result = await executeCommand("/compact");
        expect(result).toContain("上下文压缩");
    });

    it("/remember 无参数时应提示用法", async () => {
        const result = await executeCommand("/remember");
        expect(result).toContain("请提供要记忆的内容");
    });

    it("/remember 有参数时应确认保存", async () => {
        const result = await executeCommand("/remember 这是一个重要的事项");
        expect(result).toContain("记忆已保存");
        expect(result).toContain("这是一个重要的事项");
    });

    it("/remember 超长内容应截断", async () => {
        const long = "A".repeat(150);
        const result = await executeCommand(`/remember ${long}`);
        expect(result).toContain("...");
    });

    it("/tasks 应返回任务列表", async () => {
        const result = await executeCommand("/tasks");
        expect(result).toBeDefined();
    });

    it("/hooks 应返回 hooks 配置信息", async () => {
        const result = await executeCommand("/hooks");
        expect(result).toBeDefined();
    });

    it("/stats 应返回会话统计", async () => {
        const result = await executeCommand("/stats");
        expect(result).toContain("会话统计");
    });

    it("/context 应返回上下文信息", async () => {
        const result = await executeCommand("/context");
        expect(result).toContain("上下文使用情况");
    });

    it("/statusline 应返回状态栏配置", async () => {
        const result = await executeCommand("/statusline");
        expect(result).toContain("状态栏配置");
    });

    it("/add-dir 无参数时应提示", async () => {
        const result = await executeCommand("/add-dir");
        expect(result).toContain("请指定要添加的目录路径");
    });

    it("/add-dir 有参数时应确认", async () => {
        const result = await executeCommand("/add-dir /path/to/dir");
        expect(result).toContain("工作目录已添加");
    });

    it("/doctor 应返回诊断信息", async () => {
        const result = await executeCommand("/doctor");
        expect(result).toContain("环境诊断");
        expect(result).toContain("Node.js");
        expect(result).toContain(process.version);
    });

    it("/pr-comments 应返回 PR 评论提示", async () => {
        const result = await executeCommand("/pr-comments");
        expect(result).toContain("GitHub CLI");
    });

    it("/review 应返回审查提示", async () => {
        const result = await executeCommand("/review");
        expect(result).toContain("审查");
    });

    it("/init 应返回初始化提示", async () => {
        const result = await executeCommand("/init");
        expect(result).toContain("CLAUDE.md");
    });

    it("/thinking 应切换 thinking 状态", async () => {
        // 设置 globalThis mock
        (globalThis as Record<string, unknown>).__app = {
            config: { showThinking: false },
        };
        const result = await executeCommand("/thinking");
        expect(result).toContain("已开启");
    });

    it("/tmux 应返回 tmux 信息", async () => {
        const result = await executeCommand("/tmux info");
        expect(result).toBeDefined();
    });
});
