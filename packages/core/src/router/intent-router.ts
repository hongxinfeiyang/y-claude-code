// ─── packages/core/src/router/intent-router.ts ───
// 意图识别路由器（IntentRouter）
//
// 【标记是什么】
// IntentRouter 是用户输入的第一道"智能分流器"。
// 它通过正则模式匹配对用户输入进行分类，在输入到达 LLM 之前就判断：
// 用户到底是想执行一个内置命令、直接操作某个工具，还是在问一个通用问题。
//
// 【解决什么问题】
// 1. 降低延迟：内置命令（/help、/clear）和明确的工具调用（"读取 file.ts"）
//    无需经过 LLM 推理就能直接执行，省去 Token 生成时间。
// 2. 减少 Token 消耗：简单的文件读取、搜索等操作不消耗 LLM Token。
// 3. 提升确定性：规则匹配比 LLM 更可靠，避免 LLM 对简单指令产生歧义或幻觉。
// 4. 离线兜底：即使 LLM 服务不可用，核心命令和工具调用仍然可以执行。
//
// 【三类意图】
// - BUILTIN_COMMAND: 内置斜杠命令（/help、/model、/clear 等），直接执行对应的 handler
// - DIRECT_TOOL:    明确的工具调用（"读取 a.txt"→Read，"搜索 foo"→Grep），正则提取参数后直接调工具
// - NATURAL_LANGUAGE: 自然语言问题（"这段代码有什么问题？"），兜底进入 Agent Loop 由 LLM 处理

/**
 * 意图类型枚举
 *
 * 【标记是什么】
 * 三种可识别的用户意图类型，决定了后续的分发路径。
 *
 * 【解决什么问题】
 * 统一意图识别的输出语义，让 Dispatcher 可以基于类型做 switch 分发，
 * 避免使用字符串比较导致的分发错误。
 */
export enum IntentType {
    /**
     * 内置斜杠命令: /help, /model, /clear...
     *
     * 【标记是什么】
     * 以 "/" 开头且匹配已注册命令的用户输入。
     *
     * 【解决什么问题】
     * 这些命令不需要 LLM 推理，直接执行即可。例如 /help 显示帮助信息、
     * /clear 清空会话，属于基础设施级的快捷操作。
     */
    BUILTIN_COMMAND = "builtin_command",

    /**
     * 明确工具调用: "读取 X", "搜索 Y", "执行 Z"
     *
     * 【标记是什么】
     * 用户输入的语义等价于某个工具的单次调用，可以通过正则提取参数。
     *
     * 【解决什么问题】
     * 避免"读取 a.ts"这种简单操作也要走 LLM 推理→工具选择→参数填充的
     * 完整流程，直接由正则提取参数并调用工具，速度和可靠性都更高。
     */
    DIRECT_TOOL = "direct_tool",

    /**
     * 自然语言，需要 LLM 推理
     *
     * 【标记是什么】
     * 无法通过规则匹配分类的用户输入，包含复杂语义或多步骤意图。
     *
     * 【解决什么问题】
     * 这是兜底路径，确保复杂问题（如"帮我重构这个函数"）仍然能通过
     * Agent Loop + LLM 得到处理，不会因为规则不匹配而被丢弃。
     */
    NATURAL_LANGUAGE = "natural_language",
}

/**
 * 路由结果
 *
 * 【标记是什么】
 * IntentRouter.route() 的输出结构，包含意图类型及提取的参数。
 *
 * 【解决什么问题】
 * 将路由分析结果封装成一个标准化的数据结构，让 Dispatcher 无需关心
 * 路由内部细节即可获取所需的全部信息（类型、命令名、参数、工具名等）。
 * rawInput 字段始终保留原始输入，便于日志记录和错误排查。
 */
export interface RouteResult {
    /** 意图类型，决定 Dispatcher 的分发路径 */
    type: IntentType;

    /** BUILTIN_COMMAND: 匹配到的命令名，如 "/help" */
    command?: string;

    /** BUILTIN_COMMAND: 命令后的参数部分，如 "/model opus" → "opus" */
    commandArgs?: string;

    /** DIRECT_TOOL: 匹配到的工具名称，如 "Read" */
    toolName?: string;

