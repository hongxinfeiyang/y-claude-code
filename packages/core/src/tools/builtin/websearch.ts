// ─── packages/core/src/tools/builtin/websearch.ts ───
// WebSearch 工具 — 网页搜索，返回结果摘要
// 解决问题：为 Agent 提供联网搜索能力，使用 DuckDuckGo 免费搜索接口（无需 API Key）

import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";

/**
 * WebSearchTool — DuckDuckGo 网页搜索工具
 *
 * 核心能力：
 * 1. 网页搜索返回标题、URL、摘要三元组
 * 2. 域名过滤（白名单/黑名单）
 * 3. 免 API Key（使用 DuckDuckGo HTML 搜索接口）
 *
 * 设计选择：使用 DuckDuckGo 而非 Google/Bing
 * - 无需注册 API Key，零配置使用
 * - HTML 版搜索结果解析简单（纯 HTML，无 JavaScript 渲染要求）
 * - 隐私友好，无用户追踪
 */
export class WebSearchTool extends Tool {
    /** 工具名称标识 */
    name = "WebSearch";

    /**
     * 工具描述
     * 解决问题：明确说明域名过滤功能，让模型知道可以通过此参数精确控制搜索范围
     */
    description = "搜索网页并返回结果摘要。支持域名过滤（allowed_domains / blocked_domains）。";

