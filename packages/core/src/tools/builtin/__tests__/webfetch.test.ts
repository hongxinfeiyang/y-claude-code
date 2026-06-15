// ─── packages/core/src/tools/builtin/__tests__/webfetch.test.ts ───
// WebFetchTool 单元测试 — URL 安全校验、SSRF 防护、HTML→Markdown 转换、缓存

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebFetchTool } from "../webfetch";

// ─── 辅助：获取工具私有方法 ───
function getPrivate(tool: WebFetchTool) {
    return tool as unknown as {
        isAllowedHost(hostname: string): boolean;
        htmlToMarkdown(html: string): string;
        decodeEntities(text: string): string;
        stripInlineHtml(text: string): string;
        formatResponse(url: string, prompt: string | undefined, content: string, fromCache: boolean): string;
    };
}

describe("WebFetchTool — SSRF 防护", () => {
    const tool = new WebFetchTool();
    const priv = getPrivate(tool);

    it("允许公网 IP", () => {
        expect(priv.isAllowedHost("8.8.8.8")).toBe(true);
    });

    it("允许公网域名", () => {
        expect(priv.isAllowedHost("example.com")).toBe(true);
        expect(priv.isAllowedHost("api.anthropic.com")).toBe(true);
    });

    it("拦截 loopback 地址 127.0.0.1", () => {
        expect(priv.isAllowedHost("127.0.0.1")).toBe(false);
    });

    it("拦截 127.x.x.x 段", () => {
        expect(priv.isAllowedHost("127.0.0.2")).toBe(false);
        expect(priv.isAllowedHost("127.255.255.255")).toBe(false);
    });

    it("拦截 10.x 私有网络", () => {
        expect(priv.isAllowedHost("10.0.0.1")).toBe(false);
        expect(priv.isAllowedHost("10.255.255.255")).toBe(false);
    });

    it("拦截 172.16-31.x 私有网络", () => {
        expect(priv.isAllowedHost("172.16.0.1")).toBe(false);
        expect(priv.isAllowedHost("172.31.255.255")).toBe(false);
    });

    it("放行 172.15.x（不在 RFC 1918 B 类范围）", () => {
        expect(priv.isAllowedHost("172.15.0.1")).toBe(true);
        expect(priv.isAllowedHost("172.32.0.1")).toBe(true);
    });

    it("拦截 192.168.x 私有网络", () => {
        expect(priv.isAllowedHost("192.168.1.1")).toBe(false);
        expect(priv.isAllowedHost("192.168.0.1")).toBe(false);
    });

    it("拦截 localhost", () => {
        expect(priv.isAllowedHost("localhost")).toBe(false);
    });

    it("拦截 IPv6 loopback", () => {
        expect(priv.isAllowedHost("[::1]")).toBe(false);
    });

    it("拦截 link-local 169.254.x（AWS/GCP 元数据端点）", () => {
        expect(priv.isAllowedHost("169.254.169.254")).toBe(false);
    });

    it("拦截 IPv6 私有地址 fc00:", () => {
        expect(priv.isAllowedHost("fc00::1")).toBe(false);
    });

    it("拦截 IPv6 link-local fe80:", () => {
        expect(priv.isAllowedHost("fe80::1")).toBe(false);
    });

    it("拦截 0.x 零配置网络", () => {
        expect(priv.isAllowedHost("0.0.0.0")).toBe(false);
    });
});

describe("WebFetchTool — execute 输入校验", () => {
    let tool: WebFetchTool;

    beforeEach(() => {
        tool = new WebFetchTool();
    });

    it("无效 URL 应返回错误", async () => {
        // new URL("not-a-url") 会抛出 TypeError
        const result = await tool.execute({ url: "not-a-url" }, {} as never);
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("无效的 URL");
    });

    it("内网地址应返回安全限制错误", async () => {
        const result = await tool.execute({ url: "http://127.0.0.1/admin" }, {} as never);
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("安全限制");
    });

    it("非 HTTP 协议应返回错误", async () => {
        const result = await tool.execute({ url: "ftp://example.com/file" }, {} as never);
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("不支持的协议");
    });

    it("file:// 协议应被拦截", async () => {
        const result = await tool.execute({ url: "file:///etc/passwd" }, {} as never);
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("不支持的协议");
    });
});

