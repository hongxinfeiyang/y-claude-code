// ─── packages/core/src/permission/manager.ts ───
// 权限管理器（PermissionManager）
//
// 【标记是什么】
// PermissionManager 是工具调用的"安全守门人"。在每次工具调用执行前，
// 它根据预设的权限规则和用户偏好决定该调用是否被允许、拒绝、或是需要弹窗确认。
//
// 【解决什么问题】
// 1. 安全防护：防止 LLM 在用户不知情的情况下执行危险操作（如 rm -rf、修改生产配置）。
// 2. 减少弹窗疲劳：通过规则匹配和 Session 缓存机制，避免用户对相同操作反复确认。
//    例如用户勾选"本次会话全允许 Read"后，后续所有 Read 调用自动放行。
// 3. 分层权限管理：支持 session（临时） → project（项目级） → user（用户级） →
//    global（全局）四层作用域，高优先级规则覆盖低优先级。
// 4. 持久化能力：项目级规则可以写入 .y-claude/settings.json，跨会话生效。
// 5. 可扩展性：通过 setPromptCallback 注入自定义 UI 确认界面，
//    保持权限逻辑与 UI 层的解耦。

import type { ToolUse } from "../types/messages";
import type { PermissionRule } from "../types/config";

/**
 * 权限决策结果
 * 解决问题: 统一 check() 和 willPromptUser() 的规则匹配逻辑，
 *          消除两处重复的排序→匹配→判断代码。
 */
interface PermissionDecision {
    action: "allow" | "deny" | "prompt";
    fromCache: boolean;
}

/**
 * 权限级别定义
 *
 * 【标记是什么】
 * 五个递增的权限敏感度级别，对应不同的操作风险等级。
 *
 * 【解决什么问题】
 * 为每种工具分配一个默认的"风险标签"，避免为每个工具单独配置权限策略。
 * 管理员可以基于级别做批量的权限决策（例如"全局禁止所有 exec 级别操作"）。
 *
 * 级别从低到高：
 * - readonly: 只读操作，无任何副作用（Read、Glob、Grep）
 * - write:    写操作，修改文件系统（Write、Edit）
 * - exec:     执行操作，运行外部命令（Bash）
 * - network:  网络操作，访问外部资源（WebFetch、WebSearch）
 * - all:      完全控制，可调用任意子 Agent（Agent 工具）
 */
export type PermissionLevel = "readonly" | "write" | "exec" | "network" | "all";

/**
 * 工具名到默认权限级别的映射表
 *
 * 【标记是什么】
 * 每个工具注册时即确定其风险等级，作为权限决策的基线。
 *
 * 【解决什么问题】
 * 新工具加入时只需在此表中声明级别，
 * 无需在 PermissionManager 的多处添加判断逻辑。
 * 级别越高，默认越倾向需要用户确认。
 */
const TOOL_PERMISSION_LEVELS: Record<string, PermissionLevel> = {
    Read: "readonly",
    Glob: "readonly",
    Grep: "readonly",
    Write: "write",
    Edit: "write",
    Bash: "exec",
    WebFetch: "network",
    WebSearch: "network",
    Agent: "all",
};

/**
 * 权限管理器
 *
 * 【标记是什么】
 * 在工具调用执行前的安全屏障，综合评估规则匹配、Session 缓存、用户确认
 * 三个维度来决定是否允许某次工具调用。
 *
 * 【解决什么问题】
 * 核心决策流程（check 方法内）：
 * 1. Session 缓存检查：本会话中用户是否已对该操作做过"全允许/全拒绝"决定
 * 2. 规则匹配（按作用域优先级）：session > project > user > global
 * 3. 规则命中 → allow/deny 直接生效，ask → 弹出用户确认
 * 4. 无规则命中 → 使用 defaultMode 策略
 *
 * 通过 remember 方法记忆用户决策，减少后续弹窗。
 * 通过 persistRules 将项目级规则持久化到 .y-claude/settings.json。
 */
export class PermissionManager {
    /**
     * 权限规则列表
     * 【标记是什么】所有已加载的权限规则，每条规则定义了工具匹配模式和操作
     * 【解决什么问题】规则按 scope 排序后逐一匹配，找到的第一条匹配规则决定权限结果
     */
    private rules: PermissionRule[] = [];

    /**
     * Session 级缓存
     * 【标记是什么】记录用户在本会话中已对特定操作做出的"全允许/全拒绝"决定
     * 【解决什么问题】
     * 避免同一会话中对相同操作反复弹窗确认。例如用户勾选"本次会话全允许 npm"后，
     * 所有 "Bash:npm" 开头的工具调用自动放行，不再弹窗。
     * 缓存的 key 由 buildCacheKey 构建，对 Bash 工具按命令基名做区分。
     */
    private sessionCache: Map<string, "allow" | "deny"> = new Map();

