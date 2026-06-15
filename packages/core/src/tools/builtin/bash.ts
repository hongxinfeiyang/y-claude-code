// ─── packages/core/src/tools/builtin/bash.ts ───
// Bash 工具 — 优先通过 Docker 沙箱执行，不可用时降级到本地 child_process
// 解决问题：为 Agent 提供受控的 Shell 命令执行能力，多层安全防护 + 优雅降级

import { exec } from "node:child_process";
import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";
import { randomUUID } from "node:crypto";

/**
 * 最大输出长度限制 (10,000 字符)
 * 解决问题：防止超长命令输出撑爆 Agent 上下文窗口，超出部分自动截断
 */
const MAX_OUTPUT_LENGTH = 10_000;

/**
 * 默认超时时间 (120,000ms = 2 分钟)
 * 解决问题：防止失控命令无限挂起占用资源
 */
const DEFAULT_TIMEOUT = 120_000;

/**
 * 最大超时时间 (600,000ms = 10 分钟)
 * 解决问题：设定硬上限防止 timeout 参数被设为极端值导致资源浪费
 */
const MAX_TIMEOUT = 600_000;

/**
 * ANSI 转义序列正则
 * 解决问题：终端输出中常见的颜色码、光标控制码等 ASCII 控制序列，
 * 对于 LLM 来说是纯噪音，需要过滤掉
 */
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * BashTool — 安全的 Shell 命令执行工具
 *
 * 核心架构：
 * 1. 三层安全防护：
 *    - 第一层：危险模式正则检测（rm -rf /、fork bomb、远程脚本执行等）
 *    - 第二层：沙箱隔离（Docker 容器，生产环境首选）
 *    - 第三层：本地降级执行（开发展模式，受限的 exec）
 * 2. 执行模式：
 *    - 前台执行：等待完成，返回 stdout/stderr
 *    - 后台执行：fire-and-forget，不等待结果
 * 3. 超时控制：默认 2 分钟，最多 10 分钟
 */
export class BashTool extends Tool {
    /** 工具名称标识 */
    name = "Bash";

    /** 后台进程注册表：taskId → ChildProcess，用于停止和管理后台任务 */
    private static backgroundProcesses = new Map<string, ReturnType<typeof exec>>();

    /** 获取所有后台任务 ID 列表 */
    static getBackgroundTaskIds(): string[] {
        return Array.from(BashTool.backgroundProcesses.keys());
    }

    /** 停止指定后台任务 */
    static stopBackgroundTask(taskId: string): boolean {
        const child = BashTool.backgroundProcesses.get(taskId);
        if (!child) return false;
        child.kill("SIGTERM");
        BashTool.backgroundProcesses.delete(taskId);
        return true;
    }

    /**
     * 工具描述
     * 解决问题：告知模型沙箱优先策略，以及后台执行能力
     */
    description = "执行 Shell 命令。优先通过 Docker 沙箱执行，不可用时降级到本地执行。支持后台执行。";

    /**
     * 参数 JSON Schema 定义
     * 解决问题：
     * - command: 核心执行内容
     * - timeout: 可控超时，防止命令无限挂起
     * - description: 给用户看的命令用途说明（安全审批时展示）
     * - run_in_background: 后台执行，用于启动长时间服务
     */
    parameters: JSONSchema = {
        type: "object",
        properties: {
            command: { type: "string", description: "要执行的 Shell 命令" },
            timeout: { type: "number", description: `超时毫秒数（默认 ${DEFAULT_TIMEOUT}，最大 ${MAX_TIMEOUT}）`, default: DEFAULT_TIMEOUT },
            description: { type: "string", description: "命令用途描述" },
            run_in_background: { type: "boolean", description: "是否后台执行", default: false },
        },
        required: ["command"],
    };

