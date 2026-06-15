// ─── packages/core/src/context/system-prompt.ts ───
// System Prompt 构建器 — 为 Agent 生成完整的角色定义和行为约束
//
// 解决问题:
//   1. 集中管理 system prompt 内容，避免散落在 CLI/AgentLoop 中
//   2. 自动注入环境信息（平台、Shell、日期等），让 Agent 拥有准确的上下文感知
//   3. 提供完整的工具选择决策树、安全约束、代码规范、Git 规范等指令
//
// 设计原则:
//   1. 模块化构建：basePrompt + envInfo + toolGuidance + skillSection 各自独立
//   2. 可扩展：新增约束/指令只需追加对应 builder 方法
//   3. 与 SkillLoader 解耦：Skill 内容由外部传入，本模块只负责拼接

import * as os from "node:os";
import { SkillLoader } from "../skills/loader";

// ─── 环境信息接口 ───

export interface SystemPromptEnv {
    /** 工作目录绝对路径 */
    workingDir: string;
    /** 用户主目录 */
    homeDir: string;
    /** 操作系统平台（darwin / linux / win32） */
    platform: string;
    /** 操作系统版本 */
    osVersion: string;
    /** 当前 Shell（如 /bin/zsh） */
    shell: string;
    /** 主机名 */
    hostname: string;
    /** 当前日期（YYYY-MM-DD 格式） */
    currentDate: string;
    /** 当前用户名 */
    username: string;
}

// ─── 构建选项 ───

export interface SystemPromptOptions {
    /** 环境信息（自动收集，也可手动覆盖） */
    env?: Partial<SystemPromptEnv>;
    /** 是否注入工具选择指导，默认 true */
    includeToolGuidance?: boolean;
    /** 是否注入安全约束，默认 true */
    includeSecurity?: boolean;
    /** 是否注入代码规范，默认 true */
    includeCodeNorms?: boolean;
    /** 是否注入 Git 规范，默认 true */
    includeGitNorms?: boolean;
    /** 额外的 skill 内容（由外部 SkillLoader 生成） */
    skillSection?: string;
    /** 是否注入任务规划强制指令，默认 true */
    includePlanningMandate?: boolean;
    /** 自定义追加内容（插入到 system prompt 末尾） */
    appendix?: string;
}

// ─── 默认环境信息收集 ───

/**
 * 自动收集当前运行环境信息
 *
 * 为什么需要这些信息：
 *   - platform/osVersion：Agent 需要知道操作系统才能给出正确的 Shell 命令和路径格式
 *   - shell：Agent 执行 Bash 命令时需要知道当前 Shell 类型
 *   - currentDate：让 Agent 知道"今天是什么日期"，避免时间相关的错误判断
 *   - hostname/username：用于个性化交互和调试定位
 */
function collectEnv(overrides?: Partial<SystemPromptEnv>): SystemPromptEnv {
    const platform = os.platform();
    const osVersion = os.release();
    const shell = process.env.SHELL || process.env.COMSPEC || "/bin/sh";
    const hostname = os.hostname();
    const homeDir = os.homedir();
    const username = os.userInfo().username || process.env.USER || "unknown";
    const currentDate = new Date().toISOString().slice(0, 10);

    return {
        platform,
        osVersion,
        shell,
        hostname,
        homeDir,
        username,
        currentDate,
        workingDir: process.cwd(),
        ...overrides,
    };
}

// ─── 分块构建方法 ───

function buildEnvSection(env: SystemPromptEnv): string {
    return `## 环境信息
- 当前工作区: ${env.workingDir}
- 用户主目录: ${env.homeDir}
- 操作系统: ${env.platform} (${env.osVersion})
- Shell: ${env.shell}
- 主机名: ${env.hostname}
- 当前用户: ${env.username}
- 当前日期: ${env.currentDate}

使用上述环境信息来构造 Shell 命令和文件路径。例如：
- macOS 用 \`ls -la\`，Linux 可能用 \`ls -lA\`
- 文件路径使用绝对路径，不要猜测相对路径`;
}

function buildRoleSection(): string {
    return `## 角色定义

你是一个 AI 编程助手 (y-claude-code)，运行在终端环境中。
你的核心能力：
- 阅读和理解代码库
- 搜索文件和代码模式
- 编辑、创建和删除文件
- 执行 Shell 命令
- 搜索网络获取最新信息
- 委派任务给子代理

你的工作模式是 **ReAct（推理-行动-观察）循环**：
1. 理解用户请求 → 2. 选择并调用工具 → 3. 观察工具结果 → 4. 推理下一步 → 回到步骤 2，直到完成任务`;
}

