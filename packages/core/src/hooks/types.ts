/**
 * hooks/types.ts — Hook 系统类型定义
 *
 * 【是什么】
 *   定义 Hook 系统所需的 TypeScript 类型：事件类型、事件载荷、Handler 签名、
 *   Hook 配置格式。被 hooks/manager.ts 引用，确保 Hook 系统的类型安全。
 *
 * 【解决什么问题】
 *   1. 类型安全：确保 Hook 事件的触发和监听在编译期就能发现不匹配
 *   2. 接口契约：明确定义 Handler 需要接收什么参数、返回什么值
 *   3. 代码补全：在编辑器中编写 Hook 注册代码时提供自动补全
 */

/**
 * HookEvent — Hook 事件类型枚举
 *
 * 事件分类（为什么这样设计）：
 *   - before:* 事件：在操作执行前触发，Handler 返回 false 可阻止操作执行
 *     （相当于"校验/拦截钩子"）
 *   - after:* 事件：在操作执行后触发，用于日志、通知等副作用
 *     （相当于"通知/回调钩子"）
 *   - on:* 事件：在生命周期节点触发
 *     （相当于"生命周期钩子"）
 *
 * 典型使用场景：
 *   - before:tool:execute — 在 AI 调用文件写入工具前做权限检查
 *   - after:tool:execute — 工具执行后记录审计日志
 *   - before:llm:call — LLM 调用前显示 typing indicator
 *   - on:session:start — 会话开始时加载项目配置
 *   - on:user:input — 用户输入时做内容审查
 */
export type HookEvent =
    | "before:tool:execute"  // 工具执行前（可阻止）
    | "after:tool:execute"   // 工具执行后（不可阻止，用于副作用）
    | "before:llm:call"      // LLM 调用前（可阻止，如限流控制）
    | "after:llm:call"       // LLM 调用后（不可阻止，用于日志/统计）
    | "on:session:start"     // 会话启动时
    | "on:session:end"       // 会话结束时
    | "on:user:input";       // 用户输入到达时

/**
 * ToolExecutePayload — 工具执行事件的载荷
 *
 * 传递工具调用的上下文信息，让 Hook Handler 能基于工具名或参数做判断。
 */
export interface ToolExecutePayload {
    /** 被调用的工具名称（如 "write_to_file", "bash"） */
    toolName: string;
    /** 传递给工具的参数对象 */
    params: Record<string, unknown>;
    /** 当前会话上下文（工作目录、当前文件等） */
    context: Record<string, unknown>;
}

/**
 * LLMCallPayload — LLM 调用事件的载荷
 *
 * 传递 LLM 调用相关信息，用于日志、限流、成本追踪等。
 */
export interface LLMCallPayload {
    /** API Provider（"anthropic" | "openai"） */
    provider: string;
    /** 模型标识符（"claude-sonnet-4-5" 等） */
    model: string;
    /** 请求中包含的消息数量 */
    messageCount: number;
    /** 预估的 token 消耗（用于成本预估和限流） */
    estimatedTokens: number;
}

/**
 * HookHandler — Hook 处理函数签名
 *
 * 返回值含义：
 *   - void / undefined：不干预操作，继续正常流程
 *   - true：显式允许操作
 *   - false：阻止操作（仅对 before:* 类事件有效，after:* 忽略）
 *
 * 为什么支持同步和异步：
 *   - 简单校验可以同步返回（性能更好）
 *   - 需要 I/O 的校验（如读文件、调 API）需要异步
 *
 * @param event — 触发的事件类型
 * @param payload — 事件载荷（类型取决于 event）
 * @returns false 阻止操作，true/void 允许继续
 */
export type HookHandler = (event: HookEvent, payload: Record<string, unknown>) => Promise<boolean | void> | boolean | void;

/**
 * HookConfig — Hook 配置文件中的条目格式
 *
 * 对应 ~/.y-claude-code/config.json 或 .y-claude/settings.json 中的 hooks 字段
 *
 * 为什么需要 matcher：
 *   - 一个 Hook 可能只想拦截特定的工具（如只拦截文件写入，不拦截文件读取）
 *   - matcher 支持 glob 通配符和精确匹配，提供灵活过滤能力
 */
export interface HookConfig {
    /** 要匹配的事件类型 */
    event: HookEvent;
    /**
     * 可选的工具名匹配模式（仅对 before/after:tool:execute 有效）
     *   - "write_*" — 匹配所有写入类工具
     *   - "bash" — 精确匹配 bash 工具
     *   - 不设置则匹配该事件的所有触发
     */
    matcher?: string;
    /** 要执行的 Shell 命令（通过环境变量 HOOK_* 接收载荷） */
    command: string;
}
