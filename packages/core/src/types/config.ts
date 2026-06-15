// ─── packages/core/src/types/config.ts ───
// 配置类型定义 — 用户/项目配置数据结构
// 解决问题: 定义从配置文件（settings.json / .y-claude/settings.json）反序列化出的数据结构，
//          覆盖 LLM Provider、权限策略、自定义快捷指令、主题、Hook、MCP 等所有可配置维度

// ─── Provider 配置 ───

/**
 * 单个 LLM Provider 配置 — 描述如何连接到某个 LLM 厂商的 API
 *
 * 解决问题:
 *   1. 支持多 Provider 并存（如同时配置 Anthropic 和 OpenAI），
 *      用户可在运行时时通过 provider 字段切换
 *   2. 支持自定义 API 端点（baseURL）用于代理、私有部署或兼容 API
 *      （如通过 OneAPI 统一接入多种模型）
 *   3. 支持每个 Provider 独立设置默认模型
 *
 * 标记: "LLM Provider 的连接配置单元"
 */
export interface ProviderConfig {
    /**
     * API 密钥 — 用于认证 LLM API 请求
     *
     * 解决问题: 不同 Provider 需要不同的 API Key，集中管理避免硬编码
     */
    apiKey: string;

    /**
     * 自定义 API 端点 — 用于代理转发或私有化部署
     *
     * 解决问题:
     *   1. 企业内网环境需要通过代理访问 LLM API
     *   2. 私有化部署的 LLM 服务（如 vLLM、LocalAI）有自定义 URL
     *   3. 通过 OneAPI 等网关统一管理多个模型时，baseURL 指向网关地址
     */
    baseURL?: string;

    /**
     * 默认模型 — 该 Provider 的默认使用模型
     *
     * 解决问题: 用户切换 Provider 时自动选取其最常用的模型，
     *          无需每次都手动指定 model 参数
     */
    defaultModel?: string;
}

// ─── 权限控制 ───

/**
 * 权限规则 — 控制哪些工具调用需要用户确认
 *
 * 解决问题:
 *   1. 安全风险管控：文件删除、git push、网络请求等操作需要在执行前征得用户同意
 *   2. 信任机制：用户可以将高频且安全的工具设为 allow，减少确认弹窗的打断
 *   3. 多层级作用域：支持 session（仅当前会话）、project（项目级）、
 *      user（用户级）、global（全局）四种优先级的作用域
 *
 * 标记: "安全权限的最小控制单元" — 一条 PermissionRule 定义对一类工具调用的处理策略
 */
export interface PermissionRule {
    /**
     * 工具名匹配模式 — 支持 glob 通配符
     *
     * 解决问题: 一条规则可匹配多个工具，如 "Bash*" 匹配所有 Bash 变体，
     *          "Bash(git push:*)" 仅匹配 git push 相关的 Bash 调用
     */
    toolPattern: string;

    /**
     * 匹配后的处理动作
     * - "allow": 自动放行，无需用户确认
     * - "deny":  自动拒绝，工具调用被阻止
     * - "ask":   弹出确认对话框，用户决定（默认行为）
     *
     * 解决问题: 三级权限粒度覆盖从"完全信任"到"完全禁止"的安全需求
     */
    action: "allow" | "deny" | "ask";

    /**
     * 规则作用域 — 决定规则的生效范围和优先级
     * - "session":  当前会话有效，会话结束后清除
     * - "project":  当前项目有效，存储在项目 .y-claude/settings.json
     * - "user":     当前用户有效，存储在用户 ~/.y-claude/settings.json
     * - "global":   全局有效
     *
     * 解决问题: 不同层级覆盖不同场景 —
     *          project 级规则适合团队共享的安全策略，
     *          user 级规则适合个人偏好，
     *          session 级规则适合临时信任
     */
    scope: "session" | "project" | "user" | "global";

    /**
     * 可选的命令匹配 — 仅对 Bash 工具有效
     *
     * 解决问题: Bash 工具可以运行任意命令，通过 commandPattern 限定匹配特定命令，
     *          如 "npm test" 可放行而 "rm -rf /" 仍需确认
     */
    commandPattern?: string;
}

// ─── 快捷指令 ───