    /**
     * 默认处理模式
     * 【标记是什么】当所有规则都不匹配时的兜底策略
     * 【解决什么问题】
     * - "ask":   安全优先，弹窗确认（适合交互式场景）
     * - "allow": 全放行（适合自动化/信任环境）
     * - "deny":  全拒绝（适合只读/审核场景）
     */
    private defaultMode: "ask" | "allow" | "deny";

    /**
     * 权限确认回调
     * 【标记是什么】由 CLI/UI 层注入的异步确认函数
     * 【解决什么问题】
     * PermissionManager 不直接操作 UI，而是通过此回调委托给 CLI 层显示交互界面。
     * 这种设计让权限逻辑与 UI 层解耦：核心层不依赖任何终端库或前端框架，
     * 可以复用到 TUI、Web UI、VS Code 扩展等不同环境。
     */
    private promptCallback: ((toolUse: ToolUse) => Promise<boolean>) | null = null;

    /**
     * @param defaultMode — 默认权限处理模式，默认为 "ask"（安全优先）
     */
    constructor(defaultMode: "ask" | "allow" | "deny" = "ask") {
        this.defaultMode = defaultMode;
    }

    /**
     * 注入权限确认 UI 回调
     * 【标记是什么】将外部确认逻辑（弹窗、终端提示等）注入到权限管理器
     * 【解决什么问题】
     * 使得 PermissionManager 可以使用不同环境下的交互方式：
     * - CLI 环境：使用 inquirer 或 readline 弹终端提示
     * - VS Code 扩展：使用 vscode.window.showQuickPick
     * - Web UI：使用自定义 Modal 组件
     * 如果未注入回调，默认返回 false（拒绝），确保安全兜底。
     */
    setPromptCallback(callback: (toolUse: ToolUse) => Promise<boolean>): void {
        this.promptCallback = callback;
    }

    /**
     * 加载权限规则
     * 【标记是什么】批量设置权限规则列表，通常从配置文件读取
     * 【解决什么问题】
     * 支持从多个来源加载规则并合并：
     * - settings.json（项目/用户/全局级）
     * - 启动参数
     * - 动态规则注入
     * 使用展开运算符复制数组，避免外部修改影响内部状态。
     */
    loadRules(rules: PermissionRule[]): void {
        this.rules = [...rules];
    }

    /**
     * 统一权限决策 — check() 和 willPromptUser() 的共享逻辑
     *
     * 解决问题: 消除两处规则排序、pattern 匹配、缓存检查的重复代码。
     *          决策流程：缓存 → 规则匹配 → 默认策略。
     */
    private decide(toolUse: ToolUse, forceRecheck: boolean): PermissionDecision {
        // 1. Session 缓存检查
        const cacheKey = this.buildCacheKey(toolUse);
        if (!forceRecheck && this.sessionCache.has(cacheKey)) {
            return {
                action: this.sessionCache.get(cacheKey)!,
                fromCache: true,
            };
        }

        // 2. 按优先级匹配规则: session > project > user > global
        const sortedRules = [...this.rules].sort((a, b) => {
            const priority = { session: 0, project: 1, user: 2, global: 3 };
            return (priority[a.scope] ?? 4) - (priority[b.scope] ?? 4);
        });

        for (const rule of sortedRules) {
            if (this.matchesPattern(toolUse.name, rule.toolPattern)) {
                if (rule.commandPattern && toolUse.input.command) {
                    if (!this.matchesPattern(toolUse.input.command as string, rule.commandPattern)) {
                        continue;
                    }
                }
                if (rule.action === "allow") return { action: "allow", fromCache: false };
                if (rule.action === "deny") return { action: "deny", fromCache: false };
                return { action: "prompt", fromCache: false };
            }
        }

        // 3. 默认策略
        const action = this.defaultMode === "ask" ? "prompt" : this.defaultMode;
        return { action, fromCache: false };
    }

    /**
     * 检查工具调用是否需要用户允许 — PermissionManager 的核心方法
     */
    async check(toolUse: ToolUse, forceRecheck = false): Promise<boolean> {
        const decision = this.decide(toolUse, forceRecheck);
        if (decision.action === "allow") return true;
        if (decision.action === "deny") return false;
        return this.promptUser(toolUse);
    }

    /**
     * 预检：判断工具调用是否会触发用户确认弹窗（同步、非阻塞）
     */
    willPromptUser(toolUse: ToolUse): boolean {
        const decision = this.decide(toolUse, false);
        return decision.action === "prompt";
    }

