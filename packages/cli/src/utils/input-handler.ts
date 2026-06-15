// ─── packages/cli/src/utils/input-handler.ts ───
// CLI 输入处理器 — readline 设置、SIGINT 处理、用户确认、消息路由
// 从 index.ts 拆分，负责所有终端交互输入，不包含输出渲染和启动初始化

import * as readline from "node:readline";
import {
    AgentLoop, RouterDispatcher,
    sanitizeInput, sanitizeOutput,
    TodoWriteTool, MemoryStore,
    type AgentLoopContext, type AgentConfig,
} from "@y-claude-code/core";
import { registerBuiltinCommands, executeCommand } from "../commands/slash";
import { C, SPINNER_FRAMES, StreamingMarkdownRenderer } from "./renderer";
import type { StartupContext } from "./startup";

/** 清除当前行（spinner 字符）后写入文本并换行，防止 spinner 残留造成空白区 */
function writeLine(text: string): void {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(text + "\n");
}

// ─── 交互式确认提示 ───
// 在 Agent 执行期间临时阻塞并等待用户 y/n 确认
// 注意: 不使用 rl.question() 因为 ANSI 转义码会干扰光标位置计算，
// 改为先 process.stdout.write 输出提示，再通过 raw mode 逐字符读取。

export function askYesNo(prompt: string, spinnerState: { paused: boolean }): Promise<string> {
    return new Promise((resolve) => {
        spinnerState.paused = true;
        process.stdout.write("\r  \r");
        process.stdout.write(prompt);

        const savedListeners = process.stdin.listeners("data");
        process.stdin.removeAllListeners("data");

        let input = "";
        const onData = (buf: Buffer) => {
            const s = buf.toString();
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];
                if (ch === "\r" || ch === "\n") {
                    process.stdout.write("\r\n");
                    cleanup();
                    resolve(input.trim().toLowerCase());
                    return;
                }
                if (ch === "\x7f" || ch === "\b") {
                    if (input.length > 0) {
                        input = input.slice(0, -1);
                        process.stdout.write("\b \b");
                    }
                    continue;
                }
                if (ch >= " ") {
                    process.stdout.write(ch);
                    input += ch;
                }
            }
        };

        const cleanup = () => {
            process.stdin.removeListener("data", onData);
            for (const fn of savedListeners) {
                process.stdin.on("data", fn);
            }
            spinnerState.paused = false;
        };

        // 当 stdin 为 pipe（非 TTY）时 setRawMode 不存在，跳过 raw mode
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        process.stdin.on("data", onData);
    });
}

// ─── 创建消息处理函数 ───
// 返回 processInput 闭包，捕获 ctx 中的所有初始化对象

