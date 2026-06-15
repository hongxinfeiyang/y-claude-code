/**
 * utils/logger.ts — 结构化日志模块
 *
 * 【是什么】
 *   提供分级日志输出（debug/info/warn/error），支持缓冲批量写入文件。
 *   错误级别立即刷新，常规日志每 5 秒批量落盘。输出到 stderr 避免
 *   与 stdout（LLM 流式输出）混淆。
 *
 * 【解决什么问题】
 *   1. 分级日志：不同场景使用不同级别。开发期用 debug 跟踪细节，
 *      生产环境用 info/warn/error 减少噪音。
 *   2. 日志与 LLM 输出隔离：主工具的 stdout 用于 LLM 响应流输出，
 *      如果日志也写 stdout 会混入响应流导致解析错误。因此日志写入 stderr。
 *   3. 批量写盘：逐条 writeFile 会产生大量磁盘 I/O。使用内存缓冲 +
 *      定时批量写入（5 秒间隔），减少磁盘压力和碎片。
 *   4. 错误立即持久化：error 级日志不等待定时刷新，立即写入文件，
 *      确保崩溃前最后一刻的错误日志不丢失。
 *   5. 按日分割日志文件：每天一个日志文件（y-claude-code-YYYY-MM-DD.log），
 *      方便按日期查找和清理旧日志。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * LogLevel — 日志级别
 *
 * 级别定义（按严重程度递增）：
 *   debug — 开发调试信息（默认不输出）
 *   info  — 一般运行信息（默认级别）
 *   warn  — 警告（可恢复的异常）
 *   error — 错误（需要关注的问题）
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * LEVEL_VALUES — 日志级别数值映射
 *
 * 为什么用数值：
 *   - 便于比较：level >= currentLevel 即应输出，不需要复杂的 switch/case
 *   - 支持动态级别过滤：运行时可通过 setLevel 更换阈值
 */
const LEVEL_VALUES: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * LogEntry — 单条日志条目
 *
 * 结构化存储：
 *   - timestamp：ISO 8601 时间戳，便于按时间排序和搜索
 *   - level：级别标记，写入文件时转为大写
 *   - message：主要日志信息
 *   - args：附加上下文数据（任意类型，序列化为 JSON）
 */
interface LogEntry {
    timestamp: string; // ISO 8601 格式时间戳
    level: LogLevel;
    message: string;
    args: unknown[]; // 附加上下文，可能包含 Error 对象等
}

/**
 * Logger — 结构化日志器
 *
 * 设计要点：
 *   - 缓冲写入：避免高频 I/O
 *   - stderr 输出：隔离 LLM stdout 流
 *   - 定时刷新 + 立即刷新（error 级）组合策略
 *   - 按日分割日志文件
 */
export class Logger {
    /** 当前日志级别阈值：低于此级别的日志会被丢弃 */
    private level: LogLevel;
    /** 日志文件目录 */
    private logDir: string;
    /** 内存缓冲区：暂存待写入文件的日志条目 */
    private buffer: LogEntry[] = [];
    /** 定时刷新句柄：每隔 5 秒将缓冲区写入文件 */
    private flushInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * @param options.level — 日志级别阈值，默认 "info"
     * @param options.logDir — 日志文件目录，默认 ~/.y-claude-code/logs/
     */
    constructor(options?: { level?: LogLevel; logDir?: string }) {
        this.level = options?.level ?? "info";
        this.logDir = options?.logDir ?? path.join(os.homedir(), ".y-claude-code", "logs");

        // ─── 启动定时刷新：每 5 秒将缓冲区的日志批量写入文件 ───
        // 为什么是 5 秒：
        //   - 太短（< 1s）：失去批量写入的 I/O 减少效果
        //   - 太长（> 30s）：日志延迟过高，崩溃时丢失大量未落盘日志
        //   - 5 秒是平衡 I/O 效率和数据安全性的折中选择
        this.flushInterval = setInterval(() => this.flush(), 5000);
    }

    /** 记录 debug 级别日志（开发调试） */
    debug(msg: string, ...args: unknown[]): void { this.log("debug", msg, args); }

    /** 记录 info 级别日志（正常运行信息） */
    info(msg: string, ...args: unknown[]): void { this.log("info", msg, args); }

    /** 记录 warn 级别日志（可恢复的警告） */
    warn(msg: string, ...args: unknown[]): void { this.log("warn", msg, args); }

    /** 记录 error 级别日志（需要关注的错误） */
    error(msg: string, ...args: unknown[]): void { this.log("error", msg, args); }

    /**
     * 动态修改日志级别阈值
     *
     * 使用场景：
     *   - 用户报告问题后临时调为 debug 收集更多信息
     *   - 生产环境降级为 warn 减少日志量
     *
     * @param level — 新的日志级别
     */
    setLevel(level: LogLevel): void { this.level = level; }