    /**
     * 执行 Shell 命令
     *
     * @param params - 包含 command、timeout、run_in_background 的运行时数据
     * @param context - 执行上下文，包含 sandbox、workingDirectory、signal 等
     * @returns ToolResult - 命令输出或错误信息
     *
     * 执行流程：
     * 1. 危险模式检测（第一层安全防线）
     * 2. 判断后台执行 → fire-and-forget
     * 3. 检查沙箱可用性 → 优先沙箱执行
     * 4. 沙箱不可用 → 降级到本地执行
     */
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const command = params.command as string;
        // 限制 timeout 不超过 MAX_TIMEOUT，防止极端超时参数
        const timeout = Math.min((params.timeout as number) ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
        const runInBackground = (params.run_in_background as boolean) ?? false;

        // ─── 第一层安全防线：危险模式正则检测 ───
        // 解决问题：在命令执行前拦截已知危险操作，提供明确拒绝理由
        const safetyCheck = this.checkDangerousPatterns(command);
        if (safetyCheck) {
            return { tool_use_id: "", content: `安全拦截: ${safetyCheck}`, is_error: true };
        }

        // ─── 后台执行模式 ───
        // 解决问题：启动长时间运行的服务（如 dev server），不阻塞 Agent 响应
        if (runInBackground) {
            const taskId = this.runDetached(command, context);
            return { tool_use_id: "", content: `后台任务已启动\n- 任务 ID: ${taskId}\n- 命令: ${command}\n- 使用 TaskOutput(task_id="${taskId}") 查看状态，TaskStop(task_id="${taskId}") 停止任务` };
        }

        // ─── 第二层安全防线：尝试沙箱执行 ───
        // 解决问题：生产环境中优先使用 Docker 沙箱，隔离命令执行的文件系统和网络
        if (context.sandbox) {
            const available = await context.sandbox.isAvailable();
            if (available) {
                return this.executeInSandbox(command, timeout, context);
            }
        }

        // ─── 第三层：降级到本地执行 ───
        // 解决问题：开发环境中没有 Docker 沙箱时，退回到本地子进程执行
        return this.executeLocal(command, timeout, context);
    }

    /**
     * 是否需要用户确认
     * 解决问题：Shell 命令能修改文件系统和网络，必须经过用户审批
     */
    requiresApproval(): boolean {
        return true;
    }

    // ─── 沙箱执行 ───

    /**
     * 在 Docker 沙箱中执行命令
     *
     * @param command - Shell 命令字符串
     * @param timeout - 超时毫秒数
     * @param context - 执行上下文
     * @returns ToolResult - 沙箱执行结果
     *
     * 解决问题：
     * - 提供文件系统和网络隔离，防止命令影响宿主机
     * - 统一的 stdout/stderr 格式，自动添加 [stderr] 标记
     * - 超时检测：命令超时时附加 "(命令执行超时)" 提示
     * - 沙箱失败时自动降级到本地执行（容错设计）
     */
    private async executeInSandbox(command: string, timeout: number, context: ToolContext): Promise<ToolResult> {
        try {
            const result = await context.sandbox!.exec(command, {
                workdir: context.workingDirectory,
                timeout,
                maxOutput: MAX_OUTPUT_LENGTH,
            });

            // ─── 输出拼接 ───
            // 解决问题：stdout 和 stderr 分开标记，帮助用户区分正常输出和错误输出
            const parts: string[] = [];
            if (result.stdout) parts.push(result.stdout);
            if (result.stderr) parts.push(`\n[stderr]\n${result.stderr}`);
            if (parts.length === 0) parts.push(`(退出码: ${result.exitCode})`);

            // ─── 输出截断保护 ───
            // 解决问题：即使是沙箱也再次截断，防止内部实现绕过 maxOutput 限制
            const output = parts.join("").slice(0, MAX_OUTPUT_LENGTH);
            const cleaned = this.stripAnsi(output);
            const suffix = result.timedOut ? "\n(命令执行超时)" : output.length >= MAX_OUTPUT_LENGTH ? "\n(输出已截断)" : "";

            return { tool_use_id: "", content: cleaned + suffix, is_error: result.exitCode !== 0 && !result.timedOut };
        } catch (error) {
            const message = error instanceof Error ? error.message : "沙箱执行失败";
            // ─── 沙箱失败自动降级 ───
            // 解决问题：Docker daemon 未启动等情况下不直接报错，尝试本地执行兜底
            context.logger?.warn("沙箱执行失败，降级到本地执行", message);
            return this.executeLocal(command, timeout, context);
        }
    }

    // ─── 本地执行（降级方案） ───

