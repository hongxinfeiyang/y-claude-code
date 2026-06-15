// ═══════════════════════════════════════════════════════════════════════════════
// packages/core/src/tools/builtin/index.ts
// 内置工具统一导出 — barrel export for all built-in tools
//
// 【解决什么问题】
// 这是工具层的 barrel export 文件。每个内置工具（Read / Write / Edit / Bash
// 等）各自在独立文件中实现，此文件将它们集中导出，供 ToolRegistry 和
// core 包的主入口 index.ts 引用。
//
// 【为什么每个工具分文件实现】
//   1. 单一职责：每个工具逻辑独立，互不耦合，便于单独测试和维护
//   2. 树摇友好：使用者可以只 import 需要的工具类，打包器可剔除未引用代码
//   3. 扩展便利：新增工具只需创建新文件 + 在此加一行 export，不影响现有代码
//
// 【工具分类】
//   文件操作类：Read / Write / Edit — 对文件系统进行 CRUD
//   搜索查询类：Glob / Grep — 按模式查找文件和内容
//   系统交互类：Bash — 执行 Shell 命令
//   网络访问类：WebFetch / WebSearch — 访问互联网信息
//   协作交互类：Agent / AskUserQuestion — 委派子任务或向用户澄清需求
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 文件操作类工具 ─────────────────────────────────────────────────────────
// 这三者构成文件 CRUD 的完整闭环：Read(读) → Edit(改) → Write(写/创建)

// ReadTool — 读取指定文件的内容
// 支持按行号范围读取，避免一次加载超大文件
export { ReadTool } from "./read";

// WriteTool — 创建新文件或覆盖现有文件
// 用于生成新文件（代码、配置、文档）或完全重写已有文件
export { WriteTool } from "./write";

// EditTool — 对文件进行精确的字符串替换
// 使用 old_string → new_string 的语义，比 Write 精确、比 Bash sed 安全
export { EditTool } from "./edit";

// ─── 搜索查询类工具 ─────────────────────────────────────────────────────────

// GlobTool — 按通配符模式匹配文件路径
// 解决"找到所有 .ts 文件"、"找到 src 下所有 test 文件"这类需求
export { GlobTool } from "./glob";

// GrepTool — 在文件内容中搜索匹配的文本或正则表达式
// 解决"哪个文件定义了 X 函数"、"哪些地方引用了 Y 模块"这类需求
export { GrepTool } from "./grep";

// ─── 系统交互类工具 ─────────────────────────────────────────────────────────

// BashTool — 执行 Shell 命令并返回 stdout/stderr
// 解决运行脚本、安装依赖、执行 git 操作等需要通过命令行完成的任务
// 注：此工具需要权限确认（安全敏感），由 PermissionManager 控制
export { BashTool } from "./bash";

// ─── 网络访问类工具 ─────────────────────────────────────────────────────────

// WebFetchTool — 抓取指定 URL 的网页内容并转为文本
// 解决"读取这个文档页面"、"查看这个 API 的返回"这类需求
export { WebFetchTool } from "./webfetch";

// WebSearchTool — 执行在线搜索并返回结果摘要
// 解决"搜索最新的 X 信息"、"查找 Y 问题的解决方案"这类需求
export { WebSearchTool } from "./websearch";

// ─── 协作交互类工具 ─────────────────────────────────────────────────────────

// AgentTool — 创建子 Agent 并将任务委派给它独立执行
// 解决复杂任务需要分治处理的场景：主 Agent 分解任务，子 Agent 各自完成
export { AgentTool, executeSubAgentsInParallel } from "./agent";

// AskUserQuestionTool — 向用户提问以澄清不明确的需求
// 解决 AI 无法自行判断时的交互需求：让 AI 主动问"你希望用哪种方案？"
export { AskUserQuestionTool } from "./ask-user";

// ─── 计划模式类工具 ─────────────────────────────────────────────────────────

// EnterPlanModeTool — 进入计划模式，限制为只读工具进行代码探索和方案设计
// ExitPlanModeTool — 退出计划模式，提交方案供用户审批
export { EnterPlanModeTool, ExitPlanModeTool, filterToolsForPlanMode } from "./plan-mode";

// ─── Worktree 隔离类工具 ─────────────────────────────────────────────────────

// EnterWorktreeTool — 创建或进入 git worktree 隔离环境
// ExitWorktreeTool — 退出 git worktree 隔离环境
export { EnterWorktreeTool, ExitWorktreeTool, isInWorktree, getWorktreePath, getOriginalDir } from "./worktree";

// ─── 任务管理类工具 ─────────────────────────────────────────────────────────

// TodoWriteTool — 创建和管理结构化任务列表
export { TodoWriteTool } from "./todo";

// ─── 定时任务类工具 ─────────────────────────────────────────────────────────

export {
    CronCreateTool,
    CronDeleteTool,
    CronListTool,
    ScheduleWakeupTool,
    setCronScheduler,
} from "./cron-tools";

// ─── 后台任务类工具 ─────────────────────────────────────────────────────────

export {
    TaskOutputTool,
    TaskStopTool,
    registerBackgroundTask,
    updateBackgroundTask,
} from "./task";

// ─── Skill 工具 ─────────────────────────────────────────────────────────────

export { SkillTool, setSkillLoader } from "./skill-tool";

// ─── Notebook 工具 ──────────────────────────────────────────────────────────

export { NotebookEditTool } from "./notebook";