/**
 * 自定义快捷指令 — 用户可定义正则触发的快捷操作
 *
 * 解决问题:
 *   1. 用户输入符合 pattern 的文本时自动映射为特定工具调用
 *   2. 减少重复输入：如输入 "fix" 自动转换为调用 code-fixer 工具
 *   3. 支持参数预设：Shortcut 可携带默认参数，简化工具调用
 *
 * 标记: "用户输入到工具调用的快捷映射"
 */
export interface Shortcut {
    /**
     * 正则匹配模式 — 匹配用户输入的文本
     *
     * 解决问题: 当用户输入匹配此模式时，短路正常的 LLM 推理流程，
     *          直接执行对应的工具调用
     */
    pattern: string;

    /**
     * 目标工具名 — 匹配后调用的工具名称
     *
     * 解决问题: 指定将匹配到的输入转发给哪个工具处理
     */
    action: string;

    /**
     * 工具调用参数 — 传递给目标工具的预设参数
     *
     * 解决问题: Shortcut 可携带固定参数，让工具无需再解析用户输入即可执行
     */
    params: Record<string, unknown>;
}

// ─── 用户配置 ───

/**
 * 用户全局配置结构 — 用户/项目的完整可配置项集合
 *
 * 解决问题:
 *   1. 所有用户可见的配置项收敛于此接口，避免配置散落在各处难以管理
 *   2. 支持从 settings.json 反序列化，也支持命令行参数覆盖
 *   3. 配置分层：DEFAULT_USER_CONFIG → 用户级 → 项目级，后者覆盖前者
 *
 * 标记: "配置的单一大对象" — 整个 CLI 的行为由这一个配置对象驱动
 */
export interface UserConfig {
    /** 当前使用的模型标识 — 如 "claude-sonnet-4-6" */
    model: string;

    /**
     * 当前使用的 Provider 名称 — 对应 providers 对象的 key
     *
     * 解决问题: 用户切换 LLM 厂商时只需改此字段和对应的 Provider 配置
     */
    provider: string;

    /**
     * 多 Provider 配置 — key 为 Provider 名称（如 "anthropic"、"openai"），
     * value 为该 Provider 的连接信息和默认模型
     *
     * 解决问题: 支持在多个 LLM 厂商之间切换，无需修改代码
     */
    providers: Record<string, ProviderConfig>;

    /**
     * 最大工具调用轮次 — 防止 Agent 陷入无限循环
     *
     * 解决问题: LLM 可能在修复代码时反复迭代（改→报错→再改），
     *          设置上限确保最终一定会停止并返回结果
     */
    maxToolRounds: number;

    /** 单轮 LLM 调用的最大输出 token 数 */
    maxTokensPerTurn: number;

    /**
     * 是否启用 Extended Thinking（思考模式）
     *
     * 解决问题: 复杂推理任务需要 LLM 进行深度思考，但会消耗更多 token 和时间，
     *          用户可根据任务复杂度决定是否开启
     */
    thinkingEnabled: boolean;

    /** Extended Thinking 的思考 token 预算 */
    thinkingTokens: number;

    /**
     * 是否在终端中展示思考内容（Thinking）
     *
     * 解决问题: 部分用户希望看到 AI 的推理过程来增强信任度，
     *          但默认隐藏以保持输出简洁。
     *          开启后 thinking 内容会以折叠/变暗的方式展示在终端中。
     */
    showThinking: boolean;

    /**
     * 权限配置 — 控制工具调用的安全策略
     *
     * 解决问题:
     *   - defaultMode: 当无规则匹配时的默认行为（ask=询问, allow=允许, deny=拒绝）
     *   - rules: 细粒度的权限规则列表，按顺序匹配，第一条命中生效
     */
    permissions: {
        /** 默认模式 — 无规则匹配时的回退行为 */
        defaultMode: "ask" | "allow" | "deny";
        /** 权限规则列表 — 按数组顺序匹配，先匹配先生效 */
        rules: PermissionRule[];
    };

    /**
     * UI 主题 — 控制终端的配色方案
     *
     * 解决问题: 不同用户对终端配色有不同的偏好和环境（如亮色终端需要 light 主题）
     */
    theme: "dark" | "light";

    /**
     * 自定义环境变量 — 注入到工具执行环境中的额外变量
     *
     * 解决问题:
     *   1. 传递 API Key、Token 等敏感信息给子进程
     *   2. 设置特定工具需要的环境变量（如 NODE_ENV、PYTHONPATH）
     */
    env: Record<string, string>;

