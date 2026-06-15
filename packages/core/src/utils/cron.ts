/**
 * utils/cron.ts — Cron 定时任务调度器
 *
 * 【是什么】
 *   轻量级 cron 表达式解析和定时任务调度器。支持一次性/重复任务，
 *   自动计算下次执行时间，支持将 durable 任务持久化到磁盘文件。
 *
 * 【解决什么问题】
 *   1. 定时提醒：用户设置 "每 5 分钟检查部署状态" 或 "每天 9 点运行日报"
 *      后，调度器在准确的时间触发回调执行对应提示词。
 *   2. 一次性任务：支持 "30 分钟后提醒我" 这种一次性提醒，到期触发后自动删除。
 *   3. 跨会话持久化：durable 任务写入 JSON 文件，进程重启后自动恢复。
 *      session-only 任务仅在内存中，进程退出即消失。
 *   4. 自动过期清理：重复任务创建超过 7 天后自动删除，防止无限积累。
 *   5. 轻量实现：不需要系统级 cron 或 node-cron 依赖，减少安装体积。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * CronJob — Cron 任务定义
 *
 * 字段说明：
 *   - cron：5 字段 cron 表达式（分 时 日 月 周）
 *   - prompt：触发时执行的提示词（通知内容或自动化指令）
 *   - recurring：是否循环执行（false 为一次性任务，触发后自动删除）
 *   - durable：是否持久化到磁盘（session-only = false，进程退出即消失）
 *   - lastRun / nextRun：追踪执行时间和下次触发时间
 */
export interface CronJob {
    /** 任务唯一标识符 */
    id: string;
    /**
     * 5 字段 cron 表达式: minute hour day-of-month month day-of-week
     * 例：
     *   "&#42;/5 * * * *" — 每 5 分钟
     *   "0 9 * * 1-5" — 工作日 9:00
     *   "30 14 28 2 *" — 2 月 28 日 14:30（一次性）
     */
    cron: string;
    /** 触发时执行的提示词（传递给 onTrigger 回调） */
    prompt: string;
    /** 是否重复（默认 true）；false 表示一次性任务，触发后自动删除 */
    recurring: boolean;
    /** 是否持久化到磁盘（写入 .y-claude/scheduled_tasks.json） */
    durable: boolean;
    /** 任务创建时间（ISO 8601） */
    createdAt: string;
    /** 上次触发时间（首次运行前为 undefined） */
    lastRun?: string;
    /** 下次触发时间（ISO 8601） */
    nextRun: string;
}

/**
 * CronScheduler — 定时任务调度器
 *
 * 核心机制：
 *   - 每 30 秒执行一次 tick()，遍历所有任务检查是否到期
 *   - 到期任务触发 onTrigger 回调，更新 nextRun（重复任务）或标记删除（一次性）
 *   - durable 任务在添加/删除/触发后自动持久化到文件
 *   - 启动时自动从文件恢复 durable 任务
 *
 * 为什么不使用更短的检查间隔：
 *   - 用户提示类任务对精度要求不高（秒级就够），30 秒间隔满足需求
 *   - 更短的间隔（如 1 秒）徒增 CPU 开销，没有实际收益
 */
export class CronScheduler {
    /** 所有已注册的任务（包括非 durable 的内存任务） */
    private jobs: Map<string, CronJob> = new Map();
    /** 定时器句柄（用于 stop 清理） */
    private timer: ReturnType<typeof setInterval> | null = null;
    /** 持久化文件路径 */
    private persistPath: string;
    /** 任务触发回调：由外部注入，决定任务触发时执行什么操作 */
    private onTrigger: ((job: CronJob) => void) | null = null;

    /**
     * @param persistPath — 持久化文件路径，默认 ~/.y-claude-code/scheduled_tasks.json
     */
    constructor(persistPath?: string) {
        this.persistPath = persistPath ?? path.join(os.homedir(), ".y-claude-code", "scheduled_tasks.json");
        // 启动时恢复之前持久化的 durable 任务
        this.loadPersistedJobs();
    }

    /**
     * 启动调度器
     *
     * 调用时机：应用初始化完成后调用，传入 onTrigger 回调
     *
     * @param onTrigger — 任务触发时的回调函数
     */
    start(onTrigger: (job: CronJob) => void): void {
        this.onTrigger = onTrigger;
        // 每 30 秒检查一次是否有任务到期
        this.timer = setInterval(() => this.tick(), 30_000);
    }

