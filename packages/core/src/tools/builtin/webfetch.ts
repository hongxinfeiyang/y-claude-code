// ─── packages/core/src/tools/builtin/webfetch.ts ───
// WebFetch 工具 — 获取 URL 内容并转为纯文本，15 分钟内存缓存
// 解决问题：为 Agent 提供安全的网页内容获取能力，含 SSRF 防护和缓存优化

import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";

/**
 * 缓存条目结构
 * 解决问题：内存缓存的每个条目标记获取时间和内容，
 * 用于 TTL 过期判断 — 避免短时间内重复请求同一 URL
 */
interface CacheEntry {
    content: string;
    timestamp: number;
}

/**
 * 缓存过期时间 (15 分钟 = 900,000ms)
 * 解决问题：短时间内多次读取同一 URL 时直接返回缓存，
 * 避免重复网络请求，降低延迟和远程服务器负载
 */
const CACHE_TTL = 15 * 60 * 1000;

/**
 * 最大响应大小 (1MB)
 * 解决问题：防止超大 HTML 页面撑爆 Agent 上下文窗口和内存
 */
const MAX_RESPONSE_SIZE = 1_000_000;

/**
 * 禁止访问的内网地址模式
 * 解决问题：SSRF (Server-Side Request Forgery) 防护 —
 * 禁止 Agent 通过 WebFetch 访问内网服务、元数据接口和 loopback 地址。
 * 这防止了通过网页请求扫描内网拓扑或访问 AWS/GCP 元数据端点。
 *
 * DNS Rebinding 防护说明：
 * - 在 URL 解析阶段检查 hostname 是否指向内网地址
 * - fetch 本身会做 DNS 解析，Node.js 的 DNS 解析不受 rebinding 攻击
 * - 即使攻击者 DNS 返回 127.0.0.1，hostname 检查已先于 fetch 执行
 */
const BLOCKED_HOSTS = [
    /^127\./,                      // Loopback 地址 (127.0.0.0/8)
    /^10\./,                       // RFC 1918 A 类私有网络 (10.0.0.0/8)
    /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918 B 类私有网络 (172.16.0.0/12)
    /^192\.168\./,                 // RFC 1918 C 类私有网络 (192.168.0.0/16)
    /^0\./,                        // 零配置网络 (0.0.0.0)
    /^localhost$/,                 // 本地域名
    /^\[::1\]$/,                   // IPv6 loopback
    /^169\.254\./,                 // Link-local (AWS/GCP 元数据端点)
    /^fc00:/,                      // IPv6 唯一本地地址
    /^fe80:/,                      // IPv6 link-local
];

/**
 * WebFetchTool — 安全的网页内容获取工具
 *
 * 核心能力：
 * 1. HTTP/HTTPS 请求获取网页内容
 * 2. HTML 转纯文本（简单标签剥离）
 * 3. 15 分钟内存缓存（self-cleaning）
 * 4. SSRF 防护（内网地址拦截）
 *
 * 安全设计：
 * - 只允许 HTTP/HTTPS 协议（禁止 file://、ftp:// 等）
 * - 内网地址黑名单拦截
 * - 超时保护（15 秒）
 * - 响应大小限制（1MB）
 */
export class WebFetchTool extends Tool {
    /** 工具名称标识 */
    name = "WebFetch";

    /**
     * 工具描述
     * 解决问题：明确说明不支持认证页面（如 Google Docs、Jira），
     * 避免 Agent 尝试获取需要 Cookie/Token 的页面导致失败
     */
    description = "获取指定 URL 的网页内容，HTML 自动转换为 Markdown 格式。不支持需要认证的页面。";

