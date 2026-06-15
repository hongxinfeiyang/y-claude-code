// ─── packages/cli/src/utils/startup.ts ───
// CLI 启动器 — Config、Provider、Sandbox、Tools、Permissions、Hooks、Cron 初始化
// 从 index.ts 的 main() 函数拆分，负责构建"应用运行时上下文"

import { homedir } from "node:os";
import * as readline from "node:readline";
import {
    ConfigLoader, createProvider, ToolRegistry, SessionManager,
    SkillLoader, PermissionManager, HookManager,
    Logger, CronScheduler, ExitPlanModeTool,
    AutoUpdateManager, TelemetryManager, TmuxManager,
    buildSystemPrompt, MemoryStore,
    type AgentConfig, type LLMProvider, type ToolUse,
} from "@y-claude-code/core";
import { DockerSandboxManager } from "@y-claude-code/sandbox";
import { runDiagnostics } from "./diagnostics";
import { C, renderMarkdown } from "./renderer";

/** 清除当前行后写入文本并换行 */
function writeLine(text: string): void {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(text + "\n");
}

// ─── 命令行参数解析 ───

export function parseArgs(): Record<string, string> {
    const args: Record<string, string> = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--model" && argv[i + 1]) args.model = argv[++i];
        else if (argv[i] === "--setup") args.setup = "true";
        else if (argv[i] === "--resume" && argv[i + 1]) args.resume = argv[++i];
        else if (argv[i] === "--sessions") args.sessions = "true";
        else if (argv[i] === "--version") args.version = "true";
        else if (argv[i] === "--help") args.help = "true";
    }
    return args;
}

// ─── 启动上下文类型 ───
// 包含所有初始化好的核心对象，供 input-handler 使用

export interface StartupContext {
    config: Record<string, unknown>;
    provider: LLMProvider;
    toolRegistry: ToolRegistry;
    agentConfig: AgentConfig;
    permissionManager: PermissionManager;
    sessionManager: SessionManager;
    hookManager: HookManager;
    cronScheduler: CronScheduler;
    logger: Logger;
    telemetry: TelemetryManager;
    telemetrySid: string;
    sandbox: DockerSandboxManager;
    sandboxAvailable: boolean;
    workingDir: string;
    spinnerState: { paused: boolean };
    sessionMessageCount: number;
    sessionToolCallCount: number;
    sessionErrorCount: number;
    sessionStartTime: number;
    memoryStore: MemoryStore;
}

// ─── 配置初始化结果 ───
// 部分参数只需展示信息，不需要完整的 Agent 运行时