    /**
     * 参数 JSON Schema 定义
     * 解决问题：
     * - query: 搜索关键词（必须参数）
     * - allowed_domains: 白名单过滤（如只搜 developer.mozilla.org）
     * - blocked_domains: 黑名单过滤（如排除 w3schools.com）
     */
    parameters: JSONSchema = {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "搜索查询关键词",
            },
            allowed_domains: {
                type: "array",
                description: "限定搜索结果的域名白名单",
                items: { type: "string", description: "域名" },
            },
            blocked_domains: {
                type: "array",
                description: "排除的域名黑名单",
                items: { type: "string", description: "域名" },
            },
        },
        required: ["query"],
    };

    /**
     * 执行网页搜索
     *
     * @param params - 包含 query、allowed_domains、blocked_domains 参数
     * @param _context - 未使用的上下文
     * @returns ToolResult - 搜索结果列表，格式化的 Markdown 链接
     *
     * 执行流程：
     * 1. 调用 DuckDuckGo 搜索接口
     * 2. 域名过滤（白名单/黑名单）
     * 3. 取前 10 条结果
     * 4. 格式化为 Markdown 链接列表
     */
    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        const query = params.query as string;
        const allowedDomains = params.allowed_domains as string[] | undefined;
        const blockedDomains = params.blocked_domains as string[] | undefined;

        try {
            const results = await this.search(query);

            // ─── 零结果处理 ───
            // 解决问题：明确告知 Agent 搜索无结果，避免 Agent 误以为工具调用失败
            if (results.length === 0) {
                return { tool_use_id: "", content: `未找到与 "${query}" 相关的结果` };
            }

            // ─── 域名过滤 ───
            // 解决问题：
            // - 白名单：只保留来自指定域名的结果（精确搜索某网站）
            // - 黑名单：排除来自指定域名的结果（屏蔽低质量或无关网站）
            // - 两者可同时使用：先白名单筛选，再黑名单排除
            // - 使用 includes 而非精确匹配：允许子路径（如 docs.example.com 匹配 example.com）
            let filtered = results;
            if (allowedDomains?.length) {
                filtered = filtered.filter((r) => allowedDomains.some((d) => r.url.includes(d)));
            }
            if (blockedDomains?.length) {
                filtered = filtered.filter((r) => !blockedDomains.some((d) => r.url.includes(d)));
            }

            // ─── 去重：移除重复 URL 和高度相似标题的结果 ───
            filtered = this.deduplicateResults(filtered);

            // ─── 相关性排序：标题/摘要与查询词的匹配度 ───
            filtered = this.sortByRelevance(filtered, query);

            // ─── 格式化输出 ───
            // 解决问题：取前 10 条结果，以 Markdown 链接格式输出
            // 格式: "1. [标题](URL)\n   摘要内容"
            const output = filtered
                .slice(0, 10)
                .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
                .join("\n\n");

            return {
                tool_use_id: "",
                content: `搜索 "${query}" (${filtered.length} 条结果):\n\n${output}`,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            return { tool_use_id: "", content: `搜索失败: ${message}`, is_error: true };
        }
    }

    /**
     * 是否需要用户确认
     * 解决问题：搜索请求向外部服务发送查询词，可能泄露项目信息，需要审批
     */
    requiresApproval(): boolean {
        return true;
    }

    // ─── 私有方法 ───

    /**
     * 搜索结果去重
     *
     * @param results - 原始搜索结果
     * @returns 去重后的结果
     *
     * 解决问题：
     * - URL 完全匹配 → 直接去重
     * - 标题相似度 > 0.8 → 视为重复（同一文章的不同 URL 变体）
     */
    private deduplicateResults(results: Array<{ title: string; url: string; snippet: string }>): Array<{ title: string; url: string; snippet: string }> {
        const seenUrls = new Set<string>();
        const seenTitles: string[] = [];

        return results.filter((r) => {
            // ─── URL 去重 ───
            const normalizedUrl = r.url.replace(/\/$/, "").toLowerCase();
            if (seenUrls.has(normalizedUrl)) return false;
            seenUrls.add(normalizedUrl);

            // ─── 标题相似度去重 ───
            const normalizedTitle = r.title.toLowerCase().trim();
            for (const existing of seenTitles) {
                if (this.titleSimilarity(normalizedTitle, existing) > 0.8) {
                    return false;
                }
            }
            seenTitles.push(normalizedTitle);
            return true;
        });
    }

    /**
     * 标题相似度计算（Jaccard 词级别）
     */
    private titleSimilarity(a: string, b: string): number {
        const wordsA = new Set(a.split(/\s+/));
        const wordsB = new Set(b.split(/\s+/));
        const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
        const union = new Set([...wordsA, ...wordsB]);
        return union.size === 0 ? 0 : intersection.size / union.size;
    }

    /**
     * 搜索结果相关性排序
     *
     * @param results - 去重后的结果
     * @param query - 用户搜索查询
     * @returns 按相关性降序排列的结果
     *
     * 解决问题：DuckDuckGo 返回的结果排序不一定符合需求，
     * 基于查询词在标题和摘要中的命中次数重新排序
     * - 标题命中权重 ×3（标题匹配比摘要匹配更重要）
     * - 摘要命中权重 ×1
     * - 精确短语匹配额外加分
     */
    private sortByRelevance(results: Array<{ title: string; url: string; snippet: string }>, query: string): Array<{ title: string; url: string; snippet: string }> {
        const queryLower = query.toLowerCase();
        const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 1);

        const scored = results.map((r) => {
            const titleLower = r.title.toLowerCase();
            const snippetLower = r.snippet.toLowerCase();

            let score = 0;

            // ─── 精确短语匹配 ───
            if (titleLower.includes(queryLower)) score += 10;
            if (snippetLower.includes(queryLower)) score += 5;

            // ─── 词级别匹配 ───
            for (const word of queryWords) {
                if (titleLower.includes(word)) score += 3;
                if (snippetLower.includes(word)) score += 1;
            }

            return { result: r, score };
        });

        // 按分数降序排列，同分保持原顺序
        return scored
            .sort((a, b) => b.score - a.score)
            .map((s) => s.result);
    }

    /**
     * 调用 DuckDuckGo 搜索接口
     *
     * @param query - 搜索关键词
     * @returns 搜索结果数组 [{title, url, snippet}]
     *
     * 解决问题：
     * - 使用 DuckDuckGo HTML 搜索（html.duckduckgo.com/html/），
     *   返回纯 HTML 页面，包含 class="result__a" 的链接和 class="result__snippet" 的摘要
     * - 不需要 API Key，无请求频率限制（但有合理使用限制）
     * - 10 秒超时保护
     * - User-Agent 标识自身身份
     */
    private async search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
        const encoded = encodeURIComponent(query);
        const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

        // ─── HTTP 请求（10 秒超时） ───
        // 解决问题：AbortController 防止网络问题导致无限等待
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": "y-claude-code/1.0" },
        });
        clearTimeout(timeout);

        const html = await response.text();
        return this.parseDuckDuckGoHtml(html);
    }

    /**
     * 解析 DuckDuckGo HTML 搜索结果
     *
     * @param html - DuckDuckGo 搜索返回的 HTML 字符串
     * @returns 解析后的结果数组
     *
     * 解决问题：
     * - 从 HTML 中提取搜索结果的三要素：标题、URL、摘要
     * - 正则匹配 class="result__a"（结果链接）和 class="result__snippet"（结果摘要）
     * - URL 解码（&amp; → &）
     * - HTML 标签剥离（从标题和摘要中移除可能的 HTML 标签）
     * - url.startsWith("http") 过滤掉无效的相对链接
     *
     * 注意：DuckDuckGo HTML 页面结构可能变化，此解析是脆弱的。
     * 理想方案是接入正式的搜索 API，但此实现追求零配置使用。
     */
    private parseDuckDuckGoHtml(html: string): Array<{ title: string; url: string; snippet: string }> {
        const results: Array<{ title: string; url: string; snippet: string }> = [];

        // 匹配搜索结果块：链接 → 摘要
        // result__a class 的 <a> 标签包含标题和 href
        // result__snippet class 的 <a> 标签包含摘要文字
        const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

        let match;
        while ((match = resultRegex.exec(html)) !== null) {
            const url = match[1].replace(/&amp;/g, "&");        // 解码 URL 中的 HTML 实体
            const title = match[2].replace(/<[^>]+>/g, "").trim(); // 移除标题中的 HTML 标签
            const snippet = match[3].replace(/<[^>]+>/g, "").trim(); // 移除摘要中的 HTML 标签

            // 只保留有效的 HTTP/HTTPS 链接
            if (title && url.startsWith("http")) {
                results.push({ title, url, snippet });
            }
        }

        return results;
    }
}