describe("WebFetchTool — HTML → Markdown 转换", () => {
    const tool = new WebFetchTool();
    const priv = getPrivate(tool);

    it("h1-h6 标题应转换为 # 标记", () => {
        const result = priv.htmlToMarkdown("<h1>主标题</h1><h2>副标题</h2><h3>三级标题</h3>");
        expect(result).toContain("# 主标题");
        expect(result).toContain("## 副标题");
        expect(result).toContain("### 三级标题");
    });

    it("链接应转换为 [text](href)", () => {
        const result = priv.htmlToMarkdown('<a href="https://example.com">示例链接</a>');
        expect(result).toContain("[示例链接](https://example.com)");
    });

    it("粗体应转换为 **text**", () => {
        const result = priv.htmlToMarkdown("<b>重要</b> 和 <strong>强调</strong>");
        expect(result).toContain("**重要**");
        expect(result).toContain("**强调**");
    });

    it("斜体应转换为 *text*", () => {
        const result = priv.htmlToMarkdown("<i>斜体</i> 和 <em>强调斜体</em>");
        expect(result).toContain("*斜体*");
        expect(result).toContain("*强调斜体*");
    });

    it("代码块 pre 应转换为 ```...```", () => {
        const result = priv.htmlToMarkdown("<pre><code>const x = 1;</code></pre>");
        expect(result).toContain("```");
        expect(result).toContain("const x = 1;");
    });

    it("行内代码 code 应转换为 `...`", () => {
        const result = priv.htmlToMarkdown("使用 <code>Array.map()</code> 方法");
        expect(result).toContain("`Array.map()`");
    });

    it("列表项 li 应转换为 - item", () => {
        const result = priv.htmlToMarkdown("<ul><li>第一项</li><li>第二项</li></ul>");
        expect(result).toContain("- 第一项");
        expect(result).toContain("- 第二项");
    });

    it("有序列表 ol 应转换为数字序号", () => {
        const result = priv.htmlToMarkdown("<ol><li>第一步</li><li>第二步</li></ol>");
        expect(result).toMatch(/1\.\s*第一步/);
        expect(result).toMatch(/2\.\s*第二步/);
    });

    it("引用 blockquote 应转换为 > text", () => {
        const result = priv.htmlToMarkdown("<blockquote>引用的文字</blockquote>");
        expect(result).toContain("> 引用的文字");
    });

    it("图片 img 应转换为 ![alt](src)", () => {
        const result = priv.htmlToMarkdown('<img src="image.png" alt="描述文字">');
        expect(result).toContain("![描述文字](image.png)");
    });

    it("script/style/head/nav/footer 标签内容应被移除", () => {
        const result = priv.htmlToMarkdown(
            "<head><title>标题</title></head><nav>导航</nav><main>主体内容</main><footer>底部</footer><script>alert(1)</script><style>body{}</style>",
        );
        expect(result).not.toContain("标题");
        expect(result).not.toContain("导航");
        expect(result).not.toContain("底部");
        expect(result).not.toContain("alert(1)");
        expect(result).not.toContain("body");
        expect(result).toContain("主体内容");
    });

    it("hr 应转换为 ---", () => {
        const result = priv.htmlToMarkdown("<p>上方</p><hr><p>下方</p>");
        expect(result).toContain("---");
    });

    it("br 应转换为换行", () => {
        const result = priv.htmlToMarkdown("第一行<br>第二行<br/>第三行");
        expect(result).toContain("\n");
        // 由于需要 split 才能验证，这里验证 br 处理后不再是原始状态
        expect(result).not.toContain("<br");
    });
});

describe("WebFetchTool — 实体解码", () => {
    const tool = new WebFetchTool();
    const priv = getPrivate(tool);

    it("应解码 &amp;", () => {
        expect(priv.decodeEntities("a &amp; b")).toBe("a & b");
    });

    it("应解码 &lt; 和 &gt;", () => {
        expect(priv.decodeEntities("&lt;div&gt;")).toBe("<div>");
    });

    it("应解码 &quot;", () => {
        expect(priv.decodeEntities('&quot;hello&quot;')).toBe('"hello"');
    });

    it("应解码 &nbsp;", () => {
        expect(priv.decodeEntities("a&nbsp;b")).toBe("a b");
    });

    it("应解码 &#x27; / &#39; / &apos;", () => {
        expect(priv.decodeEntities("&#x27;test&#39;")).toBe("'test'");
    });

    it("未识别的实体应保留原样", () => {
        expect(priv.decodeEntities("&unknown;")).toBe("&unknown;");
    });
});

