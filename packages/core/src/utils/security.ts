/**
 * utils/security.ts — 安全模块
 *
 * 【是什么】
 *   提供三层安全防护：输入净化（sanitizeInput）、输出过滤（sanitizeOutput）、
 *   路径安全校验（isPathSafe）。保护 AI 编程助手免受恶意输入攻击和
 *   敏感信息泄露。
 *
 * 【解决什么问题】
 *   1. Prompt Injection 防护：检测用户输入中是否包含试图覆盖 AI 指令的
 *      恶意模式（如 "ignore all previous instructions"），根据严重程度
 *      警告或直接阻止。
 *   2. 输入净化：移除控制字符（可能用于终端逃逸）和 Unicode 混淆字符
 *      （零宽字符等），防止视觉欺骗和注入攻击。
 *   3. 输出过滤：检测并脱敏 API 响应中的敏感信息（API Key、私钥、邮箱等），
 *      防止 LLM 在其输出中意外泄露凭据。
 *   4. 路径安全：确保 AI 请求的文件操作不超出工作目录范围，
 *      并允许访问 .y-claude-code 内部文件（配置/缓存/日志）。
 */

/**
 * SENSITIVE_PATTERNS — 敏感信息正则模式集合
 *
 * 用途：输出过滤 — 在 LLM 响应展示给用户前，扫描并脱敏敏感信息。
 *
 * 为什么需要输出过滤：
 *   - LLM 的训练数据可能包含代码仓库中的 API Key、私钥等
 *   - LLM 可能在回答问题时不慎输出训练数据中的敏感信息
 *   - 这是一种防御性措施，即使 API 提供商已做过滤，本地再加一层保护
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string; label: string }> = [
    {
        pattern: /sk-[a-zA-Z0-9\-]{32,}/g,
        replacement: "sk-***[REDACTED]",
        label: "API Key",
    },
    {
        pattern: /Bearer\s+[a-zA-Z0-9\-_.=]{20,}/g,
        replacement: "Bearer ***[REDACTED]",
        label: "Bearer Token",
    },
    {
        pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
        replacement: "***[PRIVATE KEY REDACTED]",
        label: "Private Key",
    },
    {
        pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        replacement: "***@***.***",
        label: "Email",
    },
    {
        pattern: /AKIA[0-9A-Z]{16}/g,
        replacement: "AKIA***[REDACTED]",
        label: "AWS Access Key",
    },
    {
        pattern: /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g,
        replacement: "***[JWT REDACTED]",
        label: "JWT Token",
    },
    {
        pattern: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^@\s]+@[^\s]+/g,
        replacement: "***[DB CONNECTION REDACTED]",
        label: "Database Connection String",
    },
    {
        pattern: /ghp_[a-zA-Z0-9]{36}/g,
        replacement: "ghp_***[REDACTED]",
        label: "GitHub Personal Access Token",
    },
    {
        pattern: /github_pat_[a-zA-Z0-9_]{40,}/g,
        replacement: "github_pat_***[REDACTED]",
        label: "GitHub Fine-grained Token",
    },
];

/**
 * INJECTION_PATTERNS — Prompt Injection 检测模式
 *
 * severity 分类：
 *   - "block"：明确的攻击意图，直接拒绝处理
 *     （如 "ignore previous instructions"、"you are now DAN"）
 *   - "warn"：可疑但不一定恶意，生成警告但允许继续
 *     （如 "system: you are"、"[[system]]"）
 *
 * 为什么这些模式被检测：
 *   - 它们是已知的 Prompt Injection 攻击手法
 *   - 攻击者试图让 AI 忽略安全约束或扮演恶意角色
 *   - 检测不区分大小写，增加覆盖面
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: "warn" | "block" }> = [
    {
        pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i,
        severity: "block",
    },
    {
        pattern: /forget\s+(all\s+)?(previous|your)\s+(instructions|training|prompt)/i,
        severity: "block",
    },
    {
        pattern: /you\s+are\s+now\s+(DAN|jailbroken|a\s+different\s+(AI|model|assistant))/i,
        severity: "block",
    },
    {
        pattern: /disregard\s+(all\s+)?(previous|above)\s+(context|instructions|rules)/i,
        severity: "block",
    },
    {
        pattern: /pretend\s+(you\s+are|to\s+be)\s+(a|an)\s+(different|evil|malicious|unfiltered)/i,
        severity: "block",
    },
    {
        pattern: /<\|im_start\|>|<\|im_end\|>/i,
        severity: "block",
    },
    {
        pattern: /\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>/i,
        severity: "block",
    },
    {
        pattern: /system:\s*you\s+are/i,
        severity: "warn",
    },
    {
        pattern: /\[system\]|\[assistant\]|\[user\]/i,
        severity: "warn",
    },
    {
        pattern: /<system>|<\/system>|<user>|<\/user>|<assistant>|<\/assistant>/i,
        severity: "warn",
    },
];

/**
 * CONTROL_CHARS — 控制字符正则（保留 \n 和 \t）
 *
 * 移除范围：\x00-\x08（NULL 到 Backspace）、\x0B-\x0C（VT、FF）、
 *          \x0E-\x1F（SO 到 US）、\x7F（DEL）
 *
 * 为什么保留 \n 和 \t：
 *   - \n（\x0A）：正常的换行符，广泛存在于代码和多行文本中
 *   - \t（\x09）：正常的制表符，广泛存在于代码缩进中
 *   - 其他控制字符在现代文本中没有正当用途，移除是安全的
 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * UNICODE_CONFUSION — Unicode 混淆字符正则
 *
 * 匹配范围：
 *   - 零宽空格 / 零宽非连接符 / 零宽连接符
 *   - 零宽不中断空格（BOM - 在 UTF-8 中有时用作混淆）
 *   - 其他可能用于伪装文件名/代码的不可见字符
 *
 * 为什么需要检测这些字符：
 *   - 攻击者可能在代码中插入零宽字符，使代码看起来正常但实际行为不同
 *   - 示例："rm -rf /" 和 "rm -rf /<零宽字符>tmp" 视觉上难以区分
 *   - 这些字符在正常的代码和文本中不应该出现
 */