    /** DIRECT_TOOL: 从用户输入中提取的工具参数，如 { file_path: "a.ts" } */
    toolParams?: Record<string, unknown>;

    /** 用户原始输入，未做任何加工，用于日志和调试 */
    rawInput: string;
}

/**
 * 参数提取函数类型
 *
 * 【标记是什么】
 * 接收正则匹配结果，返回工具调用所需的参数对象的函数签名。
 *
 * 【解决什么问题】
 * 不同工具的参数字段名各不相同（Read 用 file_path，Grep 用 pattern），
 * 通过注入自定义提取函数，让每种工具模式都能按照自己的语义来构造参数。
 */
type ParamExtractor = (match: RegExpMatchArray) => Record<string, unknown>;

/**
 * 意图路由器
 *
 * 【标记是什么】
 * 用户输入的第一道分流器，维护了三张表：
 * 1. commandPatterns — 内置命令名 → 匹配正则
 * 2. toolPatterns    — 工具名 → { 匹配正则, 参数提取函数 }
 * 3. aliases         — 命令别名 → 真实命令名
 *
 * 【解决什么问题】
 * 将意图识别的所有规则集中管理，支持动态注册和查询。
 * 路由优先级：内置命令 > 直接工具调用 > 自然语言（兜底）。
 * 通过构造函数预注册默认规则，外部可通过 register* 方法扩展。
 */
export class IntentRouter {
    /**
     * 内置命令注册表
     * 【标记是什么】命令名（含 / 前缀）到匹配正则的映射
     * 【解决什么问题】支持注册任意斜杠命令，Dispatcher 通过命令名查找对应的 handler 执行
     */
    private commandPatterns: Map<string, RegExp> = new Map();

    /**
     * 直接工具调用模式表
     * 【标记是什么】工具名到 { 匹配正则, 参数提取函数 } 的映射
     * 【解决什么问题】每种工具可以有多种中文/英文触发方式，提取函数负责将正则捕获组转为工具参数
     */
    private toolPatterns: Map<string, { regex: RegExp; extractParams: ParamExtractor }> = new Map();

    /**
     * 命令别名表
     * 【标记是什么】短别名（/h）到完整命令名（/help）的映射
     * 【解决什么问题】让用户可以用简写快速调用常用命令，减少输入成本
     */
    private aliases: Map<string, string> = new Map();

    constructor() {
        // 构造时自动注册内置命令和工具模式，确保开箱即用
        this.registerDefaultCommands();
        this.registerDefaultToolPatterns();
    }

    /**
     * 路由用户输入，返回意图分类结果
     *
     * 【标记是什么】
     * 核心路由方法，对用户输入进行三步匹配判断。
     *
     * 【解决什么问题】
     * 按优先级依次尝试匹配，找到第一个匹配项即返回，保证：
     * 1. 斜杠命令优先被识别，不会被工具模式误匹配
     * 2. 直接工具调用次之，减少不必要的 LLM 调用
     * 3. 全部不匹配时兜底进入自然语言，确保无输入被丢弃
     *
     * @param input — 用户原始输入字符串
     * @returns 路由结果，包含意图类型和提取参数
     */
    route(input: string): RouteResult {
        const trimmed = input.trim();

        // 空输入直接走自然语言，避免空字符串匹配出意外结果
        if (!trimmed) {
            return { type: IntentType.NATURAL_LANGUAGE, rawInput: input };
        }

        // ─── 1. 优先匹配内置命令（以 / 开头）───
        // 【解决什么问题】
        // 斜杠命令是用户最明确的意图表达，必须优先处理。
        // 如果命令已注册 → BUILTIN_COMMAND（Dispatcher 找 handler 执行）
        // 如果命令未注册 → 自然语言（让 LLM 有机会解释或建议正确命令）
        // 别名先在查找前解析，如 /h → /help，避免 aliases 表膨胀
        if (trimmed.startsWith("/")) {
            const parts = trimmed.split(/\s+/);
            let cmd = parts[0];

            // 别名解析：/h → /help, /q → /exit 等
            if (this.aliases.has(cmd)) {
                cmd = this.aliases.get(cmd)!;
            }

            if (this.commandPatterns.has(cmd)) {
                return {
                    type: IntentType.BUILTIN_COMMAND,
                    command: cmd,
                    commandArgs: parts.slice(1).join(" "),
                    rawInput: input,
                };
            }

            // 未知命令也进入自然语言，由 LLM 给出友好提示
            return { type: IntentType.NATURAL_LANGUAGE, rawInput: input };
        }

        // ─── 2. 匹配直接工具调用模式 ───
        // 【解决什么问题】
        // 遍历所有注册的工具模式，用正则匹配用户输入。
        // 匹配成功 → 直接提取参数并返回 DIRECT_TOOL 结果，
        // 让 Dispatcher 跳过 LLM，直接执行工具。
        // 顺序敏感：先注册的模式优先匹配，需注意模式间的冲突。
        for (const [toolName, { regex, extractParams }] of this.toolPatterns) {
            const match = trimmed.match(regex);
            if (match) {
                return {
                    type: IntentType.DIRECT_TOOL,
                    toolName,
                    toolParams: extractParams(match),
                    rawInput: input,
                };
            }
        }

        // ─── 3. 兜底：自然语言 → Agent Loop ───
        // 【解决什么问题】
        // 所有规则都无法匹配时的安全网，确保任何输入都不会被丢弃。
        // 复杂问题（"帮我修复这个 bug"）将进入 Agent Loop 由 LLM 进行多步推理处理。
        return { type: IntentType.NATURAL_LANGUAGE, rawInput: input };
    }