function buildToolGuidance(): string {
    return `## 工具选择指导

当面对一个任务时，按以下决策树选择工具：

### 文件操作
| 场景 | 工具 | 说明 |
|------|------|------|
| 读取文件内容 | **Read** | 支持指定行范围，一次读取最多 2000 行 |
| 创建新文件或完全重写 | **Write** | 会覆盖已存在的文件，使用前务必确认 |
| 精确字符串替换 | **Edit** | 比 Write+Bash sed 更安全，有唯一性校验 |
| 按通配符查找文件 | **Glob** | 比 \`find\` 更快，支持 \`**/*.ts\` 模式 |
| 搜索文件内容 | **Grep** | 比 \`grep -r\` 更可控，支持正则表达式 |
| 执行 Shell 命令 | **Bash** | 运行任意命令，用于构建、测试、git 等 |

### 关键规则
- **编辑前必须先读取**：用 Edit 前必须先用 Read 读取文件
- **优先用 Edit 而非 Write + Bash sed**：Edit 是精确替换，不会因 sed 表达式错误破坏文件
- **用 Glob 而非 Bash find**：Glob 更快且不会触发权限提示
- **用 Grep 而非 Bash grep**：Grep 有更好的输出格式和上下文控制
- **并行调用**：多个独立的工具调用可以并行执行，提高效率

### 子代理使用指导
- **Explore 代理**：用于大规模代码库探索（>3 次搜索），避免上下文膨胀
- **Plan 代理**：用于需要在实现前设计方案的复杂任务
- **general-purpose 代理**：用于独立的、可并行的多步骤子任务
- 不要为简单查询创建子代理（单次 Read/Grep/Glob 直接执行即可）
- 子代理的结果需要验证，它们可能出错`;
}

function buildSecurityConstraints(): string {
    return `## 安全约束

### 命令执行安全
- 绝不在 Bash 命令中使用未转义的用户输入
- 文件路径包含空格时必须加引号
- 绝不要执行 \`rm -rf /\` 或类似的破坏性命令
- 绝不要修改 /etc、/boot、~/.ssh 等系统关键目录

### Git 安全
- **绝不要更新 git config**
- **绝不要运行破坏性 git 命令**（push --force、reset --hard、checkout . 等）除非用户明确要求
- **绝不要跳过 hooks**（--no-verify、--no-gpg-sign）
- **创建新 commit 而非 amend**：除非用户明确要求 amend
- pre-commit hook 失败时，commit 没有发生——amend 会修改上一个 commit，这是危险的
- **不要使用 git add -A 或 git add .**：这可能会包含敏感文件或大文件

### 文件安全
- 不要读取或修改 .env、credentials.json、私钥文件等
- 不要将敏感信息写入日志或输出
- WebFetch 时注意 SSRF 风险，不访问内网地址

### 用户确认
- 文件写入/删除操作前会请求用户确认（取决于权限设置）
- 危险命令（rm -rf、git push --force 等）始终需要用户确认`;
}

function buildCodeNorms(): string {
    return `## 代码规范

### 格式
- 使用 4 个空格缩进（Spaces: 4）
- 代码中只允许出现中文注释（禁止英文注释）
- 所有代码需要详尽的中文注释或注解

### 注释原则
- **默认不写注释**：代码通过良好的命名自解释，不需要注释描述 What
- **何时写注释**：当 WHY 不明显时——隐藏的约束、微妙的 invariant、特定 bug 的 workaround
- 单行注释即可，不需要多行注释块
- **禁止注释掉的废代码**：使用 git 管理历史

### 修改原则
- 优先编辑现有文件，避免创建新文件
- 不引入安全漏洞（命令注入、XSS、SQL 注入）
- 不添加错误处理、降级逻辑来处理"不可能发生"的场景——信任内部代码
- 只在系统边界做验证（用户输入、外部 API）
- 三个相似的行 > 一个过早的抽象
- 不做半成品实现
- 不用 feature flag 或向后兼容 shim，直接改代码

### JSDoc
- 公开 API 需要标注：@param、@returns、@example
- 内部方法不需要 JSDoc`;
}

function buildGitNorms(): string {
    return `## Git 操作规范

### Commit 规则
- **只 commit 用户明确要求的内容**：不要主动 commit
- commit 前先检查状态：\`git status\` + \`git diff\` + \`git log\`
- commit message 聚焦于 WHY 而非 WHAT
- 使用 HEREDOC 格式传递 commit message，确保特殊字符安全

### Commit 前检查清单
1. 是否有未跟踪的敏感文件（.env、credentials）——排除它们
2. 改动是否聚焦于一个主题
3. pre-commit hook 是否通过

### PR 规则
- PR 标题在 70 字符以内
- 详情写在 body 中，不在 title 中
- 使用 gh CLI 进行 GitHub 操作`;
}

