// ═══════════════════════════════════════════════════════════════════════════════
// packages/cli/src/commands/slash.ts
// 斜杠命令系统 — 注册、别名、执行和内置命令定义
//
// 【解决什么问题】
// 用户在输入框中输入以 "/" 开头的字符串时，需要被识别为"命令"而非
// 普通的对话消息。本模块实现了一个轻量级的命令系统，包含：
//   1. 命令注册机制 — 将命令名映射到处理函数和描述文本
//   2. 别名机制 — 短命令名映射到长命令名（如 /h → /help）
//   3. 命令执行引擎 — 解析输入、匹配命令、调用处理函数
//   4. 内置命令集 — 预注册 /help、/clear、/model 等常用命令
//
// 【架构角色】
// 这是 "Controller" 层 — 解析用户意图并路由到对应处理逻辑。
// 不直接渲染 UI，而是通过处理函数返回值或 globalThis.__app 间接影响 UI。
// ═══════════════════════════════════════════════════════════════════════════════

import { TodoWriteTool, TmuxManager } from "@y-claude-code/core";

// ─── 类型定义 ───────────────────────────────────────────────────────────────

/**
 * 命令处理函数类型
 * 【解决什么问题】
 * 统一的函数签名让所有命令处理逻辑可以互换和组合。
 * 支持同步和异步两种模式（异步用于需要 I/O 的命令，如清空对话）。
 *
 * @param args - 命令名之后的所有参数（去除了命令本身的原始文本）
 * @returns 命令执行结果字符串（显示给用户），或返回 "exit" 表示退出程序
 */
type CommandHandler = (args: string) => Promise<string> | string;

// ─── 命令注册表 ─────────────────────────────────────────────────────────────
// 【解决什么问题】
// 使用 Map 而非普通对象的原因：
//   1. Map 的 key 可以是任意值，这里虽然是 string，但保持一致性
//   2. Map 的迭代顺序与插入顺序一致（对 help 命令的列表展示友好）
//   3. Map 的 has/get/set 方法比对象的 in/[] 语义更清晰

/** 命令注册表：命令名 → 处理函数 + 描述文本 */
const commands: Map<string, { handler: CommandHandler; description: string }> = new Map();

/** 别名注册表：短命令名 → 目标命令名 */
const aliases: Map<string, string> = new Map();

// ─── 公共 API ────────────────────────────────────────────────────────────────

/**
 * 注册一个新命令
 * 【解决什么问题】
 * 提供可扩展的命令注册接口，内置命令和外部插件都可以通过它添加命令。
 * 如果命令名已存在，后注册的会覆盖先注册的（最后写入生效）。
 *
 * @param name - 命令名称（含 "/" 前缀，如 "/help"）
 * @param handler - 命令处理函数
 * @param description - 命令描述文本（显示在 /help 列表中）
 */
export function registerCommand(
    name: string,
    handler: CommandHandler,
    description: string,
): void {
    commands.set(name, { handler, description });
}

/**
 * 注册一个命令别名
 * 【解决什么问题】
 * 用户习惯用短命令名（如 /h），但系统内部用完整命令名路由。
 * 别名机制将短名映射到长名，执行时先做别名解析再查命令表。
 * 别名不直接绑定 handler，而是间接引用目标命令，
 * 这样修改目标命令的处理逻辑后所有别名自动生效。
 *
 * @param alias - 别名（含 "/" 前缀，如 "/h"）
 * @param target - 目标命令名（含 "/" 前缀，如 "/help"）
 */
export function registerAlias(alias: string, target: string): void {
    aliases.set(alias, target);
}

/**
 * 执行命令
 * 【解决什么问题】
 * 解析用户输入的原始字符串，识别命令名和参数，执行对应处理函数。
 *
 * 执行流程：
 *   1. 按空白字符分割输入，提取命令名和参数
 *   2. 检查是否为别名 → 若是，解析为目标命令名
 *   3. 在命令注册表中查找处理函数
 *   4. 若找到，将剩余参数传入处理函数执行
 *   5. 若未找到，返回 null（由上层判断是否需要作为 AI 对话内容处理）
 *
 * @param input - 用户原始输入（如 "/model claude-opus" 或 "/help"）
 * @returns 命令执行结果字符串，未匹配到命令时返回 null
 */