    // ─── 注册 API ───
    // 【解决什么问题】
    // 提供动态扩展能力，让外部模块（插件、自定义配置）可以注册新的命令和工具模式。

    /**
     * 注册内置命令
     * 【标记是什么】将一个命令名与其识别正相关联
     * 【解决什么问题】运行时动态添加新的斜杠命令，如插件提供的 /deploy、/lint 等
     */
    registerCommand(command: string, pattern: RegExp): void {
        this.commandPatterns.set(command, pattern);
    }

    /**
     * 注册命令别名
     * 【标记是什么】建立短名称到完整命令名的映射
     * 【解决什么问题】允许用户自定义快捷命令，如将 /review-pr 映射为 /rp
     */
    registerAlias(alias: string, target: string): void {
        this.aliases.set(alias, target);
    }

    /**
     * 注册直接工具调用模式
     * 【标记是什么】将一个工具名、匹配正则、参数提取函数三者绑定注册
     * 【解决什么问题】扩展自然语言→工具调用的直接映射，支持新的工具类型和触发方式
     */
    registerToolPattern(toolName: string, regex: RegExp, extractParams: ParamExtractor): void {
        this.toolPatterns.set(toolName, { regex, extractParams });
    }

    /**
     * 获取所有已注册命令名
     * 【标记是什么】返回所有已注册命令的列表
     * 【解决什么问题】供 /help 等命令动态生成可用命令列表，无需手动维护
     */
    getRegisteredCommands(): string[] {
        return Array.from(this.commandPatterns.keys());
    }

    // ─── 默认注册 ───
    // 【解决什么问题】
    // 提供开箱即用的命令和工具识别能力，无需额外配置即可使用核心功能。

    /**
     * 注册默认内置命令
     * 【标记是什么】注册系统预定义的斜杠命令及其匹配正则
     *
     * 【解决什么问题】
     * 确保以下核心命令在无需任何配置的情况下即可使用：
     * - /help:   查看所有可用命令
     * - /clear:  清空当前会话上下文
     * - /model:  切换或查看当前模型
     * - /config: 管理配置项
     * - /memory: 管理持久化记忆
     * - /skills: 查看可用技能
     * - /review: 代码审查
     * - /init:   初始化项目 CLAUDE.md
     * - /loop:   循环执行
     * - /fast:   快速模式切换
     * - /exit:   退出会话（同时注册 /exit、/quit、/q 三种写法）
     */
    private registerDefaultCommands(): void {
        this.registerCommand("/help", /^\/help\b/);
        this.registerCommand("/clear", /^\/clear\b/);
        this.registerCommand("/model", /^\/model\b/);
        this.registerCommand("/config", /^\/config\b/);
        this.registerCommand("/memory", /^\/memory\b/);
        this.registerCommand("/skills", /^\/skills\b/);
        this.registerCommand("/review", /^\/review\b/);
        this.registerCommand("/init", /^\/init\b/);
        this.registerCommand("/loop", /^\/loop\b/);
        this.registerCommand("/fast", /^\/fast\b/);
        // /exit 命令支持三种写法：/exit、/quit、/q，统一映射为一个命令
        this.registerCommand("/exit", /^\/(?:exit|quit|q)\b/);

        // 别名注册 — 单字符/短别名映射到完整命令名，减少用户输入成本
        this.registerAlias("/h", "/help");
        this.registerAlias("/cls", "/clear");
        this.registerAlias("/q", "/exit");
        this.registerAlias("/quit", "/exit");
    }

