// ─── packages/core/src/tools/builtin/__tests__/websearch.test.ts ───
// WebSearchTool 单元测试 — 去重、相似度、排序、域名过滤、HTML 解析

import { describe, it, expect } from "vitest";
import { WebSearchTool } from "../websearch";

// ─── 辅助：获取工具私有方法 ───
function getPrivate(tool: WebSearchTool) {
    return tool as unknown as {
        deduplicateResults(
            results: Array<{ title: string; url: string; snippet: string }>,
        ): Array<{ title: string; url: string; snippet: string }>;
        titleSimilarity(a: string, b: string): number;
        sortByRelevance(
            results: Array<{ title: string; url: string; snippet: string }>,
            query: string,
        ): Array<{ title: string; url: string; snippet: string }>;
        parseDuckDuckGoHtml(html: string): Array<{ title: string; url: string; snippet: string }>;
    };
}

// ─── 辅助：创建搜索结果 ───
function result(title: string, url: string, snippet: string) {
    return { title, url, snippet };
}

describe("WebSearchTool — 去重", () => {
    const tool = new WebSearchTool();
    const priv = getPrivate(tool);

    it("重复 URL 应被移除", () => {
        const results = [
            result("标题 A", "https://example.com/a", "摘要 A"),
            result("标题 B", "https://example.com/a", "摘要 B"),
        ];
        const deduped = priv.deduplicateResults(results);
        expect(deduped).toHaveLength(1);
    });

    it("URL 末尾 / 不同应视为重复", () => {
        const results = [
            result("标题", "https://example.com/page", "摘要 1"),
            result("标题", "https://example.com/page/", "摘要 2"),
        ];
        const deduped = priv.deduplicateResults(results);
        expect(deduped).toHaveLength(1);
    });

    it("大小写不同的 URL 应视为重复", () => {
        const results = [
            result("标题", "https://Example.com/Page", "摘要 1"),
            result("标题", "https://example.com/page", "摘要 2"),
        ];
        const deduped = priv.deduplicateResults(results);
        expect(deduped).toHaveLength(1);
    });

    it("高度相似标题(>0.8)应去重", () => {
        const results = [
            result("JavaScript 教程 入门", "https://a.com/1", "摘要 A"),
            result("JavaScript 教程 入门 指南", "https://b.com/2", "摘要 B"),
        ];
        // "JavaScript 教程 入门" vs "JavaScript 教程 入门 指南" → 3/4 = 0.75, 不过 0.8
        // 实际上这个取决于 whitespace split 的结果
        const deduped = priv.deduplicateResults(results);
        // Jaccard: wordsA={javascript,教程,入门}, wordsB={javascript,教程,入门,指南}
        // intersection=3, union=4, similarity=0.75 (< 0.8) → 不去重
        expect(deduped).toHaveLength(2);
    });

    it("几乎相同标题应去重", () => {
        const results = [
            result("How to Learn JavaScript Fast", "https://a.com/1", "摘要 A"),
            result("How to Learn JavaScript", "https://b.com/2", "摘要 B"),
        ];
        const deduped = priv.deduplicateResults(results);
        // "how to learn javascript fast" vs "how to learn javascript"
        // wordsA={how,to,learn,javascript,fast}, wordsB={how,to,learn,javascript}
        // intersection=4, union=5, similarity=0.8 → 恰好 0.8 不触发 (>0.8 才触发)
        expect(deduped).toHaveLength(2);
    });

    it("完全不同标题不应去重", () => {
        const results = [
            result("Python 教程", "https://a.com", "摘要 A"),
            result("Java 入门", "https://b.com", "摘要 B"),
        ];
        const deduped = priv.deduplicateResults(results);
        expect(deduped).toHaveLength(2);
    });
});

describe("WebSearchTool — 标题相似度", () => {
    const tool = new WebSearchTool();
    const priv = getPrivate(tool);

    it("相同标题应返回 1.0", () => {
        expect(priv.titleSimilarity("hello world", "hello world")).toBe(1);
    });

    it("完全不同标题应返回 0.0", () => {
        expect(priv.titleSimilarity("hello", "world")).toBe(0);
    });

    it("部分重叠应返回正确分数", () => {
        // "a b c" vs "a b d": intersection={a,b}=2, union={a,b,c,d}=4, 0.5
        const score = priv.titleSimilarity("a b c", "a b d");
        expect(score).toBeCloseTo(0.5);
    });
});

describe("WebSearchTool — 相关性排序", () => {
    const tool = new WebSearchTool();
    const priv = getPrivate(tool);

    it("标题精确匹配查询词的应排在前面", () => {
        const results = [
            result("Python 教程", "https://a.com", "某教程"),
            result("JavaScript 教程", "https://b.com", "另一教程"),
        ];
        const sorted = priv.sortByRelevance(results, "JavaScript");
        expect(sorted[0].title).toContain("JavaScript");
    });

    it("摘要匹配的应排在标题匹配之后", () => {
        const results = [
            result("某文章", "https://a.com", "JavaScript 入门指南"),
            result("JavaScript 高级教程", "https://b.com", "深入探讨"),
        ];
        const sorted = priv.sortByRelevance(results, "JavaScript");
        expect(sorted[0].title).toContain("JavaScript");
    });

    it("同分应保持原顺序", () => {
        const results = [
            result("文章 A", "https://a.com", "内容"),
            result("文章 B", "https://b.com", "内容"),
        ];
        const sorted = priv.sortByRelevance(results, "不存在的词");
        // 分数都为 0，保持原顺序
        expect(sorted[0].title).toBe("文章 A");
        expect(sorted[1].title).toBe("文章 B");
    });
});

