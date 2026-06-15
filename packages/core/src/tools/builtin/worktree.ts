// ─── packages/core/src/tools/builtin/worktree.ts ───
// Worktree 工具 — 进入/退出 git worktree 隔离环境
// 解决问题：为 Agent 提供 git worktree 隔离能力，在不影响主工作区的前提下
//          安全地执行代码修改任务。worktree 隔离比 process 隔离更彻底，
//          修改发生在独立的文件系统中，可通过 git 进行干净的合并或丢弃。
//
// 工作流程：
//   1. Agent 调用 EnterWorktree → 创建 git worktree 并切换到隔离目录
//   2. Agent 在 worktree 中执行修改任务
//   3. Agent 调用 ExitWorktree → 清理或保留 worktree，返回主工作区
//
// 【是什么】
// git worktree 允许在同一仓库中同时检出多个分支到不同目录。
// 每个 worktree 有独立的文件系统视图，但共享同一个 .git 目录，
// 因此创建/删除都非常快（秒级），不像完整克隆那样占用大量磁盘空间。
//
// 【解决什么问题】
// 1. 隔离风险：Agent 的修改不会影响主工作区的文件，出错可安全丢弃
// 2. 并行开发：可以在不 stash 当前修改的情况下处理另一个任务
// 3. 安全审查：worktree 中的修改可以通过 git diff 与主分支对比审查
// 4. 清理简单：删除 worktree 目录即可完全回滚所有修改

import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { existsSync } from "node:fs";

// ─── 运行时状态 ───

/**
 * 当前 worktree 会话状态
 * 解决问题：跟踪是否在 worktree 中、原始目录在哪，供 ExitWorktree 清理使用
 */
interface WorktreeSession {
    /** worktree 的目录路径 */
    worktreePath: string;
    /** 进入 worktree 前的原始工作目录 */
    originalDir: string;
    /** worktree 对应的分支名 */
    branch: string;
}

let activeSession: WorktreeSession | null = null;

/** 检查是否处于 worktree 会话中 */
export function isInWorktree(): boolean {
    return activeSession !== null;
}

/** 获取当前 worktree 路径 */
export function getWorktreePath(): string | null {
    return activeSession?.worktreePath ?? null;
}

/** 获取进入 worktree 前的原始目录 */
export function getOriginalDir(): string | null {
    return activeSession?.originalDir ?? null;
}

// ─── Git Worktree 操作 ───

/**
 * 在指定仓库目录中执行 git 命令
 * 解决问题：统一 git 命令的执行和错误处理
 */
function git(args: string, cwd: string): string {
    try {
        return execSync(`git ${args}`, {
            cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 30000,
        }).trim();
    } catch (error: any) {
        const stderr = error.stderr?.trim() || error.message || "未知 git 错误";
        throw new Error(`git ${args.split(" ")[0]} 失败: ${stderr}`);
    }
}

/**
 * 检查目录是否为 git 仓库
 */
function isGitRepo(dir: string): boolean {
    try {
        git("rev-parse --git-dir", dir);
        return true;
    } catch {
        return false;
    }
}

/**
 * 获取默认分支名（main 或 master）
 */
function getDefaultBranch(repoDir: string): string {
    try {
        // 尝试从 remote 获取默认分支
        const ref = git("symbolic-ref refs/remotes/origin/HEAD", repoDir);
        return ref.replace("refs/remotes/origin/", "").trim();
    } catch {
        // 回退：检查本地是否存在 main 或 master
        try {
            git("rev-parse --verify main", repoDir);
            return "main";
        } catch {
            try {
                git("rev-parse --verify master", repoDir);
                return "master";
            } catch {
                return "main"; // 默认使用 main
            }
        }
    }
}

/**
 * 创建 git worktree
 * @returns worktree 的目录路径和分支名
 */
function createWorktree(
    repoDir: string,
    name?: string,
    baseRef?: string,
): { worktreePath: string; branch: string } {
    const worktreeName = name || `claude-${randomUUID().slice(0, 8)}`;
    // worktree 目录放在 .y-claude/worktrees/ 下
    const worktreesDir = path.join(repoDir, ".y-claude", "worktrees");
    const worktreePath = path.join(worktreesDir, worktreeName);
    const branchName = `claude/${worktreeName}`;

    // 确定基准引用
    let base: string;
    if (baseRef === "head") {
        base = "HEAD";
    } else {
        // fresh: 从远程默认分支的最新提交开始
        try {
            const defaultBranch = getDefaultBranch(repoDir);
            // 尝试 fetch 最新（非阻塞，失败也继续）
            try { git(`fetch origin ${defaultBranch} --depth=1`, repoDir); } catch { /* 离线也允许 */ }
            base = `origin/${defaultBranch}`;
        } catch {
            base = "HEAD";
        }
    }

    // 如果分支已存在，先删除再重建
    try { git(`branch -D ${branchName}`, repoDir); } catch { /* 分支不存在也正常 */ }

    // 创建 worktree
    git(`worktree add -b ${branchName} "${worktreePath}" ${base}`, repoDir);

    return { worktreePath, branch: branchName };
}

