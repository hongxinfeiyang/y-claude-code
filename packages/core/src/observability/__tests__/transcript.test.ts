// ─── packages/core/src/observability/__tests__/transcript.test.ts ───
// TranscriptWriter 单元测试

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TranscriptWriter } from "../transcript";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("TranscriptWriter", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-test-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("startSession 后 endSession 应写入开始和结束事件", () => {
        const writer = new TranscriptWriter({ enabled: true, dir: tmpDir });
        writer.startSession("test-session-1");

        // WriteStream 异步创建文件，操作完成后用 endSession 刷盘
        writer.endSession();

        const filePath = path.join(tmpDir, "test-session-1.jsonl");
        expect(fs.existsSync(filePath)).toBe(true);

        const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).type).toBe("turn:start");
        expect(JSON.parse(lines[0]).session_id).toBe("test-session-1");
        expect(JSON.parse(lines[1]).type).toBe("turn:end");
    });

    it("record 应在 start 和 end 之间追加事件", () => {
        const writer = new TranscriptWriter({ enabled: true, dir: tmpDir });
        writer.startSession("test-session-2");

        writer.record({
            type: "tool:call",
            timestamp: new Date().toISOString(),
            session_id: "test-session-2",
            trace_id: "trace-1",
            span_id: "span-1",
            payload: { tool_name: "Read", params: { file_path: "/tmp/test" } },
        });

        writer.endSession();

        const filePath = path.join(tmpDir, "test-session-2.jsonl");
        const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
        expect(lines).toHaveLength(3); // start + tool:call + end
        const toolEvent = JSON.parse(lines[1]);
        expect(toolEvent.type).toBe("tool:call");
        expect(toolEvent.payload.tool_name).toBe("Read");
    });

    it("disabled 时应跳过所有操作且不创建文件", () => {
        const writer = new TranscriptWriter({ enabled: false, dir: tmpDir });
        writer.startSession("should-not-exist");
        writer.record({
            type: "tool:call",
            timestamp: "",
            session_id: "",
            trace_id: "",
            payload: {},
        });
        writer.endSession();

        // 文件不应存在
        const filePath = path.join(tmpDir, "should-not-exist.jsonl");
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it("应自动创建不存在的目录", () => {
        const nestedDir = path.join(tmpDir, "nested", "transcripts");
        const writer = new TranscriptWriter({ enabled: true, dir: nestedDir });
        writer.startSession("auto-dir");
        writer.endSession();

        const filePath = path.join(nestedDir, "auto-dir.jsonl");
        expect(fs.existsSync(filePath)).toBe(true);
    });
});
