// ─── packages/core/src/observability/transcript.ts ───
// JSONL Transcript 记录器 — 将 Agent 运行全流程记录为结构化 JSONL 文件
// 解决问题: 支持对话回放、审计追溯、问题排查，每行一个 JSON 事件可流式解析

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { TranscriptEvent, TranscriptConfig } from "./types";

const DEFAULT_TRANSCRIPT_DIR = path.join(os.homedir(), ".y-claude-code", "transcripts");

/**
 * TranscriptWriter — JSONL 格式对话记录器
 * 解决问题: 将 Agent 的每个关键事件追加写入 JSONL 文件，
 *         支持调试回溯、性能分析和行为审计
 */
export class TranscriptWriter {
    private enabled: boolean;
    private dir: string;
    private sessionId: string = "";
    private filePath: string = "";

    constructor(config?: Partial<TranscriptConfig>) {
        this.enabled = config?.enabled ?? true;
        this.dir = config?.dir || DEFAULT_TRANSCRIPT_DIR;
    }

    /**
     * 开始新会话的记录 — 创建 JSONL 文件
     * @param sessionId - 会话唯一标识
     */
    startSession(sessionId: string): void {
        if (!this.enabled) return;

        this.sessionId = sessionId;
        // 确保目录存在
        if (!fs.existsSync(this.dir)) {
            fs.mkdirSync(this.dir, { recursive: true });
        }

        this.filePath = path.join(this.dir, `${sessionId}.jsonl`);
        // 创建新文件（覆盖已存在的同名文件）
        fs.writeFileSync(this.filePath, "");

        // 写入会话开始标记
        this.write({
            type: "turn:start",
            timestamp: new Date().toISOString(),
            session_id: sessionId,
            trace_id: "",
            payload: { event: "session_start" },
        });
    }

    /**
     * 记录一个事件
     * @param event - Transcript 事件
     */
    record(event: TranscriptEvent): void {
        if (!this.enabled || !this.filePath) return;
        this.write(event);
    }

    /**
     * 结束会话记录 — 写入结束标记
     */
    endSession(): void {
        if (!this.enabled || !this.filePath) return;

        this.write({
            type: "turn:end",
            timestamp: new Date().toISOString(),
            session_id: this.sessionId,
            trace_id: "",
            payload: { event: "session_end" },
        });

        this.filePath = "";
    }

    /**
     * 追加一行 JSON 到文件
     */
    private write(event: TranscriptEvent): void {
        if (!this.filePath) return;
        try {
            fs.appendFileSync(this.filePath, JSON.stringify(event) + "\n");
        } catch {
            // 写入失败静默处理，不阻塞主流程
        }
    }
}