    /**
     * 使用 Node.js child_process 本地执行命令
     *
     * @param command - Shell 命令字符串
     * @param timeout - 超时毫秒数
     * @param context - 执行上下文，用于获取工作目录和 AbortSignal
     * @returns Promise<ToolResult> - 本地执行结果
     *
     * 解决问题：
     * - 开发环境无 Docker 时的正常执行路径
     * - 使用 exec（非 spawn）确保完整的命令解析（管道、重定向等 Bash 语法）
     * - 通过 cwd 参数将进程工作目录设为项目目录
     * - maxBuffer: 1MB 缓冲区保护，防止输出过大导致进程崩溃
     * - AbortSignal 传递：支持外部取消（如用户 Ctrl+C）
     */
    private executeLocal(command: string, timeout: number, context: ToolContext): Promise<ToolResult> {
        return new Promise((resolve) => {
            const child = exec(command, {
                cwd: context.workingDirectory,  // 工作目录设为项目根目录
                timeout,                         // 超时自动 kill
                signal: context.signal,          // 响应外部取消信号
                maxBuffer: 1024 * 1024,          // 1MB 输出缓冲区上限
                shell: "/bin/bash",              // 明确指定 Bash（兼容性考虑）
            });

            let stdout = "";
            let stderr = "";

            // ─── 流式数据收集 ───
            // 解决问题：使用 data 事件而非一次性读取，避免大输出阻塞
            child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
            child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

            // ─── 进程退出处理 ───
            // 解决问题：close 事件确保所有 stdio 流已关闭后才读取完整输出
            child.on("close", (exitCode) => {
                const parts: string[] = [];
                if (stdout) parts.push(stdout);
                if (stderr) parts.push(`\n[stderr]\n${stderr}`);
                if (parts.length === 0) parts.push(`(退出码: ${exitCode ?? -1})`);

                const output = parts.join("").slice(0, MAX_OUTPUT_LENGTH);
                const cleaned = this.stripAnsi(output);
                resolve({
                    tool_use_id: "",
                    content: cleaned,
                    is_error: exitCode !== 0,
                });
            });

            // ─── 进程启动失败处理 ───
            // 解决问题：命令路径不存在、权限不足等启动阶段错误的捕获
            child.on("error", (err) => {
                resolve({
                    tool_use_id: "",
                    content: `命令执行失败: ${err.message}`,
                    is_error: true,
                });
            });
        });
    }

    /**
     * 后台执行（fire-and-forget 模式）
     *
     * @param command - Shell 命令字符串
     * @param context - 执行上下文
     *
     * 解决问题：
     * - 启动长时间运行的服务（dev server、watch mode、database）
     * - detached: true 使子进程独立于父进程生命周期
     * - stdio: "ignore" 防止子进程输出阻塞
     * - child.unref() 让事件循环不等待此进程（Agent 正常退出时不会卡住）
     * - 注册到全局任务注册表，支持 TaskOutput / TaskStop 查询和管理
     *
     * 注意：后台进程不会返回执行结果，Agent 无法知道它是否成功启动
     */
    private runDetached(command: string, context: ToolContext): string {
        const taskId = `bash-${randomUUID().slice(0, 8)}`;
        const child = exec(command, {
            cwd: context.workingDirectory,
            shell: "/bin/bash",
            detached: true,
            stdio: "ignore",
        } as Record<string, unknown> as never);
        child.unref();

        // ─── 注册到后台进程表 ───
        BashTool.backgroundProcesses.set(taskId, child);
        child.on("close", () => {
            BashTool.backgroundProcesses.delete(taskId);
        });

        return taskId;
    }

    /**
     * ANSI 转义序列清除
     *
     * @param text - 可能包含 ANSI 控制码的原始输出
     * @returns 清除后的纯文本
     *
     * 解决问题：终端输出中的颜色码、光标控制等对 LLM 是噪音，
     * 清除后减少 token 浪费，也避免干扰模型理解
     */
    private stripAnsi(text: string): string {
        return text.replace(ANSI_REGEX, "");
    }

    /**
     * 危险命令模式检测（第一层安全防线）
     *
     * @param command - 用户待执行的命令字符串
     * @returns 危险原因描述字符串，安全时返回 null
     *
     * 解决问题：
     * - rm -rf /: 防止误删根目录（灾难级破坏）
     * - > /dev/sd*: 防止写裸设备（直接写入磁盘块）
     * - mkfs.*: 防止格式化操作（磁盘分区格式化）
     * - dd if=: 防止 dd 磁盘操作（扇区级读写）
     * - fork bomb 模式: 防止系统资源耗尽攻击
     * - curl | sh: 防止执行远程未验证脚本（供应链攻击）
     *
     * 注意：这些是正则匹配，存在绕过可能。真正的安全依赖沙箱隔离。
     */
    private checkDangerousPatterns(command: string): string | null {
        const dangerous: Array<{ pattern: RegExp; reason: string }> = [
            { pattern: /rm\s+-rf\s+\//, reason: "禁止 'rm -rf /' 操作" },
            { pattern: />\s*\/dev\/sd[a-z]/, reason: "禁止写裸设备" },
            { pattern: /mkfs\./, reason: "禁止格式化操作" },
            { pattern: /dd\s+if=/, reason: "禁止 dd 操作" },
            { pattern: /:\(\)\s*\{/, reason: "检测到 fork bomb 模式" },
            { pattern: /curl.*\|\s*(ba)?sh/, reason: "禁止直接执行远程脚本" },
        ];
        for (const { pattern, reason } of dangerous) {
            if (pattern.test(command)) return reason;
        }
        return null;
    }
}