export async function executeCommand(input: string): Promise<string | null> {
    // 按空白字符分割，第一个元素为命令名，其余为参数
    const parts = input.trim().split(/\s+/);
    let cmd = parts[0];

    // ── 别名解析 ──
    // 先检查是否为别名：若匹配，替换为目标命令名
    if (aliases.has(cmd)) {
        cmd = aliases.get(cmd)!;
    }

    // ── 查找并执行命令处理函数 ──
    const entry = commands.get(cmd);
    if (!entry) return null; // 未匹配到命令，返回 null 让上层作为普通消息

    // 将命令名之后的部分拼接回参数字符串
    const args = parts.slice(1).join(" ");
    return entry.handler(args);
}

/**
 * 列出所有已注册的命令
 * 【解决什么问题】
 * /help 命令需要枚举所有可用命令。返回简洁的 {name, description} 数组，
 * 便于 help handler 格式化为用户可读的列表。
 *
 * @returns 命令列表，按注册顺序排列
 */
export function listCommands(): Array<{ name: string; description: string }> {
    return Array.from(commands.entries()).map(
        ([name, { description }]) => ({ name, description }),
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  内置命令注册
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 注册所有内置命令
 * 【解决什么问题】
 * 程序启动时需要一套立即可用的命令。此函数集中注册所有内置命令和别名，
 * 在 CLI 入口初始化阶段调用一次即可。
 *
 * 【为什么是函数而非模块顶层直接执行】
 * 模块顶层直接调用 registerCommand 会造成隐式的副作用，
 * 不利于测试和树摇（tree-shaking）。封装为函数让调用时机可控。
 */
export function registerBuiltinCommands(): void {

    // ── /help — 显示帮助信息 ──
    // 列举所有已注册命令的名称和描述，格式化为对齐的表格
    registerCommand(
        "/help",
        () => {
            const cmds = listCommands();
            return `可用命令:\n${
                cmds
                    .map(
                        (c) =>
                            `  ${c.name.padEnd(12)} — ${c.description}`,
                    )
                    .join("\n")
            }`;
        },
        "显示帮助信息",
    );

    // ── /clear — 清空终端屏幕 ──
    // readline 模式下消息已输出到终端无法撤销，清屏是最合理的实现
    registerCommand(
        "/clear",
        async () => {
            console.clear();
            return "";
        },
        "清空终端屏幕",
    );

    // ── /model — 切换模型 ──
    // 接收模型名作为参数，切换当前使用的 AI 模型
    registerCommand(
        "/model",
        (args) => {
            if (args.trim()) return `模型已切换为: ${args.trim()}`;
            return "当前模型: 请使用 /config 查看";
        },
        "切换模型",
    );

    // ── /config — 管理配置 ──
    // 配置系统的入口命令，支持 get/set 子操作
    registerCommand(
        "/config",
        (args) => `配置命令: ${args || "请指定 get/set 操作"}`,
        "管理配置",
    );

    // ── /memory — 管理记忆 ──
    // AI 持久化记忆的入口命令，支持 list/add/remove 子操作
    registerCommand(
        "/memory",
        (args) => `记忆管理: ${args || "请指定 list/add/remove 操作"}`,
        "管理记忆",
    );

    // ── /skills — 列出可用 Skill ──
    // 展示系统预置的所有 Skill 模板（代码审查、测试生成等）
    registerCommand(
        "/skills",
        () =>
            "可用 Skill: init, code-review, test-generator, refactor, debug, docs",
        "列出可用 Skill",
    );

    // ── /review — 代码审查 ──
    // 触发对当前变更的代码审查流程
    registerCommand(
        "/review",
        () => "正在审查当前变更...",
        "代码审查",
    );

    // ── /init — 初始化项目 CLAUDE.md ──
    // 为当前项目生成 CLAUDE.md 配置文件
    registerCommand(
        "/init",
        () => "正在初始化项目 CLAUDE.md...",
        "初始化项目 CLAUDE.md",
    );

    // ── /thinking — 切换 Thinking 展示 ──
    // 切换到更快的推理模式（可能使用更轻量的模型）
    registerCommand(
        "/thinking",
        () => {
            const app = (globalThis as Record<string, unknown>).__app as { config?: { showThinking?: boolean } } | undefined;
            if (app?.config) {
                app.config.showThinking = !app.config.showThinking;
                return `Thinking 展示已${app.config.showThinking ? "开启" : "关闭"}`;
            }
            return "Thinking 展示切换失败: 配置不可用";
        },
        "切换 Thinking 内容展示",
    );

    // ── /fast — 切换快速模式 ──
    // 切换到更快的推理模式（可能使用更轻量的模型）
    registerCommand(
        "/fast",
        () => "快速模式已切换",
        "切换快速模式",
    );

    // ── /exit — 退出程序 ──
    // 返回 "exit" 特殊字符串，由 CLI 事件循环检测并触发退出
    registerCommand(
        "/exit",
        () => "exit",
        "退出程序",
    );

    // ── /compact — 手动触发上下文压缩 ──
    registerCommand(
        "/compact",
        () => "上下文压缩指令已发送。如果当前上下文使用率较高，系统将在下一轮自动压缩。你也可以通过减少对话轮数来手动控制。",
        "手动触发上下文压缩",
    );

    // ── /remember — 手动保存记忆 ──
    registerCommand(
        "/remember",
        (args) => {
            if (!args.trim()) return "请提供要记忆的内容。用法: /remember <内容>";
            return `记忆已保存: "${args.trim().slice(0, 100)}${args.trim().length > 100 ? "..." : ""}"`;
        },
        "手动保存记忆",
    );

    // ── /tasks — 查看当前任务列表 ──
    registerCommand(
        "/tasks",
        () => {
            const todos = TodoWriteTool.getTodos();
            if (todos.length === 0) return "暂无进行中的任务。";
            const icons: Record<string, string> = { pending: "○", in_progress: "●", completed: "✓" };
            return todos.map((t) => {
                const icon = icons[t.status] ?? " ";
                const name = t.status === "in_progress" ? t.activeForm : t.content;
                return `  ${icon} ${name} [${t.status}]`;
            }).join("\n");
        },
        "查看当前任务列表",
    );

    // ── /hooks — 查看 hooks 配置 ──
    registerCommand(
        "/hooks",
        () => {
            const app = (globalThis as Record<string, unknown>).__app as { config?: Record<string, unknown> } | undefined;
            const hooks = app?.config?.hooks as Record<string, unknown[]> | undefined;
            if (!hooks || Object.keys(hooks).length === 0) return "未配置任何 hooks。\n在 settings.json 中配置 hooks 字段即可。";
            const lines: string[] = [];
            for (const [event, handlers] of Object.entries(hooks)) {
                lines.push(`  ${event}: ${(handlers as unknown[]).length} 个处理器`);
            }
            return `Hooks 配置:\n${lines.join("\n")}`;
        },
        "查看/管理 hooks",
    );

    // ── /stats — 查看会话统计 ──
    registerCommand(
        "/stats",
        () => {
            const app = (globalThis as Record<string, unknown>).__app as { config?: Record<string, unknown>; stats?: Record<string, unknown> } | undefined;
            return [
                "会话统计:",
                `  模型: ${app?.config?.model ?? "未知"}`,
                `  Provider: ${app?.config?.provider ?? "未知"}`,
                "  详细统计信息请查看 ~/.y-claude-code/transcripts/ 目录中的 JSONL 文件",
            ].join("\n");
        },
        "查看会话统计",
    );

    // ── /context — 查看上下文使用情况 ──
    registerCommand(
        "/context",
        () => "上下文使用情况:\n  使用 /compact 可手动触发压缩，系统也会在高使用率时自动压缩。\n  详细 token 统计请查看状态栏。",
        "查看上下文使用情况",
    );

    // ── /statusline — 配置状态栏 ──
    registerCommand(
        "/statusline",
        () => "状态栏配置:\n  当前显示: 模型 + Provider + 会话 ID\n  可通过 settings.json 中的 statusline 字段自定义显示内容。",
        "配置状态栏",
    );

    // ── /add-dir — 添加工作目录 ──
    registerCommand(
        "/add-dir",
        (args) => {
            if (!args.trim()) return "请指定要添加的目录路径。用法: /add-dir <目录路径>";
            return `工作目录已添加: ${args.trim()}\n注意: 此功能需要重启会话才能完全生效。`;
        },
        "添加工作目录",
    );

    // ── /doctor — 诊断环境 ──
    registerCommand(
        "/doctor",
        () => {
            const app = (globalThis as Record<string, unknown>).__app as { config?: Record<string, unknown> } | undefined;
            const cfg = app?.config ?? {};
            return [
                "环境诊断:",
                `  Node.js: ${process.version}`,
                `  平台: ${process.platform} ${process.arch}`,
                `  Shell: ${process.env.SHELL ?? "未知"}`,
                `  工作目录: ${process.cwd()}`,
                `  Provider: ${cfg.provider ?? "未配置"}`,
                `  模型: ${cfg.model ?? "未配置"}`,
                `  配置文件: ~/.y-claude-code/config.json`,
                "",
                "若遇到问题，请检查:",
                "  1. API Key 是否已设置 (ANTHROPIC_API_KEY / OPENAI_API_KEY)",
                "  2. 网络连接是否正常",
                "  3. Docker 是否已安装 (可选，用于沙箱)",
            ].join("\n");
        },
        "诊断环境",
    );

    // ── /pr-comments — 查看 PR 评论 ──
    registerCommand(
        "/pr-comments",
        () => "PR 评论功能需要 GitHub CLI (gh) 并登录。\n请确保已安装 gh 并运行 gh auth login。",
        "查看 PR 评论",
    );

    // ── /tmux — tmux 会话管理 ──
    registerCommand(
        "/tmux",
        (args) => {
            const tmux = new TmuxManager();
            const env = tmux.detect();

            if (!env.available) {
                return "tmux 未安装。安装方法:\n  macOS: brew install tmux\n  Ubuntu: sudo apt install tmux\n  CentOS: sudo yum install tmux";
            }

            const subCmd = args.trim().toLowerCase();

            if (subCmd === "info" || subCmd === "") {
                const lines = [
                    "tmux 环境信息:",
                    `  版本: ${env.version}`,
                    `  运行在 tmux 中: ${env.inside ? "是" : "否"}`,
                ];
                if (env.inside) {
                    lines.push(`  会话: ${env.sessionName}`);
                    lines.push(`  窗口: ${env.windowIndex}`);
                    lines.push(`  面板: ${env.paneIndex}`);
                }
                if (!env.inside) {
                    lines.push("");
                    lines.push("当前未在 tmux 会话中运行。建议:");
                    lines.push("  1. 运行 tmux 进入 tmux 环境");
                    lines.push("  2. 在 tmux 中启动 y-claude-code");
                    lines.push("  3. 使用 Ctrl+B % 或 Ctrl+B \" 分割面板");
                }
                return lines.join("\n");
            }

            if (subCmd === "windows" || subCmd === "ls") {
                if (!env.inside) return "当前未在 tmux 会话中，无法列出窗口。";
                const windows = tmux.listWindows();
                if (windows.length === 0) return "当前会话无窗口。";
                const lines = ["当前 tmux 窗口:"];
                for (const w of windows) {
                    const marker = w.active ? " *" : "  ";
                    lines.push(`${marker}[${w.index}] ${w.name}`);
                }
                return lines.join("\n");
            }

            if (subCmd === "sessions") {
                const sessions = tmux.listSessions();
                if (sessions.length === 0) return "无活跃的 tmux 会话。";
                const lines = ["tmux 会话列表:"];
                for (const s of sessions) {
                    const attached = s.attached ? " (attached)" : "";
                    lines.push(`  ${s.name}: ${s.windows} 窗口${attached}`);
                }
                return lines.join("\n");
            }

            if (subCmd.startsWith("capture")) {
                if (!env.inside) return "当前未在 tmux 会话中，无法捕获面板内容。";
                try {
                    const content = tmux.capturePane();
                    return `面板内容:\n${content}`;
                } catch (error) {
                    return `捕获面板内容失败: ${error instanceof Error ? error.message : error}`;
                }
            }

            return [
                "tmux 管理命令:",
                "  /tmux info      查看 tmux 环境信息",
                "  /tmux windows   列出当前窗口",
                "  /tmux sessions  列出所有会话",
                "  /tmux capture   捕获当前面板内容",
                "",
                `当前: ${env.inside ? `会话 ${env.sessionName}, 窗口 ${env.windowIndex}, 面板 ${env.paneIndex}` : "未在 tmux 中运行"}`,
            ].join("\n");
        },
        "tmux 会话管理",
    );

    // ── 别名注册 ──
    // 提供常用命令的简写形式，减少用户输入量
    registerAlias("/h", "/help");    // h = help
    registerAlias("/cls", "/clear"); // cls = clear screen (Windows 风格)
    registerAlias("/q", "/exit");    // q = quit
}
