#!/usr/bin/env node
// ─── packages/cli/src/index.ts ───
// CLI 入口 — 命令行参数解析 → 启动初始化 → 输入处理循环
// 解决问题：原先所有逻辑集中在单文件 728 行，拆分为三个模块：
//   - utils/renderer.ts   — ANSI 颜色、Markdown 渲染、代码高亮、帮助文本
//   - utils/startup.ts    — Config/Provider/Sandbox/Tools/Permission 初始化
//   - utils/input-handler.ts — readline 设置、用户确认、消息路由

import { parseArgs, initialize, printStartupInfo, startAutoUpdateCheck, registerPlanApproval, registerPermissionPrompt } from "./utils/startup";
import { askYesNo, createProcessInput, startReadline } from "./utils/input-handler";
import { showHelp } from "./utils/renderer";

async function main(): Promise<void> {
    const args = parseArgs();

    if (args.help) { showHelp(); return; }
    if (args.version) { console.log("y-claude-code v0.1.0"); return; }

    // ─── 启动初始化 ───
    const { context: ctx, earlyExit } = await initialize(args);
    if (earlyExit) { process.exit(earlyExit.code); }
    if (!ctx) { process.exit(1); }

    const sessionId = ctx.sessionManager.getCurrent()?.id?.slice(0, 8) ?? "new";

    // ─── 审批回调注册（依赖 askYesNo）───
    registerPlanApproval((prompt: string) => askYesNo(prompt, ctx.spinnerState));
    registerPermissionPrompt(ctx.permissionManager, (prompt: string) => askYesNo(prompt, ctx.spinnerState));

    // ─── 启动信息 ───
    printStartupInfo(ctx.config, sessionId);
    startAutoUpdateCheck(ctx.config);

    // ─── 设置全局 app 引用（供 slash 命令访问配置）───
    (globalThis as Record<string, unknown>).__app = { config: ctx.config };

    // ─── 输入处理 + readline 循环 ───
    const processInput = createProcessInput(ctx);
    const rl = startReadline(processInput, () => {
        ctx.telemetry.trackSessionEnd(ctx.telemetrySid, {
            durationMs: Date.now() - ctx.sessionStartTime,
            messageCount: ctx.sessionMessageCount,
            toolCallCount: ctx.sessionToolCallCount,
            errorCount: ctx.sessionErrorCount,
        });
        ctx.telemetry.stop().catch(() => {});
        ctx.logger.info("会话结束");
        ctx.logger.destroy();
        ctx.cronScheduler.stop();
        process.exit(0);
    }, ctx.memoryStore);

    console.log(""); // 空行分隔启动信息和首个 prompt
    rl.prompt();
}

main().catch((error) => {
    console.error("启动失败:", error instanceof Error ? error.message : error);
    process.exit(1);
});