const UNICODE_CONFUSION = /[\u200B-\u200F\u2028\u2029\u202A-\u202F\u2060-\u206F\uFEFF]/g;

/**
 * 输入净化 — 移除危险字符、检测 Prompt Injection 攻击
 *
 * 处理顺序（为什么这么安排）：
 *   1. 长度限制：先裁剪超大输入，避免后续正则在 100K+ 字符上运行导致 ReDoS
 *   2. Unicode 混淆：移除可能伪装身份的不可见字符
 *   3. 控制字符：移除可能导致终端逃逸的字符
 *   4. Prompt Injection：在所有清除完成后检测攻击模式
 *      （因为攻击者可能用控制字符伪装攻击字符串）
 *
 * @param input — 原始用户输入字符串
 * @returns sanitized: 净化后的文本
 *          warnings: 处理过程中产生的警告信息
 *          blocked: 是否被阻止（检测到 block 级别的 Injection 攻击）
 */
export function sanitizeInput(input: string): { sanitized: string; warnings: string[]; blocked: boolean } {
    const warnings: string[] = [];

    // ─── 1. 长度限制（防 ReDoS 和内存耗尽） ───
    // 100K 字符的上限基于：
    //   - 正常用户输入很少超过 10K
    //   - 100K 足够包容大文件粘贴，同时防止恶意超大输入导致 OOM
    if (input.length > 100_000) {
        warnings.push("输入长度超过 100000 字符，已截断");
        input = input.slice(0, 100_000);
    }

    // ─── 2. Unicode 混淆字符检测与移除 ───
    // 这些字符在正常编程工作中不应出现，检测到即移除
    const confusionMatches = input.match(UNICODE_CONFUSION);
    if (confusionMatches) {
        input = input.replace(UNICODE_CONFUSION, "");
        warnings.push(`已移除 ${confusionMatches.length} 个 Unicode 混淆字符`);
    }

    // ─── 3. 控制字符移除（保留 \n \t） ───
    // 控制字符可用于 ANSI 终端逃逸攻击，移除它们不影响正常文本
    const controlMatches = input.match(CONTROL_CHARS);
    if (controlMatches) {
        input = input.replace(CONTROL_CHARS, "");
        warnings.push(`已移除 ${controlMatches.length} 个控制字符`);
    }

    // ─── 4. Prompt Injection 攻击检测 ───
    // 遍历所有已知的攻击模式
    for (const { pattern, severity } of INJECTION_PATTERNS) {
        if (pattern.test(input)) {
            if (severity === "block") {
                // block 级别：直接拒绝，返回空字符串和 blocked=true
                return {
                    sanitized: "",
                    warnings: [...warnings, `检测到 Prompt Injection 攻击: ${pattern}`],
                    blocked: true,
                };
            }
            // warn 级别：记录警告但允许继续
            warnings.push(`检测到可疑模式: ${pattern}`);
        }
    }

    return { sanitized: input, warnings, blocked: false };
}