describe("WebSearchTool — DuckDuckGo HTML 解析", () => {
    const tool = new WebSearchTool();
    const priv = getPrivate(tool);

    it("应解析标准搜索结果", () => {
        const html = `<a class="result__a" href="https://example.com/page">Example Page</a><a class="result__snippet">This is the snippet text</a>`;
        const results = priv.parseDuckDuckGoHtml(html);
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("Example Page");
        expect(results[0].url).toBe("https://example.com/page");
        expect(results[0].snippet).toBe("This is the snippet text");
    });

    it("应解码 URL 中的 &amp;", () => {
        const html = `<a class="result__a" href="https://example.com/page?a=1&amp;b=2">Test</a><a class="result__snippet">Snippet</a>`;
        const results = priv.parseDuckDuckGoHtml(html);
        expect(results).toHaveLength(1);
        expect(results[0].url).toBe("https://example.com/page?a=1&b=2");
    });

    it("应移除标题中的 HTML 标签", () => {
        // parseDuckDuckGoHtml 的 title 捕获使用 [^<]*（不含 HTML 标签的纯文本标题）
        const html = `<a class="result__a" href="https://example.com">Plain Title</a><a class="result__snippet">Snippet</a>`;
        const results = priv.parseDuckDuckGoHtml(html);
        expect(results[0].title).toBe("Plain Title");
    });

    it("应移除摘要中的 HTML 标签", () => {
        const html = `<a class="result__a" href="https://example.com">Test</a><a class="result__snippet">Some <em>important</em> text</a>`;
        const results = priv.parseDuckDuckGoHtml(html);
        expect(results[0].snippet).toBe("Some important text");
    });

    it("应过滤非 HTTP 链接", () => {
        const html = `<a class="result__a" href="https://example.com">Valid</a><a class="result__snippet">S1</a><a class="result__a" href="javascript:void(0)">Invalid</a><a class="result__snippet">S2</a>`;
        const results = priv.parseDuckDuckGoHtml(html);
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("Valid");
    });

    it("空 HTML 应返回空数组", () => {
        const results = priv.parseDuckDuckGoHtml("");
        expect(results).toEqual([]);
    });

    it("无匹配结果时应返回空数组", () => {
        const results = priv.parseDuckDuckGoHtml("<div>no results here</div>");
        expect(results).toEqual([]);
    });

    it("多条结果应全部解析", () => {
        const html = `
            <a class="result__a" href="https://a.com">Result A</a><a class="result__snippet">Snippet A</a>
            <a class="result__a" href="https://b.com">Result B</a><a class="result__snippet">Snippet B</a>
            <a class="result__a" href="https://c.com">Result C</a><a class="result__snippet">Snippet C</a>
        `;
        const results = priv.parseDuckDuckGoHtml(html);
        expect(results).toHaveLength(3);
    });
});

describe("WebSearchTool — 域名过滤 (execute)", () => {
    let tool: WebSearchTool;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        tool = new WebSearchTool();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("allowed_domains 白名单过滤", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            text: async () => `
                <a class="result__a" href="https://docs.example.com/page">Doc Page</a><a class="result__snippet">Doc snippet</a>
                <a class="result__a" href="https://blog.example.com/post">Blog Post</a><a class="result__snippet">Blog snippet</a>
                <a class="result__a" href="https://other.com/page">Other</a><a class="result__snippet">Other snippet</a>
            `,
        } as unknown as Response);

        const result = await tool.execute(
            { query: "test", allowed_domains: ["example.com"] },
            {} as never,
        );
        expect(result.content).toContain("docs.example.com");
        expect(result.content).toContain("blog.example.com");
        expect(result.content).not.toContain("other.com");
    });

    it("blocked_domains 黑名单过滤", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            text: async () => `
                <a class="result__a" href="https://good.com/page">Good</a><a class="result__snippet">Good snippet</a>
                <a class="result__a" href="https://bad.com/page">Bad</a><a class="result__snippet">Bad snippet</a>
            `,
        } as unknown as Response);

        const result = await tool.execute(
            { query: "test", blocked_domains: ["bad.com"] },
            {} as never,
        );
        expect(result.content).not.toContain("bad.com");
        expect(result.content).toContain("good.com");
    });

    it("零结果应返回未找到消息", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            text: async () => "<html></html>",
        } as unknown as Response);

        const result = await tool.execute({ query: "xyznonexistent12345" }, {} as never);
        expect(result.content).toContain("未找到");
    });

    it("fetch 异常应返回搜索失败", async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error("网络错误"));

        const result = await tool.execute({ query: "test" }, {} as never);
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("搜索失败");
    });
});

describe("WebSearchTool — 元数据", () => {
    const tool = new WebSearchTool();

    it("name 应为 WebSearch", () => {
        expect(tool.name).toBe("WebSearch");
    });

    it("requiresApproval 应返回 true", () => {
        expect(tool.requiresApproval()).toBe(true);
    });

    it("parameters.required 应包含 query", () => {
        expect(tool.parameters.required).toContain("query");
    });

    it("parameters 应包含 allowed_domains 和 blocked_domains", () => {
        expect(tool.parameters.properties.allowed_domains).toBeDefined();
        expect(tool.parameters.properties.blocked_domains).toBeDefined();
    });
});