export async function initialize(args: Record<string, string>): Promise<{
    context?: StartupContext;
    earlyExit?: { code: number; message?: string };
}> {
    const workingDir = process.cwd();
    const logger = new Logger({ level: "info" });

    // ─── 配置加载 ───
    const configLoader = new ConfigLoader();
    const config = await configLoader.load(workingDir);
    if (args.model) config.model = args.model;

    const globalConfigPath = `${homedir()}/.y-claude-code/config.json`;
    console.log(`全局配置: ${globalConfigPath}`);

    // ─── 会话管理（信息类命令）───
    const sessionManager = new SessionManager();

    if (args.sessions) {
        console.log("历史会话:");
        for (const s of await sessionManager.list()) {
            console.log(`  [${s.id.slice(0, 8)}] ${s.createdAt} — ${s.preview}`);
        }
        return { earlyExit: { code: 0 } };
    }

    if (args.setup) {
        console.log("当前生效的配置 (来源: .y-claude/settings.local.json)：");
        console.log(JSON.stringify(config, null, 2));
        console.log("\n如需修改: 编辑以上路径对应的配置文件，或设置环境变量 ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY");
        return { earlyExit: { code: 0 } };
    }

    // ─── 配置诊断 ───
    const diagOutput = runDiagnostics(config);

    // ─── Provider ───
    let provider: LLMProvider;
    try {
        provider = createProvider(config);
    } catch (error) {
        if (!diagOutput) console.error(diagOutput);
        console.error("\n配置错误:", error instanceof Error ? error.message : error);
        console.log("\n快速修复:");
        console.log("  1. 运行 y-claude-code --setup 进入配置向导");
        console.log("  2. 或编辑 ~/.y-claude-code/config.json");
        console.log("  3. 或设置环境变量 ANTHROPIC_API_KEY / OPENAI_API_KEY");
        return { earlyExit: { code: 1 } };
    }

    if (diagOutput) console.log(diagOutput);

    // ─── Sandbox ───
    const sandbox = new DockerSandboxManager();
    const sandboxAvailable = await sandbox.isAvailable();
    if (sandboxAvailable) {
        await sandbox.warmup().catch(() => logger.warn("Docker 镜像拉取失败"));
    } else {
        logger.warn("Docker 不可用，Bash 将降级到本地执行");
    }

    // ─── Tools ───
    const toolRegistry = ToolRegistry.createDefault();
    const tools = toolRegistry.listAll();

    // ─── System Prompt ───
    const skillLoader = new SkillLoader();
    await skillLoader.loadAll(workingDir);
    const skillSection = skillLoader.buildSystemPromptSection();

    // 加载上次会话未完成的任务状态（跨会话记忆）
    const memoryStore = new MemoryStore(workingDir);
    let planningAppendix = "";
    try {
        const lastTask = await memoryStore.load("last-session-task-state", "project");
        if (lastTask?.content) {
            planningAppendix = `## 上次会话未完成任务\n${lastTask.content}\n如果上述任务未完成，请继续执行。先用 Read 了解当前代码状态，再更新 TodoWrite 反映实际进展。`;
        }
    } catch {
        // 无上次任务状态时不追加
    }

    const systemPrompt = await buildSystemPrompt({
        env: { workingDir },
        skillSection,
        appendix: planningAppendix || undefined,
    });

    // ─── Permission ───
    const permissionManager = new PermissionManager(config.permissions.defaultMode);
    permissionManager.loadRules(config.permissions.rules);

    // ─── Session ───
    sessionManager.create(workingDir, config.model);
    if (args.resume) {
        try {
            const session = await sessionManager.resume(args.resume);
            console.log(`已恢复会话: ${session.id.slice(0, 8)}`);
        } catch {
            console.error(`会话 "${args.resume}" 不存在，创建新会话`);
        }
    }

    // ─── Hooks ───
    const hookManager = new HookManager();
    const hookConfigs: Array<{ event: import("@y-claude-code/core").HookEvent; matcher: string; command: string }> = [];
    for (const [event, handlers] of Object.entries(config.hooks)) {
        for (const h of (handlers as Array<{ matcher: string; command: string }>)) {
            hookConfigs.push({
                event: event as import("@y-claude-code/core").HookEvent,
                matcher: h.matcher,
                command: h.command,
            });
        }
    }
    hookManager.registerFromConfig(hookConfigs);

    // ─── Cron ───
    const cronScheduler = new CronScheduler();
    cronScheduler.start((job: import("@y-claude-code/core").CronJob) => {
        logger.info(`Cron 任务触发: ${job.id}`, { prompt: job.prompt });
    });

    // ─── Agent 配置 ───
    const agentConfig: AgentConfig = {
        model: config.model,
        provider,
        maxToolRounds: config.maxToolRounds,
        maxTokensPerTurn: config.maxTokensPerTurn,
        systemPrompt,
        tools,
        thinkingEnabled: config.thinkingEnabled,
        thinkingTokens: config.thinkingTokens,
        planningEnforcement: "soft",
    };

    // ─── Telemetry ───
    const telemetry = new TelemetryManager({ enabled: config.telemetryEnabled !== false });
    telemetry.startFlushInterval();
    const telemetrySid = sessionManager.getCurrent()?.id ?? "default";
    telemetry.trackSessionStart(telemetrySid, {
        model: config.model,
        provider: config.provider,
    });

    return {
        context: {
            config: config as unknown as Record<string, unknown>,
            provider,
            toolRegistry,
            agentConfig,
            permissionManager,
            sessionManager,
            hookManager,
            cronScheduler,
            logger,
            telemetry,
            telemetrySid,
            sandbox,
            sandboxAvailable,
            workingDir,
            spinnerState: { paused: false },
            sessionMessageCount: 0,
            sessionToolCallCount: 0,
            sessionErrorCount: 0,
            sessionStartTime: Date.now(),
            memoryStore,
        },
    };
}