/**
 * 列出所有 worktree
 */
function listWorktrees(repoDir: string): Array<{ path: string; branch: string; head: string }> {
    const output = git("worktree list --porcelain", repoDir);
    const worktrees: Array<{ path: string; branch: string; head: string }> = [];
    let current: Partial<{ path: string; branch: string; head: string }> = {};

    for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
            if (current.path) worktrees.push(current as any);
            current = { path: line.slice("worktree ".length) };
        } else if (line.startsWith("HEAD ")) {
            current.head = line.slice("HEAD ".length);
        } else if (line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length);
        }
    }
    if (current.path) worktrees.push(current as any);

    return worktrees;
}

/**
 * 删除 git worktree
 */
function removeWorktree(repoDir: string, worktreePath: string, force = false): void {
    const flag = force ? "--force" : "";
    git(`worktree remove ${flag} "${worktreePath}"`, repoDir);
}

// ─── EnterWorktreeTool ───

/**
 * EnterWorktreeTool — 进入 git worktree 隔离环境
 *
 * 调用时机：Agent 需要在隔离环境中安全执行代码修改任务时
 *
 * 效果：
 *   1. 在 .y-claude/worktrees/ 下创建新的 git worktree
 *   2. 基于 origin/<default-branch> 或 HEAD 创建新分支
 *   3. 后续工具调用将在 worktree 目录中执行
 *   4. 主工作区的文件不受影响
 */
export class EnterWorktreeTool extends Tool {
    name = "EnterWorktree";
    description = "创建或进入一个 git worktree 隔离环境。在 worktree 中，所有文件修改都发生在独立的目录中，不会影响主工作区。适用于需要大规模修改或实验性改动的任务。";

    parameters = {
        type: "object" as const,
        properties: {
            name: {
                type: "string",
                description: "worktree 的名称（可选）。如不指定则自动生成。名称只能包含字母、数字、点、下划线和短横线，最长 64 字符。",
            },
            path: {
                type: "string",
                description: "已有 worktree 的路径（可选，与 name 互斥）。传入此参数时将切换到已有的 worktree，而非创建新 worktree。",
            },
        },
        required: [],
    } as unknown as JSONSchema;

    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const repoDir = context.workingDirectory;

        // ─── 前置检查：是否在 git 仓库中 ───
        if (!isGitRepo(repoDir)) {
            return {
                tool_use_id: "",
                content: "当前工作目录不是 git 仓库。EnterWorktree 需要在 git 仓库中使用。",
                is_error: true,
            };
        }

        // ─── 检查是否已在 worktree 中 ───
        if (activeSession) {
            return {
                tool_use_id: "",
                content: `已在 worktree 会话中（路径: ${activeSession.worktreePath}，分支: ${activeSession.branch}）。请先调用 ExitWorktree 退出当前 worktree。`,
                is_error: true,
            };
        }

        const name = params.name as string | undefined;
        const existingPath = params.path as string | undefined;

        // ─── 切换到已有 worktree ───
        if (existingPath) {
            if (!existsSync(existingPath)) {
                return {
                    tool_use_id: "",
                    content: `指定的 worktree 路径不存在: ${existingPath}`,
                    is_error: true,
                };
            }

            // 验证该路径确实是当前仓库的 worktree
            const worktrees = listWorktrees(repoDir);
            const found = worktrees.find((w) => w.path === existingPath);
            if (!found) {
                return {
                    tool_use_id: "",
                    content: `路径 "${existingPath}" 不属于当前仓库的 worktree。可用 git worktree list 查看所有 worktree。`,
                    is_error: true,
                };
            }

            activeSession = {
                worktreePath: existingPath,
                originalDir: repoDir,
                branch: found.branch,
            };

            return {
                tool_use_id: "",
                content: `已切换到已有 worktree:\n- 路径: ${existingPath}\n- 分支: ${found.branch}\n- 原始目录: ${repoDir}\n\n后续操作将在 worktree 目录中进行。完成后请调用 ExitWorktree 退出。`,
            };
        }