    /**
     * 停止调度器
     *
     * 调用时机：应用关闭前
     * 注意：停止后 timer 置 null，确保可以重新 start()
     */
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * 添加新任务
     *
     * 任务 ID 生成策略：
     *   cron_{timestamp}_{random4chars} — 结合时间戳和随机字符，几乎不可能碰撞
     *
     * 为什么不直接用 UUID：
     *   - 时间戳前缀方便按创建时间排序
     *   - cron_ 前缀可读性更好，方便调试时识别
     *
     * @param job — 任务配置（不含 id/createdAt/nextRun，由内部生成）
     * @returns 创建好的完整任务对象（含 id）
     */
    add(job: Omit<CronJob, "id" | "createdAt" | "nextRun">): CronJob {
        const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newJob: CronJob = {
            ...job,
            id,
            createdAt: new Date().toISOString(),
            nextRun: this.calculateNextRun(job.cron), // 计算首次触发时间
        };
        this.jobs.set(id, newJob);

        // durable 任务立即持久化，防止进程崩溃丢失
        if (job.durable) this.persist();
        return newJob;
    }

    /**
     * 删除任务
     *
     * 为什么删除成功后也触发持久化：
     *   - durable 任务的删除需要同步到磁盘
     *   - 非 durable 任务的删除不需要持久化，但 persist() 内部只写 durable 的，
     *     所以对非 durable 无影响
     *
     * @param id — 任务 ID
     * @returns 是否成功删除（任务不存在时返回 false）
     */
    remove(id: string): boolean {
        const deleted = this.jobs.delete(id);
        if (deleted) this.persist(); // 同步磁盘状态
        return deleted;
    }

    /**
     * 列出所有已注册任务
     *
     * 包括 durable 和 session-only 的，按添加顺序排列
     *
     * @returns 所有任务的数组
     */
    list(): CronJob[] {
        return Array.from(this.jobs.values());
    }