    /**
     * 记忆本次决策
     * 【标记是什么】将用户的一次权限决策（允许/拒绝）记录下来，减少未来弹窗
     *
     * 【解决什么问题】
     * 用户在弹出的权限确认界面中选择了"记住此决定"时调用此方法。
     * - session 级记忆：仅当前会话有效，关闭后失效，用于临时放行
     * - project 级记忆：写入 rules 列表并标记 scope 为 project，
     *   后续可通过 persistRules 持久化到 .y-claude/settings.json
     *
     * @param toolUse   — 被决策的工具调用
     * @param decision  — 用户的决定（允许/拒绝）
     * @param persistTo — 记忆的作用域（session 或 project）
     */
    remember(toolUse: ToolUse, decision: "allow" | "deny", persistTo?: "session" | "project"): void {
        if (persistTo === "session") {
            // Session 级记忆：存入内存 Map，进程退出后失效
            this.sessionCache.set(this.buildCacheKey(toolUse), decision);
        }
        if (persistTo === "project") {
            // 项目级记忆：追加到规则列表，待 persistRules() 写入文件
            this.rules.push({
                toolPattern: toolUse.name,
                action: decision,
                scope: "project",
            });
        }
    }

    /**
     * 以指定 key 写入 session 缓存（用于"本会话全允许"等宽泛记忆）
     * 与 remember() 的区别：绕过 buildCacheKey 的细粒度逻辑，直接用传入的 key
     */
    rememberWithKey(key: string, decision: "allow" | "deny"): void {
        this.sessionCache.set(key, decision);
    }

    /**
     * 获取工具的默认权限级别
     * 【标记是什么】查询工具在 TOOL_PERMISSION_LEVELS 中声明的风险等级
     * 【解决什么问题】
     * 让外部调用者（如 UI 层）可以根据权限级别显示不同颜色的警告图标：
     * readonly → 绿色盾牌、write → 黄色三角、exec → 红色感叹号
     * 未声明的工具默认为 "all"（最高风险），确保安全兜底。
     */
    getPermissionLevel(toolName: string): PermissionLevel {
        return TOOL_PERMISSION_LEVELS[toolName] ?? "all";
    }

    /**
     * 清空 session 级缓存
     * 【标记是什么】清除当前会话中所有"全允许/全拒绝"的临时记忆
     * 【解决什么问题】
     * 在用户执行 /clear 或重新开始会话时调用，确保之前的临时权限决策不会
     * 影响新会话的安全策略。例如用户之前允许了所有 Bash 操作，
     * 清空后新会话中 Bash 操作会重新弹窗确认。
     */
    clearSessionCache(): void {
        this.sessionCache.clear();
    }

