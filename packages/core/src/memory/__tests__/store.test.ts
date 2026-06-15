// ─── packages/core/src/memory/__tests__/store.test.ts ───
// MemoryStore 单元测试

import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "../store";
import type { MemoryEntry } from "../types";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("MemoryStore", () => {
    let store: MemoryStore;
    let testDir: string;
    let memoryEntry: MemoryEntry;

    beforeEach(async () => {
        testDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-test-"));
        store = new MemoryStore(testDir);
        store.setProjectRoot(testDir);

        memoryEntry = {
            name: "test-memory",
            description: "测试记忆条目",
            type: "user",
            content: "这是测试内容。关联 [[other-memory]]",
            related: ["other-memory"],
            updatedAt: new Date().toISOString(),
        };
    });

    // ─── 读取 ───
    it("空目录应返回空索引", async () => {
        const index = await store.loadIndex("project");
        expect(index).toHaveLength(0);
    });

    it("不存在文件应返回 null", async () => {
        const entry = await store.load("nonexistent", "project");
        expect(entry).toBeNull();
    });

    // ─── 写入 ───
    it("save 应创建文件和更新索引", async () => {
        await store.save(memoryEntry, "project");

        // 验证文件存在
        const filePath = path.join(testDir, ".y-claude", "memory", "test-memory.md");
        const content = await fs.readFile(filePath, "utf-8");
        expect(content).toContain("测试记忆条目");
        expect(content).toContain("[[other-memory]]");

        // 验证索引
        const index = await store.loadIndex("project");
        expect(index).toContainEqual(
            expect.objectContaining({ title: "test-memory" }),
        );
    });

    it("应能加载刚保存的记忆", async () => {
        await store.save(memoryEntry, "project");
        const loaded = await store.load("test-memory", "project");
        expect(loaded).not.toBeNull();
        expect(loaded?.name).toBe("test-memory");
        expect(loaded?.content).toContain("测试内容");
        expect(loaded?.related).toContain("other-memory");
    });

    // ─── 删除 ───
    it("remove 应删除文件和索引条目", async () => {
        await store.save(memoryEntry, "project");
        await store.remove("test-memory", "project");

        const loaded = await store.load("test-memory", "project");
        expect(loaded).toBeNull();
    });

    // ─── 搜索 ───
    it("search 应按关键词找到匹配记忆", async () => {
        await store.save(memoryEntry, "project");
        const results = await store.search("测试内容");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toBe("test-memory");
    });

    it("search 无匹配应返回空数组", async () => {
        const results = await store.search("不存在的内容");
        expect(results).toHaveLength(0);
    });

    // ─── loadAll ───
    it("loadAll 应加载所有记忆", async () => {
        await store.save(memoryEntry, "project");
        const second: MemoryEntry = {
            name: "second",
            description: "第二条",
            type: "project",
            content: "第二条内容",
            related: [],
            updatedAt: new Date().toISOString(),
        };
        await store.save(second, "project");

        const all = await store.loadAll("project");
        expect(all.length).toBeGreaterThanOrEqual(2);
    });
});
