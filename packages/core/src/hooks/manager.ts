/**
 * hooks/manager.ts — Hook 管理器
 *
 * 【是什么】
 *   在 AI 编程助手的关键生命周期节点（工具执行前后、LLM 调用前后、会话启停、
 *   用户输入）触发注册的 Hook 处理器。Hook 可以是代码函数（通过 on() 注册）
 *   或 Shell 命令（通过 registerFromConfig() 注册）。
 *
 * 【解决什么问题】
 *   1. 可扩展性：用户/项目可以在不修改核心代码的前提下，在关键节点注入自定义
 *      逻辑。例如：在文件写入前做 ESLint 检查、LLM 调用后做成本统计。
 *   2. 安全拦截：before:* 类 Hook 返回 false 可以阻止操作执行。
 *      例如：阻止 AI 修改 .env 文件、阻止调用危险 shell 命令。
 *   3. 审计日志：after:* 类 Hook 用于记录操作历史和性能指标。
 *   4. Shell 集成：非 JS 用户可以通过 Shell 命令注册 Hook，
 *      载荷通过环境变量传递，降低使用门槛。
 *   5. 模式匹配过滤：通过 matcher（glob 匹配）让 Hook 只拦截特定工具，
 *      而非所有同类事件。
 */

import type { HookEvent, HookHandler, HookConfig } from "./types";

/**
 * HookManager — Hook 事件管理器
 *
 * 核心设计：
 *   - 事件驱动模型：每种 HookEvent 可注册多个 Handler
 *   - Handler 按注册顺序依次执行
 *   - 任一 Handler 返回 false 即阻止操作（短路语义，类似中间件）
 *   - Handler 异常不阻塞主流程（Hook 失败不应导致核心功能不可用）
 */
export class HookManager {
    /**
     * 事件 → 处理器列表的映射
     *
     * 为什么每个处理器带 matcher：
     *   - 同一个事件可能对应多种工具（如 before:tool:execute 对应 write/read/bash 等）
     *   - matcher 允许精确控制哪些工具触发哪些处理器
     */
    private handlers: Map<HookEvent, Array<{ matcher?: string; handler: HookHandler }>> = new Map();

    /**
     * 注册 Hook 处理器
     *
     * 注册时机：
     *   - 应用初始化时注册内置 Handler
     *   - 加载配置文件时通过 registerFromConfig() 批量注册 Shell Hook
     *   - 运行时通过插件系统动态注册
     *
     * @param event — 要监听的事件类型
     * @param handler — 处理函数
     * @param matcher — 可选的工具名匹配模式（glob），仅对 tool:execute 事件有意义
     */
    on(event: HookEvent, handler: HookHandler, matcher?: string): void {
        const list = this.handlers.get(event) ?? [];
        list.push({ matcher, handler });
        this.handlers.set(event, list);
    }

    /**
     * 触发 Hook 事件
     *
     * 执行流程：
     *   1. 查找该事件的所有注册 Handler
     *   2. 无 Handler → 直接返回 true（默认允许）
     *   3. 有 Handler → 遍历执行：
     *      a. 先检查 matcher 过滤（不匹配则跳过）
     *      b. 执行 handler，捕获异常不中断
     *      c. 任一 handler 返回 false → 立即返回 false（阻止操作）
     *   4. 全部通过 → 返回 true
     *
     * 为什么 matcher 只用 toolName 做匹配：
     *   - tool 是当前最主要需要拦截的操作
     *   - 其他事件（LLM 调用、会话）通常都需要全量通知，不需要过滤
     *
     * 为什么 Handler 异常不阻塞：
     *   - Hook 是"附加"逻辑，核心功能不应因 Hook 故障而不可用
     *   - 异常信息输出到 stderr，方便开发者调试
     *
     * @param event — 触发的事件类型
     * @param payload — 事件载荷（传递给 Handler 的上下文数据）
     * @returns true 表示允许操作继续，false 表示被 Hook 阻止
     */
    async trigger(event: HookEvent, payload: Record<string, unknown> = {}): Promise<boolean> {
        const list = this.handlers.get(event);
        if (!list?.length) return true; // 无 Handler，默认允许

        for (const { matcher, handler } of list) {
            // ─── 匹配器过滤：仅对工具执行事件生效 ───
            // matcher 存在 + 当前事件是 before/after:tool:* → 检查工具名是否匹配
            if (matcher && (event.startsWith("before:tool:") || event.startsWith("after:tool:"))) {
                const toolName: string = (payload.toolName as string | undefined) ?? '';
                if (toolName && !this.matchPattern(toolName, matcher)) continue;
            }

            try {
                const result = await handler(event, payload);
                // Handler 显式返回 false → 阻止操作，短路退出
                if (result === false) return false;
            } catch (error) {
                // Hook 执行异常不阻塞主流程，输出错误日志
                console.error(`Hook [${event}] 执行失败:`, error instanceof Error ? error.message : error);
            }
        }

        return true; // 所有 Handler 通过，操作继续
    }

