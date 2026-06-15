// ─── packages/core/src/utils/tmux.ts ───
// Tmux 集成 — 终端多路复用会话管理
// 解决问题：为 CLI 提供 tmux 会话感知和窗口/面板管理能力，
//          允许在 tmux 中并行运行命令、分割面板展示输出。
//
// 核心能力：
//   1. 检测 tmux 是否可用 + 是否运行在 tmux 内部
//   2. 创建新窗口运行命令（如长时间运行的测试/构建）
//   3. 分割面板并行展示（如左侧代码审查，右侧运行测试）
//   4. 向指定面板发送按键/命令
//   5. 捕获面板输出内容
//
// 为什么需要 tmux 集成：
//   - AI 可能需要同时运行多个命令（并行测试、多文件编译等）
//   - 长时间命令（如 npm install）适合在独立窗口中运行，不阻塞主交互
//   - 分割面板可以同时展示代码审查结果和终端输出
//   - 自动感知 tmux 环境，提供原生的终端多路复用体验

import { execSync } from "node:child_process";

/**
 * Tmux 窗口/面板配置
 */
export interface TmuxWindowConfig {
    /** 窗口名称 */
    name?: string;
    /** 要执行的命令 */
    command: string;
    /** 工作目录 */
    cwd?: string;
    /** 环境变量 */
    env?: Record<string, string>;
}

/**
 * Tmux 面板配置
 */
export interface TmuxPaneConfig {
    /** 分割方向: vertical (左右) 或 horizontal (上下) */
    direction: "vertical" | "horizontal";
    /** 要执行的命令 */
    command?: string;
    /** 目标面板（为空则作用到当前面板） */
    target?: string;
}

/**
 * Tmux 会话信息
 */
export interface TmuxSessionInfo {
    /** 会话名称 */
    name: string;
    /** 窗口数量 */
    windows: number;
    /** 创建时间 */
    created: string;
    /** 是否 attach 中 */
    attached: boolean;
}

/**
 * Tmux 环境检测结果
 */
export interface TmuxEnvironment {
    /** tmux 是否已安装 */
    available: boolean;
    /** 当前是否运行在 tmux 会话中 */
    inside: boolean;
    /** 当前会话名称（如果在 tmux 中） */
    sessionName?: string;
    /** 当前窗口索引 */
    windowIndex?: number;
    /** 当前面板索引 */
    paneIndex?: number;
    /** tmux 版本 */
    version?: string;
}

/**
 * Tmux 管理器
 *
 * 【是什么】
 * 封装 tmux CLI 命令，提供编程化的 tmux 操作接口。
 * 所有操作首先检查 tmux 是否可用，不可用时返回明确的错误提示。
 *
 * 【解决什么问题】
 * 1. AI Agent 需要并行执行多个命令时，利用 tmux 窗口/面板实现并发
 * 2. 长时间运行的命令在独立窗口中执行，不阻塞主交互
 * 3. 自动适配 tmux 环境，未安装时优雅降级
 */
export class TmuxManager {
    private tmuxCommand: string;

    constructor(tmuxCommand = "tmux") {
        this.tmuxCommand = tmuxCommand;
    }

    // ─── 环境检测 ───