describe("WebFetchTool — 行内 HTML 剥离", () => {
    const tool = new WebFetchTool();
    const priv = getPrivate(tool);

    it("应移除 HTML 标签保留文字", () => {
        expect(priv.stripInlineHtml("<span>文字</span>")).toBe("文字");
    });

    it("应处理嵌套标签", () => {
        expect(priv.stripInlineHtml("<a><b>嵌套文字</b></a>")).toBe("嵌套文字");
    });
});

describe("WebFetchTool — 响应格式化", () => {
    const tool = new WebFetchTool();
    const priv = getPrivate(tool);

    it("应包含 URL", () => {
        const result = priv.formatResponse("https://example.com", undefined, "内容", false);
        expect(result).toContain("https://example.com");
    });

    it("fromCache=true 时应标记缓存", () => {
        const result = priv.formatResponse("https://example.com", undefined, "内容", true);
        expect(result).toContain("(来自缓存)");
    });

    it("fromCache=false 时不应有缓存标记", () => {
        const result = priv.formatResponse("https://example.com", undefined, "内容", false);
        expect(result).not.toContain("(来自缓存)");
    });

    it("应包含 prompt 提取目标", () => {
        const result = priv.formatResponse("https://example.com", "提取 API 文档", "内容", false);
        expect(result).toContain("提取目标: 提取 API 文档");
    });

    it("内容超过 10000 字符时应截断", () => {
        const longContent = "a".repeat(15000);
        const result = priv.formatResponse("https://example.com", undefined, longContent, false);
        expect(result).toContain("...(内容已截断)");
        expect(result.length).toBeLessThan(15000);
    });

    it("内容不超过 10000 字符时不应截断", () => {
        const shortContent = "hello world";
        const result = priv.formatResponse("https://example.com", undefined, shortContent, false);
        expect(result).not.toContain("内容已截断");
        expect(result).toContain("hello world");
    });
});

describe("WebFetchTool — 元数据", () => {
    const tool = new WebFetchTool();

    it("name 应为 WebFetch", () => {
        expect(tool.name).toBe("WebFetch");
    });

    it("requiresApproval 应返回 true", () => {
        expect(tool.requiresApproval()).toBe(true);
    });

    it("parameters 应包含 url (required)", () => {
        expect(tool.parameters.required).toContain("url");
    });

    it("parameters 应包含 prompt (optional)", () => {
        expect(tool.parameters.properties.prompt).toBeDefined();
    });
});

describe("WebFetchTool — HTTP 请求（mock fetch）", () => {
    let tool: WebFetchTool;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        tool = new WebFetchTool();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("成功请求应返回格式化内容", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: "OK",
            headers: new Map([["content-type", "text/html"]]),
            text: async () => "<html><body><h1>Hello</h1><p>World</p></body></html>",
        } as unknown as Response);

        const result = await tool.execute({ url: "https://example.com" }, {} as never);
        expect(result.is_error).toBeFalsy();
        expect(result.content).toContain("# Hello");
        expect(result.content).toContain("World");
    });

    it("HTTP 错误状态码应返回错误", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            statusText: "Not Found",
        } as unknown as Response);

        const result = await tool.execute({ url: "https://example.com/notfound" }, {} as never);
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("HTTP 错误: 404");
    });

    it("fetch 抛出异常时应返回请求失败", async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error("网络超时"));

        const result = await tool.execute({ url: "https://example.com" }, {} as never);
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("请求失败");
    });

    it("15 分钟内重复请求同一 URL 应返回缓存", async () => {
        let fetchCount = 0;
        globalThis.fetch = vi.fn().mockImplementation(() => {
            fetchCount++;
            return Promise.resolve({
                ok: true,
                status: 200,
                statusText: "OK",
                headers: new Map([["content-type", "text/html"]]),
                text: async () => "<html><body>test</body></html>",
            } as unknown as Response);
        });

        await tool.execute({ url: "https://example.com" }, {} as never);
        expect(fetchCount).toBe(1);

        const result = await tool.execute({ url: "https://example.com" }, {} as never);
        expect(fetchCount).toBe(1); // 未新增 fetch 调用
        expect(result.content).toContain("(来自缓存)");
    });
});