export function createProcessInput(ctx: StartupContext): (input: string) => Promise<void> {
    const {
        config, provider, toolRegistry, agentConfig,
        permissionManager, sessionManager, logger,
        telemetry, telemetrySid, sandbox, sandboxAvailable,
        workingDir, spinnerState,
    } = ctx;

    // ─── 中断控制 ───
    let executing = false;
    let currentAbort: AbortController | null = null;

    process.on("SIGINT", () => {
        if (executing && currentAbort) {
            console.log(`\n${C.yellow}⏹ 正在中断... 再按一次 Ctrl+C 强制退出${C.reset}`);
            currentAbort.abort();
        }
    });

    return async (input: string): Promise<void> => {
        const trimmed = input.trim();
        if (!trimmed) return;

        const { sanitized, warnings, blocked } = sanitizeInput(trimmed);
        if (blocked) {
            console.log(`输入被拦截: ${warnings.join(", ")}`);
            return;
        }
        if (warnings.length > 0) {
            logger.warn("输入净化警告", warnings);
        }

        // ─── 斜杠命令 ───
        if (sanitized.startsWith("/")) {
            const cmdResult = await executeCommand(sanitized);
            if (cmdResult === "exit") {
                console.log("再见！");
                process.exit(0);
            }
            if (cmdResult) console.log(cmdResult);
            console.log("");
            return;
        }

        // ─── 非命令输入: 路由到 dispatcher ───
        const dispatcher = new RouterDispatcher(toolRegistry);
        const loop = new AgentLoop();

        executing = true;
        currentAbort = new AbortController();

        const loopCtx: AgentLoopContext = {
            permissionManager,
            sandbox: sandboxAvailable ? sandbox : undefined,
            logger,
            sessionId: sessionManager.getCurrent()?.id ?? "default",
            workingDirectory: workingDir,
            signal: currentAbort.signal,
            appendMessage: async (content: string) => {
                await sessionManager.appendMessage({ role: "assistant", content });
            },
        };

        try {
            const result = await dispatcher.dispatch(
                sanitized,
                agentConfig,
                (userInput: string, cfg: AgentConfig) => loop.run(userInput, cfg, loopCtx),
                {
                    permissionManager,
                    toolContextFactory: () => ({
                        workingDirectory: workingDir,
                        sessionId: sessionManager.getCurrent()?.id ?? "default",
                        appendMessage: async (c: string) => {
                            await sessionManager.appendMessage({ role: "assistant", content: c });
                        },
                        sandbox: sandboxAvailable ? sandbox : undefined,
                        logger,
                        signal: currentAbort!.signal,
                    }),
                },
            );

            switch (result.type) {
                case "command": {
                    if (result.output === "exit") {
                        console.log("再见！");
                        process.exit(0);
                    }
                    console.log(result.output);
                    break;
                }
                case "tool_result":
                    console.log(result.output);
                    break;
                case "agent_loop": {
                    let fullOutput = "";
                    let spinnerIdx = 0;
                    // 标记 spinner 是否已因文本输出而永久暂停
                    let textStarted = false;
                    // 流式 Markdown 渲染器 — 将 **bold** 等语法转为 ANSI 终端格式
                    const mdRenderer = new StreamingMarkdownRenderer();
                    const spinnerInterval = setInterval(() => {
                        if (spinnerState.paused || textStarted) return;
                        readline.cursorTo(process.stdout, 0);
                        process.stdout.write(
                            `${C.purple}${SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length]} ${C.reset}`,
                        );
                        spinnerIdx++;
                    }, 120);

                    for await (const event of result.stream) {
                        switch (event.type) {
                            case "text": {
                                const { sanitized: cleaned } = sanitizeOutput(event.content);
                                // 通过流式渲染器将 Markdown 语法转为 ANSI 终端格式
                                const rendered = mdRenderer.processChunk(cleaned);
                                if (rendered) {
                                    // 首次有实际内容输出时才清 spinner，防止提前清导致空白行
                                    if (!textStarted) {
                                        textStarted = true;
                                        process.stdout.write("\r");
                                    }
                                    process.stdout.write(rendered);
                                }
                                fullOutput += cleaned;
                                break;
                            }
                            case "tool_call": {
                                const toolLabel: Record<string, string> = {
                                    Read: "读取文件", Glob: "搜索文件", Grep: "搜索内容",
                                    Write: "写入文件", Edit: "编辑文件", Bash: "执行命令",
                                    WebFetch: "获取网页", WebSearch: "网络搜索",
                                    Agent: "启动子代理", AskUserQuestion: "询问用户",
                                    TodoWrite: "更新任务", ExitPlanMode: "提交计划",
                                };
                                const label = toolLabel[event.tool.name] ?? event.tool.name;

                                // 根据工具类型提取关键参数展示（仅单行，避免与 spinner 冲突产生空白区）
                                const input = event.tool.input || {};
                                const trunc = (s: string, max = 60) => s.length > max ? s.slice(0, max) + "..." : s;
                                let detail = "";
                                if (event.tool.name === "Read" && input.file_path) {
                                    detail = ` ${trunc(String(input.file_path))}`;
                                } else if ((event.tool.name === "Write" || event.tool.name === "Edit") && input.file_path) {
                                    detail = ` ${trunc(String(input.file_path))}`;
                                } else if (event.tool.name === "Bash" && input.command) {
                                    detail = ` ${trunc(String(input.command))}`;
                                } else if (event.tool.name === "Glob" && input.pattern) {
                                    detail = ` ${trunc(String(input.pattern))}`;
                                } else if (event.tool.name === "Grep" && input.pattern) {
                                    detail = ` ${trunc(String(input.pattern))}`;
                                } else if (event.tool.name === "WebFetch" && input.url) {
                                    detail = ` ${trunc(String(input.url))}`;
                                } else if (event.tool.name === "WebSearch" && input.query) {
                                    detail = ` ${trunc(String(input.query))}`;
                                } else if (event.tool.name === "Agent" && input.description) {
                                    detail = ` ${trunc(String(input.description))}`;
                                }
                                writeLine(`${C.dim}  ⚙ ${C.reset}${label}${detail} ${C.dim}执行中...${C.reset}`);
                                ctx.sessionToolCallCount++;
                                telemetry.trackToolCall(telemetrySid, event.tool.name, false);
                                break;
                            }
                            case "tool_result":
                                break;
                            case "thinking":
                                if (config.showThinking) {
                                    const lines = event.content.split("\n");
                                    for (const line of lines) {
                                        if (line.trim()) {
                                            writeLine(`${C.dim}  ${line}${C.reset}`);
                                        }
                                    }
                                }
                                telemetry.trackFeatureUse(telemetrySid, "thinking");
                                break;
                            case "plan_mode_entered":
                                writeLine(`  ${C.cyan}${event.message}${C.reset}`);
                                telemetry.trackFeatureUse(telemetrySid, "plan_mode");
                                break;
                            case "plan_mode_exited":
                                writeLine(`  ${C.green}计划模式已结束${C.reset}`);
                                break;
                            case "context_alert": {
                                const alertColors: Record<string, string> = {
                                    warning: C.yellow, critical: C.red,
                                    danger: `${C.red}${C.bold}`,
                                };
                                const color = alertColors[event.health] ?? C.yellow;
                                writeLine(`  ${color}${event.message}${C.reset}`);
                                break;
                            }
                            case "approval_request":
                                break;
                            case "error":
                                writeLine(`  ${C.red}${event.error.message}${C.reset}`);
                                ctx.sessionErrorCount++;
                                telemetry.trackError(telemetrySid, event.category ?? "unknown", false);
                                break;
                            case "done":
                                ctx.sessionMessageCount++;
                                if (event.usage) {
                                    telemetry.trackLLMCall(telemetrySid, {
                                        model: config.model as string,
                                        provider: config.provider as string,
                                        inputTokens: event.usage.inputTokens,
                                        outputTokens: event.usage.outputTokens,
                                        durationMs: 0,
                                    });
                                }
                                break;
                        }
                    }

                    clearInterval(spinnerInterval);
                    if (!textStarted) {
                        writeLine("  ");
                    }

                    // 冲刷流式渲染器缓冲区（未闭合代码块、残余半行）
                    const flushOutput = mdRenderer.flush();
                    if (flushOutput) {
                        process.stdout.write(flushOutput);
                    }

                    if (fullOutput && !fullOutput.endsWith("\n")) {
                        process.stdout.write("\n");
                    }
                    break;
                }
                case "denied":
                    console.log(`操作被拒绝: ${result.message}`);
                    break;
            }
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                console.log(`${C.yellow}⏹ 操作已中断${C.reset}`);
            } else {
                console.error("处理失败:", error instanceof Error ? error.message : error);
            }
        } finally {
            executing = false;
            currentAbort = null;
        }
    };
}