// ─── 启动信息输出 ───
// 打印版本、模型、会话、Tmux 环境等启动信息

export function printStartupInfo(config: Record<string, unknown>, sessionId: string): void {
    console.log(`${C.bold}y-claude-code${C.reset} v0.1.0`);
    console.log(`${C.dim}模型: ${config.model} | Provider: ${config.provider} | 会话: ${sessionId}${C.reset}`);

    const tmux = new TmuxManager();
    const tmuxEnv = tmux.getEnvironmentSummary();
    if (tmuxEnv.includes("v")) {
        console.log(`${C.dim}${tmuxEnv}${C.reset}`);
    }

    console.log("输入消息开始对话，输入 /help 查看命令，Ctrl+C 退出");
    console.log("多行输入: 行尾 \\\\ 续行，Ctrl+R 搜索历史\n");
}

// ─── 自动更新检查（后台异步）───

export function startAutoUpdateCheck(config: Record<string, unknown>): void {
    if (config.autoUpdateCheck === false) return;

    const updateManager = new AutoUpdateManager({
        currentVersion: "0.1.0",
        packageName: "y-claude-code",
    });
    updateManager.check().then((info) => {
        if (info?.hasUpdate) {
            console.log(`${C.yellow}${AutoUpdateManager.formatUpdateMessage(info)}${C.reset}`);
        }
    }).catch(() => { /* 更新检查失败不阻塞正常使用 */ });
}

// ─── Plan Mode 审批回调注册 ───

export function registerPlanApproval(
    askYesNo: (prompt: string) => Promise<string>,
): void {
    ExitPlanModeTool.setApprovalCallback(async (plan: string) => {
        writeLine(`${C.bold}${C.cyan}=== 实现计划 ===${C.reset}`);
        process.stdout.write(renderMarkdown(plan) + "\n");
        process.stdout.write(`${C.dim}──────────────────────────────${C.reset}\n`);
        const answer = await askYesNo(`${C.bold}是否执行此计划？${C.reset} (y/n): `);
        const approved = answer === "y" || answer === "yes";
        if (approved) {
            writeLine(`${C.green}计划已批准，开始实现...${C.reset}`);
        } else {
            writeLine(`${C.yellow}计划已拒绝，请调整方案后重新提交${C.reset}`);
        }
        return approved;
    });
}

// ─── 工具权限审批回调注册 ───

export function registerPermissionPrompt(
    permissionManager: PermissionManager,
    askYesNo: (prompt: string) => Promise<string>,
): void {
    permissionManager.setPromptCallback(async (toolUse: ToolUse) => {
        const level = permissionManager.getPermissionLevel(toolUse.name);
        const levelLabel: Record<string, string> = {
            readonly: "只读操作",
            write: "文件写入",
            exec: "命令执行",
            network: "网络请求",
            all: "调用子代理",
        };
        const desc = levelLabel[level] ?? "未知操作";

        let detail = "";
        if (toolUse.name === "Bash" && toolUse.input.command) {
            const cmd = String(toolUse.input.command);
            detail = `: ${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}`;
        } else if ((toolUse.name === "Write" || toolUse.name === "Edit") && toolUse.input.file_path) {
            detail = `: ${String(toolUse.input.file_path)}`;
        } else if (toolUse.name === "Agent" && toolUse.input.description) {
            detail = `: ${String(toolUse.input.description)}`;
        }

        writeLine(`${C.yellow}${C.bold}🔐 需要执行${desc}${detail}，是否允许？${C.reset}`);
        const answer = await askYesNo(
            `${C.dim}(y=允许 / n=拒绝 / a=本会话全允许此类操作): ${C.reset}`,
        );
        const approved = answer === "y" || answer === "yes" || answer === "a";
        if (answer === "a") {
            permissionManager.rememberWithKey(toolUse.name, "allow");
            writeLine(`${C.green}✓ 已允许（本次会话自动放行所有 ${desc}）${C.reset}`);
        } else if (approved) {
            permissionManager.remember(toolUse, "allow", "session");
            writeLine(`${C.green}✓ 已允许（后续相同操作自动放行）${C.reset}`);
        } else {
            writeLine(`${C.red}✗ 已拒绝${C.reset}`);
        }
        return approved;
    });
}