    /**
     * Hook 配置 — 在 Agent 生命周期关键节点执行自定义命令
     *
     * 解决问题:
     *   1. 在 LLM 调用前后、工具执行前后、会话开始/结束时触发自定义脚本
     *   2. Hook key 为事件名（如 "PreToolUse"、"PostToolUse"），
     *      value 为匹配器和命令的数组
     *   3. 典型用途：PreToolUse 阻止危险命令、PostToolUse 记录审计日志
     */
    hooks: Record<string, Array<{ matcher: string; command: string }>>;

    /**
     * MCP 服务器配置 — Model Context Protocol 服务器定义
     *
     * 解决问题:
     *   1. MCP 允许 LLM 通过标准协议访问外部工具和数据源
     *      （如数据库查询、文件系统浏览、第三方 API）
     *   2. key 为服务器名称，value 为启动命令和参数
     *   3. Agent 启动时自动连接配置的 MCP 服务器，将其提供的工具注册到工具列表
     */
    mcpServers: Record<string, { command: string; args: string[] }>;

    /**
     * 自定义快捷指令列表 — 用户自定义的输入到工具调用的映射
     *
     * 解决问题: 高频重复操作可以通过简短命令触发，提升交互效率
     */
    shortcuts: Shortcut[];

    /**
     * 是否启用自动更新检查
     *
     * 解决问题: 用户可以选择关闭自动更新检查以减少网络请求
     */
    autoUpdateCheck: boolean;

    /**
     * 是否启用匿名遥测
     *
     * 解决问题: 用户可以选择关闭遥测数据收集以保护隐私
     */
    telemetryEnabled: boolean;
}

// ─── 默认配置 ───

/**
 * 用户配置默认值 — 在用户未提供任何配置时使用的硬编码回退值
 *
 * 解决问题:
 *   1. 首次使用（无配置文件）时需有一套可工作的默认值
 *   2. 作为配置合并的基底层（优先级最低），被用户配置和项目配置覆盖
 *   3. 定义了"开箱即用"的行为标准
 *
 * 标记: "配置系统的基底层" — 所有未显式设置的字段回退到此值
 */
export const DEFAULT_USER_CONFIG: UserConfig = {
    /** 默认模型 — Anthropic Claude Sonnet 4.6 */
    model: "claude-sonnet-4-6",

    /** 默认 Provider — Anthropic 官方 API */
    provider: "anthropic",

    /** 默认无预配置 Provider — 用户需通过配置文件或环境变量提供 API Key */
    providers: {},

    /** 默认 50 轮工具调用上限 — 足以处理大多数复杂任务 */
    maxToolRounds: 50,

    /** 默认单轮 16000 token 上限 — 平衡响应完整性与成本 */
    maxTokensPerTurn: 16000,

    /** 默认关闭思考模式 — 减少 token 消耗，用户按需开启 */
    thinkingEnabled: false,

    /** 默认 4000 token 思考预算 — 开启思考模式时的中等预算 */
    thinkingTokens: 4000,

    /** 默认不显示思考内容 — 保持输出简洁 */
    showThinking: false,

    /** 权限默认策略 — 未匹配规则时弹出确认框
     *  内置规则：Read/Glob/Grep（只读文件）、WebFetch/WebSearch（网络查询）自动允许
     *  需确认：Write/Edit（修改文件）、Bash（执行命令）、Agent（子代理）*/
    permissions: {
        defaultMode: "ask",
        rules: [
            { toolPattern: "Read", action: "allow", scope: "global" },
            { toolPattern: "Glob", action: "allow", scope: "global" },
            { toolPattern: "Grep", action: "allow", scope: "global" },
            { toolPattern: "WebFetch", action: "allow", scope: "global" },
            { toolPattern: "WebSearch", action: "allow", scope: "global" },
        ],
    },

    /** 默认暗色主题 — 大多数开发者的偏好 */
    theme: "dark",

    /** 默认无额外环境变量 */
    env: {},

    /** 默认无 Hook 配置 */
    hooks: {},

    /** 默认无 MCP 服务器 */
    mcpServers: {},

    /** 默认无自定义快捷指令 */
    shortcuts: [],

    /** 默认开启自动更新检查 */
    autoUpdateCheck: true,

    /** 默认开启匿名遥测 */
    telemetryEnabled: true,
};