    /**
     * 立即将缓冲区中的所有日志写入文件
     *
     * 调用时机：
     *   - 定时器触发（每 5 秒）
     *   - error 级别日志自动触发
     *   - destroy() 中最终刷新
     *
     * 为什么使用 splice(0) 而非清空后重新赋值：
     *   - splice(0) 原子的清空并返回所有元素，避免竞态
     *   - 如果在写入过程中有新的日志产生，它们会进入下一次刷新批次
     */
    flush(): void {
        if (this.buffer.length === 0) return;
        const entries = this.buffer.splice(0); // 原子的取出并清空缓冲区
        this.writeToFile(entries);
    }

    /**
     * 销毁 Logger，停止定时器并最终刷新
     *
     * 为什么需要 destroy：
     *   - 进程退出前必须清理 setInterval，否则 Node 进程不会退出
     *   - 最后刷新确保缓冲区中的日志不丢失
     */
    destroy(): void {
        if (this.flushInterval) clearInterval(this.flushInterval); // 停止定时刷新
        this.flush(); // 最后刷新一次，确保缓冲区清空
    }

    /**
     * 内部日志处理方法
     *
     * 处理流程：
     *   1. 级别过滤：低于阈值的忽略
     *   2. 写入缓冲区
     *   3. warn/error 同时输出到 stderr（实时可见性）
     *   4. error 立即触发 flush（数据安全性）
     *
     * @param level — 日志级别
     * @param message — 日志消息
     * @param args — 附加上下文数据
     */
    private log(level: LogLevel, message: string, args: unknown[]): void {
        // ─── 级别过滤 ───
        // 低于阈值的日志被静默丢弃
        if (LEVEL_VALUES[level] < LEVEL_VALUES[this.level]) return;

        // ─── 构建日志条目 ───
        const entry: LogEntry = {
            timestamp: new Date().toISOString(), // ISO 8601 统一时间格式
            level,
            message,
            args,
        };

        // ─── 实时输出到 stderr ───
        // warn 和 error 级别需要用户实时感知（警告和错误不能等到 5 秒后才看到）
        // 输出到 stderr 而非 stdout：避免与 LLM 响应流混淆
        const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]`;
        if (level === "error") {
            process.stderr.write(`${prefix} ${message}\n`);
        } else if (level === "warn") {
            process.stderr.write(`${prefix} ${message}\n`);
        }

        // ─── 写入内存缓冲区 ───
        this.buffer.push(entry);

        // ─── error 级别立即刷新 ───
        // 错误可能意味着后续操作失败甚至进程崩溃，立即落盘避免日志丢失
        if (level === "error") this.flush();
    }

    /**
     * 将日志条目批量写入文件
     *
     * 文件命名策略：
     *   按日期分割：y-claude-code-2024-01-15.log
     *   每天一个文件，方便管理和清理
     *
     * 写入策略：
     *   appendFileSync（同步追加）而非 writeFile（覆盖）
     *   原因：如果定时器在 5 秒内触发多次 flush，追加不会丢失历史日志
     *
     * 错误处理：
     *   日志写入失败不抛异常，不阻塞主流程
     *   原因：日志是辅助功能，不应因磁盘满/权限问题导致核心功能不可用
     *
     * @param entries — 要写入的日志条目批次
     */
    private writeToFile(entries: LogEntry[]): void {
        try {
            // 确保日志目录存在
            fs.mkdirSync(this.logDir, { recursive: true });

            // 按日期生成文件名（每天一个日志文件）
            const date = new Date().toISOString().slice(0, 10); // "2024-01-15"
            const filePath = path.join(this.logDir, `y-claude-code-${date}.log`);

            // 将日志条目序列化为行
            const lines = entries.map((e) =>
                `[${e.timestamp}] [${e.level.toUpperCase()}] ${e.message} ${e.args.length ? JSON.stringify(e.args) : ""}`
            );

            // 同步追加写入（避免与定时器和其他异步操作产生竞态）
            fs.appendFileSync(filePath, lines.join("\n") + "\n");
        } catch {
            // 日志写入失败不阻塞主流程
            // 可能的失败原因：磁盘满、权限不足、目录不存在
        }
    }
}

/**
 * 创建一个"空日志器"：除 error 外所有操作静默丢弃
 *
 * 使用场景：
 *   - 测试环境：不需要产生日志文件
 *   - 嵌入式/受限环境：无文件系统访问权限
 *   - 错误仍然输出到 stderr：确保关键问题不被完全隐藏
 *
 * @returns 一个简化的 Logger 实例
 */
export function createNoopLogger(): Logger {
    const logger = new Logger({ level: "error" });
    logger.setLevel("error"); // 仅保留 error 级别
    // debug/info/warn 被静默丢弃，error 仍输出到 stderr
    return logger;
}