    /**
     * 检测 tmux 环境
     * @returns 完整的环境信息
     */
    detect(): TmuxEnvironment {
        const result: TmuxEnvironment = {
            available: false,
            inside: false,
        };

        // 检查 tmux 是否安装
        try {
            const version = execSync(`${this.tmuxCommand} -V`, {
                encoding: "utf-8",
                timeout: 3000,
                stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            result.available = true;
            result.version = version.replace("tmux ", "");
        } catch {
            return result; // tmux 未安装
        }

        // 检查是否在 tmux 会话中（通过 TMUX 环境变量）
        if (process.env.TMUX) {
            result.inside = true;

            try {
                // 获取会话名
                result.sessionName = execSync(
                    `${this.tmuxCommand} display-message -p '#{session_name}'`,
                    { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
                ).trim();

                result.windowIndex = parseInt(
                    execSync(`${this.tmuxCommand} display-message -p '#{window_index}'`, {
                        encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
                    }).trim(),
                    10,
                );

                result.paneIndex = parseInt(
                    execSync(`${this.tmuxCommand} display-message -p '#{pane_index}'`, {
                        encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
                    }).trim(),
                    10,
                );
            } catch {
                // 部分信息获取失败也不影响整体判断
            }
        }

        return result;
    }

    /** 快捷方法：tmux 是否可用 */
    isAvailable(): boolean {
        try {
            execSync(`${this.tmuxCommand} -V`, {
                encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
            });
            return true;
        } catch {
            return false;
        }
    }

    /** 快捷方法：是否运行在 tmux 中 */
    isInsideTmux(): boolean {
        return !!process.env.TMUX;
    }

    // ─── 会话管理 ───

    /**
     * 列出所有 tmux 会话
     */
    listSessions(): TmuxSessionInfo[] {
        try {
            const output = execSync(
                `${this.tmuxCommand} list-sessions -F '#{session_name}|#{session_windows}|#{session_created}|#{session_attached}'`,
                { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
            ).trim();

            if (!output) return [];

            return output.split("\n").map((line) => {
                const [name, windows, created, attached] = line.split("|");
                return {
                    name,
                    windows: parseInt(windows, 10),
                    created,
                    attached: attached === "1",
                };
            });
        } catch {
            return [];
        }
    }

    /**
     * 创建新 tmux 会话
     * @param name 会话名称
     * @param command 初始命令（可选）
     */
    createSession(name: string, command?: string): string {
        let cmd = `${this.tmuxCommand} new-session -d -s "${name}"`;
        if (command) {
            cmd += ` "${command}"`;
        }
        try {
            return execSync(cmd, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
        } catch (error: any) {
            throw new Error(`创建 tmux 会话失败: ${error.stderr || error.message}`);
        }
    }

    /**
     * Attach 到已有 tmux 会话
     * @param name 会话名称
     */
    attachSession(name: string): void {
        // attach 需要终端交互，不能通过 execSync 执行
        // 提供命令字符串供外部调用
        throw new Error(
            `请手动执行: ${this.tmuxCommand} attach-session -t "${name}"\n` +
            "attach 需要完整的终端环境，无法通过子进程执行。",
        );
    }

    /**
     * 杀死 tmux 会话
     */
    killSession(name: string): void {
        try {
            execSync(`${this.tmuxCommand} kill-session -t "${name}"`, {
                encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (error: any) {
            throw new Error(`杀死 tmux 会话失败: ${error.stderr || error.message}`);
        }
    }

    // ─── 窗口管理 ───

    /**
     * 在新窗口中运行命令
     *
     * @param config 窗口配置
     * @returns 窗口索引或标识符
     *
     * 典型用途：
     *   - 运行 npm install 这类长时间操作
     *   - 并行执行多个独立的构建任务
     *   - 在后台运行开发服务器
     */
    newWindow(config: TmuxWindowConfig): string {
        const nameArg = config.name ? ` -n "${config.name}"` : "";
        const cwdArg = config.cwd ? ` -c "${config.cwd}"` : "";
        const command = config.command.replace(/"/g, '\\"');

        try {
            const output = execSync(
                `${this.tmuxCommand} new-window${nameArg}${cwdArg} "${command}"`,
                { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
            ).trim();
            return output;
        } catch (error: any) {
            throw new Error(`创建 tmux 窗口失败: ${error.stderr || error.message}`);
        }
    }

    /**
     * 列出所有窗口
     */
    listWindows(): Array<{ index: number; name: string; active: boolean }> {
        try {
            const output = execSync(
                `${this.tmuxCommand} list-windows -F '#{window_index}|#{window_name}|#{window_active}'`,
                { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
            ).trim();

            if (!output) return [];

            return output.split("\n").map((line) => {
                const [index, name, active] = line.split("|");
                return {
                    index: parseInt(index, 10),
                    name,
                    active: active === "1",
                };
            });
        } catch {
            return [];
        }
    }

    /**
     * 选择指定窗口
     */
    selectWindow(target: string): void {
        try {
            execSync(`${this.tmuxCommand} select-window -t "${target}"`, {
                encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (error: any) {
            throw new Error(`选择窗口失败: ${error.stderr || error.message}`);
        }
    }

    /**
     * 杀死指定窗口
     */
    killWindow(target: string): void {
        try {
            execSync(`${this.tmuxCommand} kill-window -t "${target}"`, {
                encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (error: any) {
            throw new Error(`杀死窗口失败: ${error.stderr || error.message}`);
        }
    }

    // ─── 面板管理 ───

    /**
     * 分割当前面板
     *
     * @param config 面板配置
     * @returns 新面板标识符
     *
     * 典型用途：
     *   - 左侧编辑代码，右侧显示测试结果
     *   - 上方展示日志，下方执行诊断命令
     */
    splitPane(config: TmuxPaneConfig): string {
        const directionFlag = config.direction === "vertical" ? "-h" : "-v";
        const targetArg = config.target ? ` -t "${config.target}"` : "";
        const commandArg = config.command ? ` "${config.command.replace(/"/g, '\\"')}"` : "";

        try {
            const output = execSync(
                `${this.tmuxCommand} split-window ${directionFlag}${targetArg}${commandArg}`,
                { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
            ).trim();
            return output;
        } catch (error: any) {
            throw new Error(`分割面板失败: ${error.stderr || error.message}`);
        }
    }

    /**
     * 向指定面板发送按键
     * @param target 目标面板标识
     * @param keys 要发送的按键字符串
     */
    sendKeys(target: string, keys: string): void {
        try {
            execSync(
                `${this.tmuxCommand} send-keys -t "${target}" "${keys.replace(/"/g, '\\"')}"`,
                { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
            );
        } catch (error: any) {
            throw new Error(`发送按键失败: ${error.stderr || error.message}`);
        }
    }

    /**
     * 捕获指定面板的文本内容
     * @param target 目标面板标识
     * @param joinLines 是否用 \n 连接行
     * @returns 面板当前可见的文本内容
     */
    capturePane(target?: string, joinLines = true): string {
        const targetArg = target ? ` -t "${target}"` : "";
        const joinArg = joinLines ? " -J" : "";

        try {
            return execSync(
                `${this.tmuxCommand} capture-pane -p${targetArg}${joinArg}`,
                { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
            );
        } catch (error: any) {
            throw new Error(`捕获面板内容失败: ${error.stderr || error.message}`);
        }
    }

    /**
     * 调整面板大小
     * @param target 目标面板
     * @param direction 调整方向: up/down/left/right
     * @param amount 调整量（行数或列数）
     */
    resizePane(target: string, direction: "up" | "down" | "left" | "right", amount: number): void {
        const dirMap = { up: "-U", down: "-D", left: "-L", right: "-R" };
        try {
            execSync(
                `${this.tmuxCommand} resize-pane -t "${target}" ${dirMap[direction]} ${amount}`,
                { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
            );
        } catch (error: any) {
            throw new Error(`调整面板大小失败: ${error.stderr || error.message}`);
        }
    }

    // ─── 便捷方法 ───

    /**
     * 在新窗口中运行长时间命令并返回窗口标识
     *
     * 解决问题：Agent 需要执行 npm install / docker build 等长时间任务时，
     *          在 tmux 窗口中运行可以让用户实时查看进度，同时不阻塞主交互。
     */
    runInWindow(name: string, command: string, cwd?: string): { windowName: string; sessionName: string } {
        const sessionName = this.detect().sessionName || "claude-code";
        const windowName = name.replace(/\s+/g, "-").toLowerCase();

        this.newWindow({ name: windowName, command, cwd });

        return { windowName, sessionName };
    }

    /**
     * 在分割面板中运行命令
     *
     * 解决问题：Agent 需要在当前视图中并排展示两个进程的输出，
     *          如"左侧代码 lint，右侧运行测试"。
     */
    runInPane(command: string, direction: "vertical" | "horizontal" = "vertical"): void {
        this.splitPane({ command, direction });
    }

    /**
     * 获取当前工作面板的标识符
     */
    getCurrentPane(): string {
        return execSync(
            `${this.tmuxCommand} display-message -p '#{pane_id}'`,
            { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
        ).trim();
    }

    /**
     * 获取环境信息的字符串描述（用于展示在 CLI 启动信息中）
     */
    getEnvironmentSummary(): string {
        const env = this.detect();
        if (!env.available) return "tmux 未安装";
        if (!env.inside) return "tmux 可用（当前未在 tmux 中运行）";
        return `tmux: ${env.sessionName}:${env.windowIndex}.${env.paneIndex} (v${env.version})`;
    }
}