    /**
     * 从配置文件批量注册 Shell 命令类型的 Hook
     *
     * Shell Hook 工作原理：
     *   1. 将 payload 的每个字段转为 HOOK_<KEY>=<VALUE> 环境变量
     *   2. 执行配置的 command
     *   3. 如果命令以 0 退出 → 允许操作；非 0 退出 → 阻止操作
     *
     * 为什么用环境变量而不是 stdin：
     *   - Shell 读取环境变量比从 stdin 解析 JSON 更简单
     *   - 用户可以直接在脚本中使用 $HOOK_TOOLNAME 等变量
     *
     * 为什么用动态 import 加载 child_process：
     *   - 在某些受限环境（如浏览器）中 child_process 不可用
     *   - 动态 import 避免模块初始化时崩溃
     *
     * @param hooks — Hook 配置数组（来自 settings.json）
     */
    registerFromConfig(hooks: HookConfig[]): void {
        for (const hook of hooks) {
            // 为每个配置创建一个匿名 Handler，内部执行 Shell 命令
            this.on(hook.event, async (_event, payload) => {
                // 将 payload 转为环境变量格式
                // 例：{ toolName: "bash" } → HOOK_TOOLNAME="bash"
                const env = Object.entries(payload)
                    .map(([k, v]) => `HOOK_${k.toUpperCase()}=${JSON.stringify(v)}`)
                    .join(" ");
                const cmd = `${env} ${hook.command}`;

                try {
                    // 动态导入 child_process（支持非 Node 环境优雅降级）
                    const { exec } = await import("node:child_process");
                    return new Promise<boolean>((resolve) => {
                        // 30 秒超时：避免 Hook 脚本挂起导致整个流程卡死
                        exec(cmd, { timeout: 30_000 }, (error) => {
                            resolve(!error); // 命令退出码 0 → 允许，非 0 → 阻止
                        });
                    });
                } catch {
                    // child_process 不可用时（如浏览器环境），不阻塞
                    return true;
                }
            }, hook.matcher);
        }
    }

    /**
     * 移除指定事件的所有 Handler
     *
     * 使用场景：
     *   - 插件卸载时清理注册的 Handler
     *   - 运行时重新加载配置前清除旧 Hook
     *
     * @param event — 要清除的事件类型
     */
    off(event: HookEvent): void {
        this.handlers.delete(event);
    }

    /**
     * 清空所有 Hook
     *
     * 使用场景：
     *   - 应用重置/重新初始化
     *   - 切换项目时清除上一个项目的 Hook 配置
     */
    clear(): void {
        this.handlers.clear();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 私有方法
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Glob 模式匹配
     *
     * 支持两种匹配模式：
     *   - 精确匹配：pattern 无通配符，value === pattern
     *   - Glob 通配符：pattern 含 *，* 匹配任意字符序列
     *     例：write_* 匹配 write_file、write_to_file 等
     *
     * 为什么不使用完整的 glob 库：
     *   - 匹配需求简单，只需 * 通配符
     *   - 避免引入 micromatch 等额外依赖
     *
     * @param value — 实际值（如工具名 "write_to_file"）
     * @param pattern — 匹配模式（如 "write_*"）
     * @returns 是否匹配
     */
    private matchPattern(value: string, pattern: string): boolean {
        if (pattern.includes("*")) {
            // 将 glob 模式转为正则：* → .*，加 ^$ 边界
            const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
            return regex.test(value);
        }
        // 无通配符时做精确字符串比较
        return value === pattern;
    }
}