    /**
     * 持久化项目级规则到 .y-claude/settings.json
     * 【标记是什么】将 scope 为 "project" 的规则写入磁盘文件
     *
     * 【解决什么问题】
     * 项目级权限规则需要在会话之间持久保留。此方法：
     * 1. 读取现有 settings.json（如果存在）
     * 2. 将当前 rules 中 scope="project" 的规则合并到 permissions.rules 字段
     * 3. 自动创建 .y-claude 目录（如果不存在）
     * 4. 以美化格式（4 空格缩进）写入 JSON
     *
     * @param workingDirectory — 项目根目录路径
     */
    async persistRules(workingDirectory: string): Promise<void> {
        // 动态导入 Node 内置模块，避免在非 Node 环境（如浏览器）中报错
        const fs = await import("node:fs/promises");
        const path = await import("node:path");

        // 构建 settings.json 的完整路径
        const settingsPath = path.join(workingDirectory, ".y-claude", "settings.json");

        // 仅持久化项目级规则，session/user/global 规则不写入项目文件
        const projectRules = this.rules.filter((r) => r.scope === "project");

        // 读取现有配置（如果存在），避免覆盖其他字段
        let existing: Record<string, unknown> = {};
        try {
            const raw = await fs.readFile(settingsPath, "utf-8");
            existing = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            // 文件不存在是正常情况，创建新文件即可
        }

        // 合并权限规则到现有配置中，保留其他字段不受影响
        existing.permissions = {
            ...(existing.permissions as Record<string, unknown> ?? {}),
            rules: projectRules,
        };

        // 确保目录结构存在后写入文件
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, JSON.stringify(existing, null, 4), "utf-8");
    }

    // ─── 私有方法 ───

    /**
     * 构建会话缓存 key
     * 【标记是什么】为一次工具调用生成用于 Session 缓存的唯一标识符
     *
     * 【解决什么问题】
     * - 对大多数工具，缓存 key 就是工具名（如 "Read"、"Write"）
     * - 对 Bash 工具，需要更细粒度：cache key 为 "Bash:命令基名"
     *   例如 "Bash:npm"、"Bash:git"，而不是统一的 "Bash"
     *   这样用户允许了 "Bash:npm" 不会连带允许 "Bash:rm"
     *   提取命令的第一段作为基名，足够区分不同 CLI 工具的操作
     */
    private buildCacheKey(toolUse: ToolUse): string {
        if (toolUse.name === "Bash" && typeof toolUse.input.command === "string") {
            const cmdBase = this.extractBashBaseCommand(toolUse.input.command);
            return `Bash:${cmdBase}`;
        }
        // Write/Edit 按文件路径细化：确认写入 fileA 不会连带放行 fileB
        if ((toolUse.name === "Write" || toolUse.name === "Edit") && toolUse.input.file_path) {
            const normalizedPath = this.normalizeFilePath(String(toolUse.input.file_path));
            return `${toolUse.name}:${normalizedPath}`;
        }
        return toolUse.name;
    }

    /**
     * 从 Bash 命令字符串中提取基准命令
     *
     * 处理以下场景：
     *   - 简单命令: "npm test" → "npm"
     *   - sudo 提权: "sudo npm install" → "npm" (跳过 sudo)
     *   - 管道: "cat file | grep x" → "cat" (取管道第一个命令)
     *   - 命令链: "npm ci && npm test" → "npm" (取第一个命令)
     *   - 重定向: "echo hi > file" → "echo" (取重定向前的命令)
     */
    private extractBashBaseCommand(command: string): string {
        // 去除首尾空白，按 ; 或 && 或 || 拆分，取第一段
        const firstSegment = command.trim().split(/[;&|]{1,2}/)[0].trim();
        // 按管道拆分，取第一段
        const firstPipe = firstSegment.split("|")[0].trim();
        // 按重定向拆分，取第一段
        const firstRedirect = firstPipe.split(/[<>]/)[0].trim();
        // 按空白拆分取第一个词
        const words = firstRedirect.split(/\s+/);
        // 跳过 sudo / pkexec 等提权前缀
        const privEscSet = new Set(["sudo", "pkexec", "doas", "run0"]);
        let idx = 0;
        while (idx < words.length && privEscSet.has(words[idx])) {
            idx++;
        }
        // 跳过 env 前缀 (env VAR=val cmd)
        if (idx < words.length && words[idx] === "env") {
            idx++;
            // 跳过环境变量赋值 (KEY=value)
            while (idx < words.length && words[idx].includes("=")) {
                idx++;
            }
        }
        if (idx < words.length && words[idx].length > 0) {
            return words[idx];
        }
        // 回退：取第一个非空词
        return words.find((w) => w.length > 0) ?? "unknown";
    }

    /**
     * 规范化文件路径用于缓存 key
     */
    private normalizeFilePath(filePath: string): string {
        // 动态导入 path 模块，浏览器环境回退到简单规范化
        try {
            const path = require("node:path") as typeof import("node:path");
            return path.resolve(filePath);
        } catch {
            // 非 Node 环境：去除前导 ./ 和多余斜杠
            return filePath.replace(/^\.\//, "").replace(/\/+/g, "/");
        }
    }

    /**
     * 正则/glob 模式匹配
     * 【标记是什么】判断一个值是否匹配给定的模式字符串
     *
     * 【解决什么问题】
     * 规则中的 toolPattern 和 commandPattern 支持两种写法：
     * 1. 精确匹配：toolPattern = "Read" 只匹配 "Read"
     * 2. Glob 通配：toolPattern = "Bash:*" 匹配所有 Bash 子操作
     *    将 glob 的 * 转为正则的 .*，实现类似 shell 的通配效果
     * 这种设计让用户可以灵活控制权限粒度：
     * - 精确匹配：只放行特定命令（"git status"）
     * - 通配匹配：放行一类操作（"npm *" → 放行所有 npm 子命令）
     */
    private matchesPattern(value: string, pattern: string): boolean {
        if (pattern.includes("*")) {
            // glob 通配符 → 正则表达式：* → .*
            const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
            return regex.test(value);
        }
        // 精确字符串匹配
        return value === pattern;
    }

    /**
     * 弹出用户确认界面
     * 【标记是什么】通过注入的 promptCallback 委托 UI 层显示确认界面
     *
     * 【解决什么问题】
     * 1. 解耦：PermissionManager 不直接依赖任何 UI 库
     * 2. 安全兜底：如果 UI 层忘了注入回调（promptCallback 为 null），
     *    默认返回 false（拒绝），宁可误拒也不错放
     * 3. 异步支持：promptCallback 返回 Promise<boolean>，
     *    兼容所有需要异步等待用户输入的 UI 方案
     */
    private async promptUser(toolUse: ToolUse): Promise<boolean> {
        if (this.promptCallback) {
            return this.promptCallback(toolUse);
        }
        // CLI 层未注入回调时的默认行为：拒绝执行
        // 这是一种"安全失败"策略，确保在配置不完整的情况下不会出现权限漏洞
        return false;
    }
}