/**
 * 输出过滤 — 脱敏 LLM 响应中的敏感信息
 *
 * 为什么需要输出过滤而非仅依靠 API Provider：
 *   - 防御纵深原则：不信任单一防线
 *   - LLM 可能从训练数据中"记忆"了真实凭据
 *   - 本地过滤可以扩展自定义模式（如公司内部项目名、内部 URL 等）
 *
 * 替换策略：
 *   - 保留格式前缀（如 sk-、Bearer、-----BEGIN...），让用户知道被脱敏的类型
 *   - 用 ***[REDACTED] 替代敏感部分，比完全删除更友好
 *   - Email 全替换：保护隐私比保留格式更重要
 *
 * @param output — LLM 原始响应文本
 * @returns sanitized: 脱敏后的文本
 *          redactions: 脱敏操作的描述列表（用于审计日志）
 */
export function sanitizeOutput(output: string): { sanitized: string; redactions: string[] } {
    const redactions: string[] = [];

    // 遍历所有敏感信息模式，逐个替换
    for (const { pattern, replacement, label } of SENSITIVE_PATTERNS) {
        const matches = output.match(pattern);
        if (matches) {
            output = output.replace(pattern, replacement);
            // 记录脱敏操作：类型和数量
            redactions.push(`${label} (${matches.length} 处)`);
        }
    }

    return { sanitized: output, redactions };
}

/**
 * 路径安全校验 — 确保文件操作不超出工作目录范围
 *
 * 安全检查逻辑：
 *   1. 解析 targetPath 为绝对路径
 *   2. 检查是否在工作目录下（路径以工作目录为前缀）
 *   3. 例外：允许访问 .y-claude-code 目录（内部配置/缓存/日志文件）
 *
 * 为什么允许 .y-claude-code 访问：
 *   - AI 需要读写自己的配置文件、记忆文件、日志等
 *   - 这些文件的路径是固定的，不属于"目录遍历攻击"
 *
 * 为什么使用 require 而非 import：
 *   - 在某些 ESM/CJS 混合环境下，动态 require 比 import 更可靠
 *   - path 模块是 Node.js 内置模块，不会引入额外依赖
 *
 * @param targetPath — 请求访问的目标路径（可能是相对路径）
 * @param workingDirectory — 当前工作目录（边界）
 * @returns true 表示路径安全，允许访问
 */
export function isPathSafe(targetPath: string, workingDirectory: string): boolean {
    const path = await_import_path();
    // 将目标路径和边界都解析为绝对路径
    const resolved = path.resolve(targetPath);
    const workDir = path.resolve(workingDirectory);

    // 安全判断：
    //   1. resolved 以 workDir 开头 → 在工作目录内部
    //   2. resolved 包含 .y-claude-code → 允许访问内部目录
    //      例：~/.y-claude-code/memory/coding-style.md 不在项目目录下但应该可访问
    return resolved.startsWith(workDir) || resolved.includes(".y-claude-code");
}

/**
 * 动态加载 Node.js path 模块
 *
 * 为什么不直接写 import * as path from "node:path"：
 *   - 在某些运行时环境（如 browser、Deno 的部分模式）中编译时导入可能失败
 *   - 使用 require 可以实现运行时的按需加载
 *   - 这个函数的调用频率低（每次路径校验），性能影响可忽略
 */
function await_import_path(): typeof import("node:path") { return require("node:path"); }