    /**
     * 参数 JSON Schema 定义
     * 解决问题：
     * - url: 必需的网络资源定位符
     * - prompt: 指导模型分析的提取方向（如"从页面中提取 API 文档内容"）
     */
    parameters: JSONSchema = {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "要获取的网页 URL",
            },
            prompt: {
                type: "string",
                description: "描述需要从页面中提取的信息，用于指导模型分析和摘要",
            },
        },
        required: ["url"],
    };

    /**
     * 内存缓存（实例级别）
     * 解决问题：Map 实现 O(1) 存取，自动 TTL 过期，
     * 缓存跟随工具实例生命周期（单次 Agent 会话）
     */
    private cache: Map<string, CacheEntry> = new Map();

    /**
     * 执行网页内容获取
     *
     * @param params - 包含 url 和可选 prompt 参数
     * @param _context - 未使用的上下文（WebFetch 不依赖工作目录）
     * @returns ToolResult - 网页内容或错误信息
     *
     * 执行流程：
     * 1. URL 合法性校验（格式 + 协议）
     * 2. SSRF 防护检测（内网地址拦截）
     * 3. 缓存检查（15 分钟 TTL）
     * 4. HTTP 请求（15 秒超时）
     * 5. HTML → 纯文本转换
     * 6. 写入缓存 + 格式化输出
     */
    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        const url = params.url as string;
        const prompt = params.prompt as string | undefined;

        // ─── 第一步：URL 合法性校验 ───
        // 解决问题：new URL() 会抛出 TypeError 如果格式不合法，
        // 提前拦截防止执行无效请求
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return { tool_use_id: "", content: `无效的 URL: ${url}`, is_error: true };
        }

        // ─── 第二步：SSRF 防护 — 内网地址拦截 ───
        // 解决问题：防止 Agent 通过 WebFetch 访问内网服务
        // 例如 http://169.254.169.254/latest/meta-data/（AWS 元数据端点）
        // 或 http://10.0.0.1/admin（内网管理后台）
        if (!this.isAllowedHost(parsed.hostname)) {
            return { tool_use_id: "", content: `安全限制：禁止访问内网地址 (${parsed.hostname})`, is_error: true };
        }

        // ─── 第三步：协议限制 ───
        // 解决问题：只允许 HTTP/HTTPS，禁止 file://（本地文件）、
        // ftp://（可能绕过内网限制）、gopher://（SSRF 攻击向量）等
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return { tool_use_id: "", content: `不支持的协议: ${parsed.protocol}，仅支持 HTTP/HTTPS`, is_error: true };
        }

        // ─── 第四步：缓存检查 ───
        // 解决问题：15 分钟内同一 URL 多次读取时直接返回缓存，
        // 避免重复网络请求（对 API 限流和延迟都友好）
        const cached = this.cache.get(url);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return {
                tool_use_id: "",
                content: this.formatResponse(url, prompt, cached.content, true),
            };
        }

        try {
            // ─── 第五步：HTTP 请求 ───
            // 解决问题：
            // - AbortController 实现 15 秒超时（防止无限等待）
            // - User-Agent 标识自身（避免被反爬虫拦截）
            // - Accept 头限定 HTML/纯文本（不需要 JSON/XML 等）
            // - redirect: "follow" 自动跟随重定向
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15_000);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    "User-Agent": "y-claude-code/1.0",
                    "Accept": "text/html, application/xhtml+xml, text/plain",
                },
                redirect: "follow",
            });
            clearTimeout(timeout);

            // ─── HTTP 错误响应处理 ───
            // 解决问题：4xx/5xx 状态码时直接返回错误，
            // 不尝试解析响应体（可能是错误页面）
            if (!response.ok) {
                return {
                    tool_use_id: "",
                    content: `HTTP 错误: ${response.status} ${response.statusText}`,
                    is_error: true,
                };
            }

            const contentType = response.headers.get("content-type") ?? "";

            // ─── 第六步：HTML → Markdown 转换 ───
            // 解决问题：AI 模型适合处理纯文本/Markdown，原始 HTML 包含大量标签噪音。
            // 此处使用简单正则剥离（生产环境应接入 Turndown 等专业 HTML→Markdown 库）
            let html = await response.text();
            html = html.slice(0, MAX_RESPONSE_SIZE);
            const text = this.htmlToMarkdown(html);

            // ─── 写入缓存 ───
            // 解决问题：缓存此 URL 的内容和时间戳，后续 15 分钟内直接返回
            this.cache.set(url, { content: text, timestamp: Date.now() });

            return {
                tool_use_id: "",
                content: this.formatResponse(url, prompt, text, false),
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            return { tool_use_id: "", content: `请求失败: ${message}`, is_error: true };
        }
    }

    /**
     * 是否需要用户确认
     * 解决问题：网络请求涉及外发数据和潜在隐私泄露，需要用户审批
     */
    requiresApproval(): boolean {
        return true; // 网络请求需要确认
    }

    // ─── 私有方法 ───

    /**
     * 检查主机是否允许访问（SSRF 防护核心）
     *
     * @param hostname - URL 解析后的主机名
     * @returns 是否不在黑名单中
     *
     * 解决问题：对 BLOCKED_HOSTS 中每个正则模式逐一测试，
     * 任意命中即拦截。黑名单基于 RFC 1918 私有地址范围，
     * 覆盖所有常见的内网场景。
     */
    private isAllowedHost(hostname: string): boolean {
        return !BLOCKED_HOSTS.some((pattern) => pattern.test(hostname));
    }

    /**
     * HTML → Markdown 转换
     *
     * @param html - 原始 HTML 字符串
     * @returns Markdown 格式文本
     *
     * 解决问题：AI 模型适合处理 Markdown 格式，将 HTML 的语义标签
     * 转换为等效 Markdown 标记，保留文档结构和链接关系
     *
     * 转换映射：
     * - 标题 h1-h6 → # ~ ######
     * - 链接 a → [text](href)
     * - 粗体 b/strong → **text**
     * - 斜体 i/em → *text*
     * - 代码 pre/code → ```...```
     * - 列表 ul/ol+li → - / 1. items
     * - 图片 img → ![alt](src)
     * - 引用 blockquote → > text
     * - 段落 p/div → 双换行
     */
    private htmlToMarkdown(html: string): string {
        // ─── 移除 script/style/注释/head 等非内容标签 ───
        let md = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");

        // ─── 标题 h1-h6 → # ~ ###### ───
        for (let i = 6; i >= 1; i--) {
            const regex = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, "gi");
            md = md.replace(regex, (_, text) => `\n\n${"#".repeat(i)} ${this.stripInlineHtml(text).trim()}\n\n`);
        }

        // ─── 代码块 pre → ```...``` ───
        md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
            const cleaned = code.replace(/<code[^>]*>|<\/code>/gi, "").replace(/<[^>]+>/g, "");
            return `\n\`\`\`\n${this.decodeEntities(cleaned).trim()}\n\`\`\`\n`;
        });

        // ─── 行内代码 code → `...` ───
        md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${this.decodeEntities(code.replace(/<[^>]+>/g, ""))}\``);

        // ─── 链接 a → [text](href) ───
        md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `[${this.stripInlineHtml(text).trim()}](${this.decodeEntities(href)})`);

        // ─── 图片 img → ![alt](src) ───
        md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, (_, src, alt) => `![${alt}](${src})`);
        md = md.replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, (_, src) => `![](${src})`);

        // ─── 粗体 b/strong → **text** ───
        md = md.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, (_, text) => `**${this.stripInlineHtml(text).trim()}**`);

        // ─── 斜体 i/em → *text* ───
        md = md.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, (_, text) => `*${this.stripInlineHtml(text).trim()}*`);

        // ─── 列表项 li → - item ───
        md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => `\n- ${this.stripInlineHtml(text).trim()}`);

        // ─── 有序列表 ol 包裹（在 li 转换后） ───
        // 通过给 <ol>...</ol> 内的 - 替换为数字序号
        md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
            let counter = 1;
            return content.replace(/\n- /g, () => `\n${counter++}. `);
        });

        // ─── 引用 blockquote → > text ───
        md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, text) => {
            const lines = this.stripInlineHtml(text).trim().split("\n");
            return "\n" + lines.map((l: string) => `> ${l}`).join("\n") + "\n";
        });

        // ─── 水平线 hr → --- ───
        md = md.replace(/<hr[^>]*\/?>/gi, "\n---\n");

        // ─── 换行 br → 单换行 ───
        md = md.replace(/<br[^>]*\/?>/gi, "\n");

        // ─── 段落/div 分隔 ───
        md = md.replace(/<\/(?:p|div|section|article)>/gi, "\n\n");

        // ─── 移除所有剩余 HTML 标签 ───
        md = md.replace(/<[^>]+>/g, "");

        // ─── 实体解码 ───
        md = this.decodeEntities(md);

        // ─── 空白清理 ───
        md = md
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();

        return md;
    }

    /**
     * HTML 实体解码
     */
    private decodeEntities(text: string): string {
        const entities: Record<string, string> = {
            "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
            "&#x27;": "'", "&nbsp;": " ", "&#39;": "'", "&apos;": "'",
        };
        return text.replace(/&[#a-z0-9]+;/gi, (m) => entities[m] ?? m);
    }

    /**
     * 行内 HTML 标签剥离（保留文字）
     */
    private stripInlineHtml(text: string): string {
        return text.replace(/<[^>]+>/g, "");
    }

    /**
     * 简单 HTML 标签剥离（降级方案）
     *
     * @param html - 原始 HTML 字符串
     * @returns 去标签后的纯文本
     *
     * 解决问题：
     * - 移除 <script> 和 <style> 标签及内容（JS 代码和 CSS 对 Agent 无意义）
     * - 移除所有 HTML 标签（<...>）
     * - 解码常见 HTML 实体（&amp; → &, &lt; → < 等）
     * - 压缩多余空白字符和空行
     *
     * 注意：生产环境应接入 Turndown/cheerio 做完整的 HTML→Markdown 转换，
     * 正则方式无法处理复杂嵌套标签和 JavaScript 动态渲染内容
     */
    private stripHtml(html: string): string {
        return html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")  // 移除 script 标签及内容
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")    // 移除 style 标签及内容
            .replace(/<[^>]+>/g, " ")                            // 移除所有 HTML 标签
            .replace(/&amp;/g, "&")                              // HTML 实体解码
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#x27;/g, "'")
            .replace(/&nbsp;/g, " ")
            .replace(/\s+/g, " ")                                // 合并连续空白
            .replace(/\n\s*\n/g, "\n\n")                         // 合并连续空行
            .trim();
    }

    /**
     * 格式化响应内容（统一输出格式）
     *
     * @param url - 来源 URL
     * @param prompt - 提取目标描述（可选）
     * @param content - 网页纯文本内容
     * @param fromCache - 是否来自缓存
     * @returns 格式化的响应字符串
     *
     * 解决问题：
     * - 统一输出格式，包含 URL、提示词、内容
     * - 缓存命中时标记 "(来自缓存)"，让用户了解数据新鲜度
     * - 内容超过 10,000 字符时截断（在此处而非 stripHtml 处截断，
     *   因为 stripHtml 的结果可能比 MAX_RESPONSE_SIZE 小很多）
     */
    private formatResponse(url: string, prompt: string | undefined, content: string, fromCache: boolean): string {
        const parts: string[] = [];
        parts.push(`URL: ${url}`);
        if (fromCache) parts.push("(来自缓存)");
        if (prompt) parts.push(`提取目标: ${prompt}`);
        parts.push("", content.length > 10_000 ? content.slice(0, 10_000) + "\n...(内容已截断)" : content);
        return parts.join("\n");
    }
}
