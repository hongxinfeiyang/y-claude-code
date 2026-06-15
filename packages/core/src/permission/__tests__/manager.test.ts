// ─── packages/core/src/permission/__tests__/manager.test.ts ───
// PermissionManager 单元测试

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PermissionManager } from "../manager";
import type { ToolUse } from "../../types/messages";

function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUse {
    return { id: "1", name, input };
}

describe("PermissionManager", () => {
    let pm: PermissionManager;

    beforeEach(() => {
        pm = new PermissionManager("ask");
    });

    // ─── 默认模式 ───
    it("defaultMode=ask 且无回调时应拒绝", async () => {
        const result = await pm.check(makeToolUse("Read"));
        expect(result).toBe(false);
    });

    it("defaultMode=allow 应直接允许", async () => {
        const allowPm = new PermissionManager("allow");
        expect(await allowPm.check(makeToolUse("Read"))).toBe(true);
    });

    it("defaultMode=deny 应直接拒绝", async () => {
        const denyPm = new PermissionManager("deny");
        expect(await denyPm.check(makeToolUse("Bash"))).toBe(false);
    });

    // ─── 规则匹配 ───
    it("匹配到 allow 规则应直接允许", async () => {
        pm.loadRules([{ toolPattern: "Read", action: "allow", scope: "project" }]);
        expect(await pm.check(makeToolUse("Read"))).toBe(true);
    });

    it("匹配到 deny 规则应直接拒绝", async () => {
        pm.loadRules([{ toolPattern: "Bash", action: "deny", scope: "project" }]);
        expect(await pm.check(makeToolUse("Bash"))).toBe(false);
    });

    it("规则作用域优先级: session > project", async () => {
        pm.loadRules([
            { toolPattern: "Read", action: "deny", scope: "project" },
            { toolPattern: "Read", action: "allow", scope: "session" },
        ]);
        // session 优先于 project
        expect(await pm.check(makeToolUse("Read"))).toBe(true);
    });

    it("glob 通配符应生效", async () => {
        pm.loadRules([{ toolPattern: "Web*", action: "allow", scope: "project" }]);
        expect(await pm.check(makeToolUse("WebFetch"))).toBe(true);
        expect(await pm.check(makeToolUse("WebSearch"))).toBe(true);
    });

    // ─── Session 缓存 ───
    it("remember session 后 check 应返回缓存值", async () => {
        pm.remember(makeToolUse("Read"), "allow", "session");
        // defaultMode=ask 本应拒绝，但缓存优先
        expect(await pm.check(makeToolUse("Read"))).toBe(true);
    });

    it("forceRecheck=true 应忽略缓存", async () => {
        pm.remember(makeToolUse("Read"), "allow", "session");
        // forceRecheck 绕过缓存，defaultMode=ask → 无回调 → false
        expect(await pm.check(makeToolUse("Read"), true)).toBe(false);
    });

    // ─── 回调 ───
    it("注入回调后 ask 应触发回调", async () => {
        const callback = vi.fn().mockResolvedValue(true);
        pm.setPromptCallback(callback);
        const result = await pm.check(makeToolUse("Bash"));
        expect(callback).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    // ─── 权限级别 ───
    it("应返回正确的权限级别", () => {
        expect(pm.getPermissionLevel("Read")).toBe("readonly");
        expect(pm.getPermissionLevel("Bash")).toBe("exec");
        expect(pm.getPermissionLevel("Agent")).toBe("all");
        expect(pm.getPermissionLevel("Unknown")).toBe("all");
    });

    // ─── 边界场景 ───

    it("多条规则应匹配第一条（按注册顺序）", async () => {
        pm.loadRules([
            { toolPattern: "Read", action: "allow", scope: "project" },
            { toolPattern: "Read", action: "deny", scope: "project" },
        ]);
        // 第一条 allow 命中即返回
        expect(await pm.check(makeToolUse("Read"))).toBe(true);
    });

    it("无匹配规则时应回退到 defaultMode", async () => {
        // 注册一条不匹配的规则
        pm.loadRules([{ toolPattern: "Bash", action: "allow", scope: "project" }]);
        // Read 不匹配 Bash 规则 → 回退到 defaultMode=ask → 无回调 → false
        expect(await pm.check(makeToolUse("Read"))).toBe(false);
    });

    it("clearSessionCache 后缓存应清空", async () => {
        pm.remember(makeToolUse("Read"), "allow", "session");
        expect(await pm.check(makeToolUse("Read"))).toBe(true);

        pm.clearSessionCache();
        // 缓存清空后 defaultMode=ask → 无回调 → false
        expect(await pm.check(makeToolUse("Read"))).toBe(false);
    });

    it("deny 缓存优先于 allow 规则", async () => {
        pm.loadRules([{ toolPattern: "Read", action: "allow", scope: "project" }]);
        // 注入 deny 缓存
        pm.remember(makeToolUse("Read"), "deny", "session");
        expect(await pm.check(makeToolUse("Read"))).toBe(false);
    });

    it("特殊工具应默认受限", async () => {
        // Bash / Write / Edit 等危险操作在 ask 模式下应受限
        const restrictedPm = new PermissionManager("ask");
        // Agent 工具也需要审批
        expect(await restrictedPm.check(makeToolUse("Agent"))).toBe(false);
    });

    it("persistRules 应正常返回", async () => {
        pm.loadRules([{ toolPattern: "Read", action: "allow", scope: "project" }]);
        // persistRules 需要 workingDirectory 参数
        await expect(pm.persistRules("/tmp/test-project")).resolves.toBeUndefined();
    });

    it("不同工具调用应有独立缓存", async () => {
        pm.remember(makeToolUse("Read"), "allow", "session");
        pm.remember(makeToolUse("Bash"), "deny", "session");

        expect(await pm.check(makeToolUse("Read"))).toBe(true);
        expect(await pm.check(makeToolUse("Bash"))).toBe(false);
    });
});
