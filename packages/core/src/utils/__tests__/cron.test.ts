// ─── packages/core/src/utils/__tests__/cron.test.ts ───
// CronScheduler 单元测试

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CronScheduler } from "../cron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("CronScheduler", () => {
    let scheduler: CronScheduler;
    let tmpDir: string;

    beforeEach(async () => {
        const fsp = await import("node:fs/promises");
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cron-test-"));
        scheduler = new CronScheduler(path.join(tmpDir, "scheduled_tasks.json"));
    });

    it("应能添加任务", () => {
        const job = scheduler.add({ cron: "*/5 * * * *", prompt: "test", recurring: true, durable: false });
        expect(job.id).toMatch(/^cron_\d+_[a-z0-9]{4}$/);
        expect(job.nextRun).toBeDefined();
        expect(scheduler.list()).toHaveLength(1);
    });

    it("应能删除任务", () => {
        const job = scheduler.add({ cron: "*/5 * * * *", prompt: "test", recurring: true, durable: false });
        expect(scheduler.remove(job.id)).toBe(true);
        expect(scheduler.list()).toHaveLength(0);
    });

    it("删除不存在任务应返回 false", () => {
        expect(scheduler.remove("nonexistent")).toBe(false);
    });

    it("durable 任务应持久化", () => {
        const job = scheduler.add({ cron: "0 9 * * *", prompt: "daily", recurring: true, durable: true });
        // 手动触发持久化
        const filePath = path.join(tmpDir, "scheduled_tasks.json");
        expect(fs.existsSync(filePath)).toBe(true);

        const raw = fs.readFileSync(filePath, "utf-8");
        const jobs = JSON.parse(raw);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].id).toBe(job.id);
    });

    it("get 应返回已注册任务", () => {
        const job = scheduler.add({ cron: "*/10 * * * *", prompt: "check", recurring: true, durable: false });
        const found = scheduler.get(job.id);
        expect(found).toBeDefined();
        expect(found?.prompt).toBe("check");
    });

    it("一次性任务触发后应自动删除", () => {
        const now = new Date();
        // 设置为 1 分钟前应已到期
        const job = scheduler.add({
            cron: `${now.getMinutes()} ${now.getHours()} * * *`,
            prompt: "一次性",
            recurring: false,
            durable: false,
        });
        // 手动设置 nextRun 为过去
        (scheduler as unknown as { jobs: Map<string, { nextRun: string }> }).jobs.get(job.id)!.nextRun = new Date(now.getTime() - 60_000).toISOString();

        // 启动 → tick 会立即触发
        let triggered = false;
        scheduler.start((j) => { triggered = true; });

        // 等待 tick
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                scheduler.stop();
                expect(triggered).toBe(true);
                expect(scheduler.list()).toHaveLength(0);
                resolve();
            }, 35_000); // 等待 30 秒 tick + 5 秒缓冲
        }).finally(() => scheduler.stop());
    }, 40_000);
});