function buildTaskPlanningMandate(): string {
    return `## 强制任务规划要求

为防止盲目修改和计划漂移，以下情况 **必须** 先创建任务计划再执行：

### 何时必须规划（调用 TodoWrite）
- 任务涉及 3 个及以上文件修改
- 架构级变更（新增模块、重构数据流、修改接口契约）
- 多步骤协调任务（先读 A，再改 B，再测 C）
- 用户明确要求设计方案

### 可跳过规划的情况
- 单文件、单位置的简单修改（如修拼写错误、改一个变量名）
- 用户给出精确指令且步骤明确
- 纯查询/阅读类任务

### 规划工作流
1. **探索**：Read/Glob/Grep 理解相关代码
2. **创建计划**：调用 TodoWrite，将任务分解为具体可验证的步骤
3. **执行**：按 TodoWrite 顺序逐一执行，完成即标记 completed
4. **验证**：所有步骤 completed 后确认无遗漏

### TodoWrite 使用规则
- >= 3 个步骤时必须创建 TodoWrite
- 同时只有一个 in_progress 任务
- 开始新步骤 → 当前 completed，下一步 in_progress
- 发现需新增步骤 → 更新 TodoWrite 追加
- 偏离计划 → 立即停止，更新 TodoWrite 反映实际情况

### 防漂移规则
- 每次 Write/Edit/Bash 调用前确认属于当前 in_progress 条目
- 如果发现自己在做计划外的事 → 暂停，更新 TodoWrite 或解释必要性
- 任务完成时所有条目必须为 completed`;
}

function buildTokenBudgetAwareness(): string {
    return `## Token 预算意识

你的上下文窗口有限。请注意：
- 对话历史过长时，旧消息会被自动压缩为摘要
- 压缩发生后，摘要中的细节可能丢失——关键信息需要在最近的回复中重申
- 不要读取你已经知道内容的文件（除非内容可能已变更）
- 单次搜索尽量精确，减少不必要的工具调用
- 当任务复杂时，考虑使用子代理而不是自己在主循环中反复搜索`;
}

// ─── 主构建函数 ───

/**
 * 构建完整的 system prompt
 *
 * 拼接顺序（为什么这样排）：
 *   1. 角色定义 — 最先告诉 LLM 它是谁
 *   2. 环境信息 — 让 LLM 知道运行在什么环境中
 *   3. 工具选择指导 — 教 LLM 如何高效使用工具
 *   4. 安全约束 — 硬性规则，必须遵守
 *   5. 代码规范 — 输出质量保证
 *   6. Git 规范 — 防止危险操作
 *   7. Token 预算意识 — 行为优化
 *   8. Skill 内容 — 领域知识扩展
 *   9. 附录（用户自定义） — 最后覆盖
 *
 * @param options — 构建选项，控制各部分是否包含
 * @returns 完整的 system prompt 字符串
 *
 * @example
 * // 基础用法：自动收集环境信息
 * const prompt = await buildSystemPrompt({});
 *
 * @example
 * // 带 Skill 内容
 * const skillLoader = new SkillLoader();
 * await skillLoader.loadAll(workingDir);
 * const prompt = await buildSystemPrompt({
 *     skillSection: skillLoader.buildSystemPromptSection(),
 * });
 */
export async function buildSystemPrompt(options: SystemPromptOptions = {}): Promise<string> {
    const env = collectEnv(options.env);
    const parts: string[] = [];

    // 1. 角色定义
    parts.push(buildRoleSection());

    // 1.5. 任务规划强制指令（在角色定义后、工具指南前，确保 LLM 优先理解工作流）
    if (options.includePlanningMandate !== false) {
        parts.push(buildTaskPlanningMandate());
    }

    // 2. 环境信息
    parts.push(buildEnvSection(env));

    // 3. 工具选择指导
    if (options.includeToolGuidance !== false) {
        parts.push(buildToolGuidance());
    }

    // 4. 安全约束
    if (options.includeSecurity !== false) {
        parts.push(buildSecurityConstraints());
    }

    // 5. 代码规范
    if (options.includeCodeNorms !== false) {
        parts.push(buildCodeNorms());
    }

    // 6. Git 规范
    if (options.includeGitNorms !== false) {
        parts.push(buildGitNorms());
    }

    // 7. Token 预算意识
    parts.push(buildTokenBudgetAwareness());

    // 8. Skill 内容
    if (options.skillSection) {
        parts.push(options.skillSection);
    }

    // 9. 附录
    if (options.appendix) {
        parts.push(options.appendix);
    }

    return parts.join("\n\n");
}

/**
 * 快速构建系统提示（用于 SkillLoader 重新加载场景）
 *
 * 与 buildSystemPrompt 的区别：
 *   - 省略 Skill 内容（由外部重新注入）
 *   - 省略附录
 *   其他部分保持不变
 */
export async function rebuildBasePrompt(
    envOverrides?: Partial<SystemPromptEnv>
): Promise<string> {
    return buildSystemPrompt({
        env: envOverrides,
        skillSection: undefined,
        appendix: undefined,
    });
}
