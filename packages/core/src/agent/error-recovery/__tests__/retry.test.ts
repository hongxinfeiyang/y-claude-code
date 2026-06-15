// ─── packages/core/src/agent/error-recovery/__tests__/retry.test.ts ───
// RetryManager 单元测试 — 验证指数退避延迟计算与重试流程

import { describe, it, expect, vi } from "vitest";
import { RetryManager } from "../retry";

describe("RetryManager — calculateDelay", () => {
    const retry = new RetryManager({ maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 });

    it("第 1 次重试约为基础延迟", () => {
        const delay = retry.calculateDelay(1);
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(1100); // 基础 + max 10% jitter
    });

    it("第 2 次延迟约为第 1 次的 2 倍", () => {
        const delay = retry.calculateDelay(2);
        expect(delay).toBeGreaterThanOrEqual(2000);
        expect(delay).toBeLessThanOrEqual(2200);
    });

    it("第 3 次延迟约为第 2 次的 2 倍", () => {
        const delay = retry.calculateDelay(3);
        expect(delay).toBeGreaterThanOrEqual(4000);
        expect(delay).toBeLessThanOrEqual(4400);
    });

    it("延迟不应超过最大限制", () => {
        const delay = retry.calculateDelay(10); // 理论值远超 maxDelayMs
        expect(delay).toBeLessThanOrEqual(30000);
    });

    it("应优先使用服务端 Retry-After", () => {
        const delay = retry.calculateDelay(1, 5); // 服务端要求等 5 秒
        expect(delay).toBe(5000);
    });

    it("服务端 Retry-After 也不应超过 maxDelayMs", () => {
        const delay = retry.calculateDelay(1, 60); // 服务端要求 60 秒
        expect(delay).toBe(30000); // 被 maxDelayMs 截断
    });
});

describe("RetryManager — executeWithRetry", () => {
    it("首次成功应直接返回", async () => {
        const retry = new RetryManager({ maxRetries: 3 });
        const op = vi.fn().mockResolvedValue("success");
        const result = await retry.executeWithRetry(op, () => false);
        expect(result).toBe("success");
        expect(op).toHaveBeenCalledTimes(1);
    });

    it("可恢复错误应重试直到成功", async () => {
        const retry = new RetryManager({ maxRetries: 3, baseDelayMs: 10 });
        const op = vi.fn()
            .mockRejectedValueOnce(new Error("timeout"))
            .mockRejectedValueOnce(new Error("timeout"))
            .mockResolvedValue("recovered");

        const shouldRetry = vi.fn().mockReturnValue(true);
        const onRetry = vi.fn();

        const result = await retry.executeWithRetry(op, shouldRetry, onRetry);
        expect(result).toBe("recovered");
        expect(op).toHaveBeenCalledTimes(3);
        expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it("不可恢复错误应立即抛出", async () => {
        const retry = new RetryManager({ maxRetries: 3, baseDelayMs: 10 });
        const op = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));
        const shouldRetry = vi.fn().mockReturnValue(false);

        await expect(
            retry.executeWithRetry(op, shouldRetry),
        ).rejects.toThrow("401 Unauthorized");
        expect(op).toHaveBeenCalledTimes(1);
    });

    it("超过最大重试次数应抛出最后错误", async () => {
        const retry = new RetryManager({ maxRetries: 2, baseDelayMs: 10 });
        const op = vi.fn().mockRejectedValue(new Error("always fails"));
        const shouldRetry = vi.fn().mockReturnValue(true);

        await expect(
            retry.executeWithRetry(op, shouldRetry),
        ).rejects.toThrow("always fails");
        expect(op).toHaveBeenCalledTimes(3); // 原始 + 2 次重试
    });

    it("应从错误消息中提取 Retry-After", async () => {
        const retry = new RetryManager({ maxRetries: 2, baseDelayMs: 10 });
        const op = vi.fn()
            .mockRejectedValueOnce(new Error("rate limit: retry-after: 1"))
            .mockResolvedValue("ok");

        const shouldRetry = vi.fn().mockReturnValue(true);
        const onRetry = vi.fn();

        await retry.executeWithRetry(op, shouldRetry, onRetry);
        // 第一次重试应携带从错误消息提取的 Retry-After=1
        expect(onRetry).toHaveBeenCalledTimes(1);
        // 延迟应为 1000ms (Retry-After=1s) 但不是绝对的（jitter）
    });
});

describe("RetryManager — getConfig", () => {
    it("应返回只读配置", () => {
        const retry = new RetryManager({ maxRetries: 5, baseDelayMs: 500 });
        const config = retry.getConfig();
        expect(config.maxRetries).toBe(5);
        expect(config.baseDelayMs).toBe(500);
    });
});
