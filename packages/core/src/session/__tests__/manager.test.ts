// ─── packages/core/src/session/__tests__/manager.test.ts ───
// SessionManager + FileSessionStore 单元测试

import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager, FileSessionStore } from "../manager";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("FileSessionStore", () => {
    let store: FileSessionStore;
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-test-"));
        store = new FileSessionStore(tmpDir);
    });

    it("空目录下列表应为空", async () => {
        const sessions = await store.list();
        expect(sessions).toHaveLength(0);
    });

    it("不存在的会话加载应返回 null", async () => {
        const session = await store.load("nonexistent");
        expect(session).toBeNull();
    });

    it("保存后能正确加载", async () => {
        const data = {
            id: "test-1",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
            messages: [{ role: "user" as const, content: "hello" }],
            tokenUsage: { inputTokens: 100, outputTokens: 50 },
            workingDirectory: "/project",
            model: "gpt-4o",
            metadata: {},
        };
        await store.save(data);
        const loaded = await store.load("test-1");
        expect(loaded).not.toBeNull();
        expect(loaded?.id).toBe("test-1");
        expect(loaded?.messages).toHaveLength(1);
    });

    it("保存后列表中能出现", async () => {
        await store.save({
            id: "s1",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
            messages: [{ role: "user", content: "hello world this is a test message" }],
            tokenUsage: { inputTokens: 10, outputTokens: 5 },
            workingDirectory: "/p",
            model: "m",
            metadata: {},
        });
        const sessions = await store.list();
        expect(sessions.length).toBeGreaterThan(0);
    });

    it("删除后再加载应为 null", async () => {
        await store.save({
            id: "to-delete",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
            messages: [],
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            workingDirectory: "/p",
            model: "m",
            metadata: {},
        });
        await store.delete("to-delete");
        expect(await store.load("to-delete")).toBeNull();
    });

    it("删除不存在会话不应报错", async () => {
        await expect(store.delete("nonexistent")).resolves.not.toThrow();
    });
});

describe("SessionManager", () => {
    let sm: SessionManager;

    beforeEach(() => {
        sm = new SessionManager();
    });

    it("create 应返回新的 SessionData", () => {
        const session = sm.create("/project", "gpt-4o");
        expect(session.id).toBeDefined();
        expect(session.workingDirectory).toBe("/project");
        expect(session.model).toBe("gpt-4o");
        expect(session.messages).toHaveLength(0);
    });

    it("无活跃会话时 appendMessage 应报错", async () => {
        await expect(sm.appendMessage({ role: "user", content: "hi" })).rejects.toThrow("无活跃会话");
    });

    it("恢复不存在会话应报错", async () => {
        await expect(sm.resume("nonexistent")).rejects.toThrow("不存在");
    });
});