    /**
     * 注册默认直接工具调用模式
     * 【标记是什么】注册系统预定义的"自然语言→工具调用"的正则模式和参数提取规则
     *
     * 【解决什么问题】
     * 让用户可以用自然的中文/英文指令直接触发工具调用，无需先走 LLM：
     * - "读取 a.ts" 或 "read a.ts" → Read 工具
     * - "搜索 TODO" 或 "grep foo"  → Grep 工具
     * - "列出文件" 或 "ls"        → Glob 工具
     * - "执行 npm test" 或 "git status" → Bash 工具
     *
     * 每种模式都有对应的参数提取函数，负责将正则捕获组转换为
     * 该工具所需的标准化参数格式。
     */
    private registerDefaultToolPatterns(): void {
        // ─── Read 工具模式 ───
        // 匹配："读取 a.ts"、"查看 path/to/file"、"打开 'my file.txt'"、"read foo.js"、"show bar"、"cat x"
        // 支持中英文动词，可选的文件路径引号
        this.registerToolPattern(
            "Read",
            /^(?:读取|查看|打开|看看|读|read|show|cat)\s+["']?(.+?)["']?\s*$/i,
            (m) => {
                const filePath = m[1].trim();
                // 返回 Read 工具所需的 file_path 参数
                return { file_path: filePath.startsWith("/") ? filePath : filePath };
            },
        );

        // ─── Grep 工具模式 ───
        // 匹配："搜索 TODO"、"查找 function"、"grep pattern"、"search keyword 在 src/ 下"
        // 支持中英文动词，可选的文件路径限定
        this.registerToolPattern(
            "Grep",
            /^(?:搜索|查找|搜|grep|search|find)\s+["']?(.+?)["']?(?:\s+(?:在|in)\s+(.+))?$/i,
            (m) => {
                const pattern = m[1]?.trim() ?? "";
                const searchPath = m[2]?.trim() || ".";
                // 返回 Grep 工具所需的 pattern 和 path 参数
                return { pattern, path: searchPath };
            },
        );

        // ─── Glob 工具模式 ───
        // 匹配："列出文件"、"ls"、"dir"、"列出 src/"、"显示 *.ts"
        // 约束: 参数只允许文件路径字符，避免误匹配自然语言如"列出3种方案"
        this.registerToolPattern(
            "Glob",
            /^(?:ls|list|dir|列出(?:\s*文件)?|显示(?:\s*(?:文件|目录))?)\s*([a-zA-Z0-9_*.\/~\\-]*)\s*$/i,
            (m) => ({ pattern: m[1]?.trim() || "**/*" }),
        );

        // ─── Bash 工具模式 ───
        // 匹配："执行 npm test"、"运行 python main.py"、"git status"、"docker ps" 等
        // 以已知 CLI 工具名开头的输入自动识别为 Bash 工具调用
        // 注意：这里直接使用整个匹配字符串作为命令，Dispatcher 执行时会直接传给 shell
        this.registerToolPattern(
            "Bash",
            /^(?:执行|运行|跑|run|exec|npm|node|git|pnpm|yarn|python|python3|docker|kubectl|curl)\s+(.+)$/i,
            (m) => {
                const fullMatch = m[0].trim();
                return { command: fullMatch };
            },
        );
    }
}