        // ─── 创建新 worktree ───
        try {
            const worktreeName = name || undefined;
            const { worktreePath, branch } = createWorktree(repoDir, worktreeName, "fresh");

            activeSession = {
                worktreePath,
                originalDir: repoDir,
                branch,
            };

            return {
                tool_use_id: "",
                content: `已创建并进入 git worktree 隔离环境:\n- 路径: ${worktreePath}\n- 分支: ${branch}\n- 原始目录: ${repoDir}\n- 基准: origin/${getDefaultBranch(repoDir)}\n\n所有文件修改将在此隔离环境中进行，主工作区不受影响。完成后请调用 ExitWorktree 退出（可选择保留或删除 worktree）。`,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            return {
                tool_use_id: "",
                content: `创建 worktree 失败: ${message}`,
                is_error: true,
            };
        }
    }

    requiresApproval(): boolean {
        return false;
    }
}

// ─── ExitWorktreeTool ───

/**
 * ExitWorktreeTool — 退出 git worktree 隔离环境
 *
 * 调用时机：Agent 完成在 worktree 中的任务后
 *
 * 效果：
 *   1. 恢复原始工作目录
 *   2. 根据 action 参数决定保留或删除 worktree
 *   3. 如果删除且有未提交的修改，需要 discard_changes 参数确认
 */
export class ExitWorktreeTool extends Tool {
    name = "ExitWorktree";
    description = "退出当前 git worktree 隔离环境。可选择保留 worktree（保持修改供后续使用）或删除 worktree（丢弃所有修改）。删除时如果 worktree 中有未合并的提交或未提交的修改，需要设置 discard_changes=true 确认丢弃。";

    parameters = {
        type: "object" as const,
        properties: {
            action: {
                type: "string",
                description: "退出操作: 'keep'（保留 worktree，修改留在磁盘上）或 'remove'（删除 worktree 目录和分支）",
                enum: ["keep", "remove"],
            },
            discard_changes: {
                type: "boolean",
                description: "仅对 action='remove' 生效。当 worktree 中有未提交的修改或未合并的提交时，必须设置为 true 才能强制删除，否则会拒绝删除以防止数据丢失。",
            },
        },
        required: ["action"],
    } as unknown as JSONSchema;

    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        if (!activeSession) {
            return {
                tool_use_id: "",
                content: "当前不在 worktree 会话中。无需退出。",
                is_error: true,
            };
        }

        const action = params.action as string;
        const discardChanges = params.discard_changes as boolean | undefined;
        const { worktreePath, originalDir, branch } = activeSession;

        if (action === "remove") {
            try {
                // 先尝试不带 --force 的删除
                removeWorktree(originalDir, worktreePath, false);

                activeSession = null;

                return {
                    tool_use_id: "",
                    content: `已退出并删除 worktree:\n- 路径: ${worktreePath}\n- 分支: ${branch}\n- 已恢复工作目录: ${originalDir}\n\nworktree 中的修改已随目录删除而丢弃。`,
                };
            } catch (error: any) {
                const errMsg = error.message || "";

                // 如果是因为有未提交的修改，需要 discard_changes 标志
                if (discardChanges) {
                    try {
                        removeWorktree(originalDir, worktreePath, true);
                        activeSession = null;

                        // 同时删除分支
                        try { git(`branch -D ${branch}`, originalDir); } catch { /* 分支可能已被删除 */ }

                        return {
                            tool_use_id: "",
                            content: `已强制退出并删除 worktree:\n- 路径: ${worktreePath}\n- 分支: ${branch}\n- 所有未提交修改已丢弃\n- 已恢复工作目录: ${originalDir}`,
                        };
                    } catch (forceError: any) {
                        return {
                            tool_use_id: "",
                            content: `强制删除 worktree 失败: ${forceError.message || forceError}`,
                            is_error: true,
                        };
                    }
                }

                return {
                    tool_use_id: "",
                    content: `删除 worktree 失败: ${errMsg}\n\nworktree 中可能存在未提交的修改或未合并的提交。如需强制删除，请设置 discard_changes=true。`,
                    is_error: true,
                };
            }
        }

        // action === "keep": 仅退出会话，保留 worktree
        activeSession = null;

        return {
            tool_use_id: "",
            content: `已退出 worktree 会话（worktree 已保留）:\n- 路径: ${worktreePath}\n- 分支: ${branch}\n- 已恢复工作目录: ${originalDir}\n\nworktree 目录和分支均已保留在磁盘上，可随时通过 EnterWorktree 设置 path="${worktreePath}" 重新进入。`,
        };
    }

    requiresApproval(): boolean {
        return true; // 删除 worktree 需要用户确认
    }
}