// ─── 创建并启动 readline 接口 ───
// 设置 line/close 事件、多行输入支持、返回 rl 实例

export function startReadline(
    processInput: (input: string) => Promise<void>,
    onClose: () => void,
    memoryStore?: MemoryStore,
): readline.Interface {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${C.purple}> ${C.reset}`,
        terminal: true,
        historySize: 1000,
    });

    let multilineBuffer = "";

    rl.on("line", (line: string) => {
        if (line.trimEnd().endsWith("\\")) {
            multilineBuffer += line.trimEnd().slice(0, -1) + "\n";
            rl.setPrompt(`${C.dim}... ${C.reset}`);
            rl.prompt();
            return;
        }

        const input = multilineBuffer ? multilineBuffer + line : line;
        multilineBuffer = "";

        processInput(input).then(() => {
            rl.setPrompt(`${C.purple}> ${C.reset}`);
            rl.prompt();
        }).catch((error) => {
            console.error(`${C.red}处理异常:${C.reset}`, error instanceof Error ? error.message : error);
            rl.setPrompt(`${C.purple}> ${C.reset}`);
            rl.prompt();
        });
    });

    rl.on("close", () => {
        // 会话结束：持久化未完成任务状态
        if (memoryStore) {
            try {
                const todos = TodoWriteTool.getTodos();
                if (todos.length > 0) {
                    const incomplete = todos.filter((t) => t.status !== "completed");
                    const completed = todos.filter((t) => t.status === "completed");
                    const summary = [
                        `## 上次会话任务状态 (${new Date().toISOString()})`,
                        `已完成: ${completed.length} 项`,
                        incomplete.length > 0 ? `未完成: ${incomplete.length} 项` : "",
                        ...incomplete.map((t) => `- [ ] ${t.content}`),
                        ...completed.map((t) => `- [x] ${t.content}`),
                    ].filter(Boolean).join("\n");
                    memoryStore.save({
                        name: "last-session-task-state",
                        description: "上次会话未完成的任务状态",
                        type: "project",
                        content: summary,
                        related: [],
                        updatedAt: new Date().toISOString(),
                    }, "project").catch(() => { /* 持久化失败不影响退出 */ });
                }
            } catch { /* 持久化异常不影响退出 */ }
        }
        console.log("\n会话结束");
        onClose();
    });

    // 注册内置命令
    registerBuiltinCommands();

    return rl;
}