    /**
     * 获取单个任务详情
     *
     * @param id — 任务 ID
     * @returns 任务对象，不存在返回 undefined
     */
    get(id: string): CronJob | undefined {
        return this.jobs.get(id);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 私有方法
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 每次定时器触发时调用，检查并执行到期任务
     *
     * 处理流程：
     *   1. 遍历所有任务，检查 nextRun <= now
     *   2. 触发到期任务的 onTrigger 回调
     *   3. 更新 lastRun 为当前时间
     *   4. 重复任务：计算下一次 nextRun
     *   5. 一次性任务：加入待删除列表
     *   6. 检查 7 天过期规则
     *   7. 统一删除过期/一次性任务
     *   8. 持久化（如果有任务被删除）
     *
     * 为什么不边遍历边删除：
     *   - 在 Map 遍历过程中直接 delete 可能导致迭代器行为不一致
     *   - 先收集待删除 ID，遍历结束后统一删除更安全
     */
    private tick(): void {
        const now = new Date();
        const toRemove: string[] = [];

        for (const job of this.jobs.values()) {
            // ─── 检查是否到期 ───
            if (new Date(job.nextRun) <= now) {
                // 触发回调（通过 onTrigger 将任务提示词加入到 LLM 输入流）
                this.onTrigger?.(job);

                // 更新最后执行时间
                job.lastRun = now.toISOString();

                // ─── 处理重复/一次性逻辑 ───
                if (job.recurring) {
                    // 重复任务：计算下一次触发时间
                    job.nextRun = this.calculateNextRun(job.cron);
                } else {
                    // 一次性任务：标记为待删除
                    toRemove.push(job.id);
                }

                // ─── 7 天自动过期规则 ───
                // 重复任务创建满 7 天后自动删除，防止无限积累
                // 为什么是 7 天：
                //   - 用户不会需要超过 7 天的重复提醒（通常会在 1-3 天内手动停止）
                //   - 防止 session-only 任务因忘记清理而无限堆积内存
                const age = now.getTime() - new Date(job.createdAt).getTime();
                if (age > 7 * 24 * 60 * 60 * 1000 && job.recurring) {
                    toRemove.push(job.id);
                }
            }
        }

        // ─── 统一删除标记的任务 ───
        for (const id of toRemove) {
            this.jobs.delete(id);
        }
        // 有删除操作时持久化（如果有 durable 任务被删除）
        if (toRemove.length > 0) this.persist();
    }

    /**
     * 简单 cron 表达式解析：计算下次运行时间
     *
     * 支持的 cron 语法（简化版，非完整 POSIX cron）：
     *   - &#42;/N：每 N 分钟执行
     *     （如 &#42;/5 = 每 5 分钟）
     *   - 具体数字：在该时间点执行
     *     （如 9 = 第 9 分钟/小时）
     *   - *：通配符，保留当前时间对应字段不变
     *
     * 不支持的语法（超出简单使用场景）：
     *   - 逗号分隔（如 1,15,30）：未实现
     *   - 范围（如 1-5）：未实现
     *   - day-of-month 和 day-of-week 的复杂逻辑：未实现
     *
     * 为什么不使用 cron-parser 库：
     *   - 使用场景简单（每 N 分钟 / 固定时间点），内置解析器足够
     *   - 避免引入额外 npm 依赖
     *
     * @param cron — cron 表达式（分 时 日 月 周）
     * @returns 下次触发时间的 ISO 8601 字符串
     */
    private calculateNextRun(cron: string): string {
        const parts = cron.split(/\s+/);
        // 格式校验：必须有 5 个字段
        if (parts.length !== 5) return new Date(Date.now() + 60_000).toISOString();

        const minute = parts[0];
        const hour = parts[1];

        const now = new Date();
        const next = new Date(now);

        // ─── 解析分钟字段 ───
        if (minute.startsWith("*/")) {
            // */N 格式：每 N 分钟执行一次
            // 计算距离上一次整点 N 分钟的偏移
            const interval = parseInt(minute.slice(2), 10) || 10;
            next.setMinutes(now.getMinutes() + interval);
        } else if (minute !== "*") {
            // 具体分钟数：在指定分钟执行
            next.setMinutes(parseInt(minute, 10));
        }
        // minute === "*" 时保持不变（以当前分钟为基准）

        // ─── 解析小时字段 ───
        if (hour !== "*") {
            // 具体小时：设置到指定小时
            next.setHours(parseInt(hour, 10));
        }
        // hour === "*" 时保持不变（以当前小时为基准）

        // ─── 防止计算出的时间已过 ───
        // 如果计算出的是过去的时间，至少推迟 1 分钟
        // 这是一个简化处理，完善实现需要推到下一个匹配的周期
        if (next <= now) {
            next.setMinutes(next.getMinutes() + 1);
        }

        // ─── 归零秒和毫秒 ───
        next.setSeconds(0, 0);
        return next.toISOString();
    }

    /**
     * 持久化 durable 任务到磁盘文件
     *
     * 持久化策略：
     *   - 仅写入 durable=true 的任务（session-only 不落盘）
     *   - 全量覆写 JSON 文件（任务数量少，增量更新收益不大）
     *   - 失败静默处理：持久化是带外操作，不应阻塞调度
     *
     * 为什么使用同步 API (fs.writeFileSync)：
     *   - persist() 可能在 tick() 的循环中被调用，异步可能产生竞态
     *   - 任务数据量小（通常 < 100 条），同步写入不会阻塞事件循环
     */
    private persist(): void {
        try {
            const dir = path.dirname(this.persistPath);
            fs.mkdirSync(dir, { recursive: true });
            // 只持久化 durable 任务
            const durableJobs = Array.from(this.jobs.values()).filter((j) => j.durable);
            fs.writeFileSync(this.persistPath, JSON.stringify(durableJobs, null, 2));
        } catch {
            // 持久化失败不阻塞调度器运行
            // 可能原因：磁盘满、权限不足
        }
    }

    /**
     * 从磁盘文件恢复已持久化的 durable 任务
     *
     * 调用时机：构造函数中自动调用，实现跨会话恢复
     *
     * 为什么不在 loadPersistedJobs 中校验任务是否已过期：
     *   - 过期检查在 tick() 统一处理，避免两处维护过期逻辑
     *   - 恢复的任务在下一次 tick 时会自动被检查和清理
     */
    private loadPersistedJobs(): void {
        try {
            const raw = fs.readFileSync(this.persistPath, "utf-8");
            const jobs = JSON.parse(raw) as CronJob[];
            for (const job of jobs) {
                this.jobs.set(job.id, job);
            }
        } catch {
            // 文件不存在（首次运行）或格式错误，忽略
            // 初始化为空 Map，后续通过 add() 添加任务
        }
    }
}
