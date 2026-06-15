// ─── packages/core/src/agent/error-recovery/__tests__/circuit-breaker.test.ts ───
// CircuitBreakerManager 单元测试 — 验证熔断器状态机 CLOSED → OPEN → HALF_OPEN 流转

import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreakerManager, CircuitState } from "../circuit-breaker";

describe("CircuitBreakerManager", () => {
    let cb: CircuitBreakerManager;

    beforeEach(() => {
        cb = new CircuitBreakerManager({ failureThreshold: 3, windowMs: 60000, halfOpenMs: 30000 });
    });

    // ─── 初始状态 ───
    it("新熔断器应为 CLOSED 状态", () => {
        expect(cb.getState("Bash")).toBe(CircuitState.CLOSED);
    });

    it("beforeExecute 应在 CLOSED 状态下允许请求", () => {
        expect(cb.beforeExecute("Bash")).toBe(true);
    });

    // ─── 失败计数 → 熔断 ───
    it("累计失败达到阈值应触发熔断", () => {
        let tripped = false;
        tripped = cb.recordFailure("Bash"); // 1
        expect(tripped).toBe(false);
        tripped = cb.recordFailure("Bash"); // 2
        expect(tripped).toBe(false);
        tripped = cb.recordFailure("Bash"); // 3 → 触发
        expect(tripped).toBe(true);
        expect(cb.getState("Bash")).toBe(CircuitState.OPEN);
    });

    it("熔断后 beforeExecute 应拒绝请求", () => {
        // 触发熔断
        cb.recordFailure("Bash");
        cb.recordFailure("Bash");
        cb.recordFailure("Bash");
        expect(cb.beforeExecute("Bash")).toBe(false);
    });

    // ─── 记录成功 ───
    it("CLOSED 状态下记录成功不应影响状态", () => {
        cb.recordSuccess("Bash");
        expect(cb.getState("Bash")).toBe(CircuitState.CLOSED);
    });

    // ─── HALF_OPEN → 恢复或再次熔断 ───
    it("HALF_OPEN 下记录成功应回到 CLOSED", async () => {
        // 使用极短 halfOpenMs 来触发 HALF_OPEN
        const fastCb = new CircuitBreakerManager({ failureThreshold: 1, windowMs: 60000, halfOpenMs: 1 });
        fastCb.recordFailure("Read"); // 立即熔断

        await new Promise((r) => setTimeout(r, 5)); // 等待半开期
        expect(fastCb.beforeExecute("Read")).toBe(true); // HALF_OPEN 探测通过
        fastCb.recordSuccess("Read"); // 恢复
        expect(fastCb.getState("Read")).toBe(CircuitState.CLOSED);
    });

    it("HALF_OPEN 下记录失败应重新熔断", async () => {
        const fastCb = new CircuitBreakerManager({ failureThreshold: 1, windowMs: 60000, halfOpenMs: 1 });
        fastCb.recordFailure("Read");

        await new Promise((r) => setTimeout(r, 5));
        expect(fastCb.beforeExecute("Read")).toBe(true); // HALF_OPEN
        const tripped = fastCb.recordFailure("Read"); // 探测失败，重新熔断
        expect(tripped).toBe(true);
        expect(fastCb.getState("Read")).toBe(CircuitState.OPEN);
    });

    // ─── 不同工具独立熔断 ───
    it("不同工具的熔断器应互相独立", () => {
        // Bash 触发熔断
        cb.recordFailure("Bash");
        cb.recordFailure("Bash");
        cb.recordFailure("Bash");
        expect(cb.getState("Bash")).toBe(CircuitState.OPEN);
        // Read 仍处于 CLOSED
        expect(cb.getState("Read")).toBe(CircuitState.CLOSED);
        expect(cb.beforeExecute("Read")).toBe(true);
    });

    // ─── 重置 ───
    it("reset 应清除指定工具的熔断状态", () => {
        cb.recordFailure("Bash");
        cb.recordFailure("Bash");
        cb.recordFailure("Bash");
        expect(cb.getState("Bash")).toBe(CircuitState.OPEN);

        cb.reset("Bash");
        expect(cb.getState("Bash")).toBe(CircuitState.CLOSED);
        expect(cb.beforeExecute("Bash")).toBe(true);
    });

    it("resetAll 应清除所有熔断器", () => {
        cb.recordFailure("Bash");
        cb.recordFailure("Bash");
        cb.recordFailure("Bash");
        cb.recordFailure("Read");
        cb.recordFailure("Read");
        cb.recordFailure("Read");

        expect(cb.getState("Bash")).toBe(CircuitState.OPEN);
        expect(cb.getState("Read")).toBe(CircuitState.OPEN);

        cb.resetAll();
        expect(cb.getState("Bash")).toBe(CircuitState.CLOSED);
        expect(cb.getState("Read")).toBe(CircuitState.CLOSED);
    });

    // ─── getRemainingOpenMs ───
    it("getRemainingOpenMs 在 CLOSED 状态下应返回 0", () => {
        expect(cb.getRemainingOpenMs("Bash")).toBe(0);
    });

    it("getRemainingOpenMs 在 OPEN 状态下应返回正值", () => {
        cb.recordFailure("Bash");
        cb.recordFailure("Bash");
        cb.recordFailure("Bash");
        expect(cb.getRemainingOpenMs("Bash")).toBeGreaterThan(0);
    });

    // ─── 窗口过期：旧失败记录应被剔除 ───
    it("HALF_OPEN 超时后应允许探测调用", async () => {
        // 使用较短的 halfOpenMs 让熔断器在等待后进入 HALF_OPEN
        const fastCb = new CircuitBreakerManager({ failureThreshold: 1, windowMs: 60000, halfOpenMs: 10 });
        fastCb.recordFailure("Bash"); // 立即触发熔断
        expect(fastCb.getState("Bash")).toBe(CircuitState.OPEN);
        expect(fastCb.beforeExecute("Bash")).toBe(false); // 半开期未过，仍在 OPEN

        // 等待半开期过后（halfOpenMs=10，等待 20ms 确保过期）
        await new Promise((r) => setTimeout(r, 20));
        expect(fastCb.beforeExecute("Bash")).toBe(true); // HALF_OPEN 探测放行
    });
});

describe("CircuitBreakerManager — 自定义配置", () => {
    it("应使用自定义 failureThreshold", () => {
        const cb = new CircuitBreakerManager({ failureThreshold: 2 });
        cb.recordFailure("Bash");
        expect(cb.getState("Bash")).toBe(CircuitState.CLOSED);
        cb.recordFailure("Bash"); // 达到阈值 2
        expect(cb.getState("Bash")).toBe(CircuitState.OPEN);
    });
});
