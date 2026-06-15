/**
 * memory/store.ts — Memory 存储
 *
 * 【是什么】
 *   管理 ~/.y-claude-code/memory/（用户级）和 .y-claude/memory/（项目级）
 *   下的记忆文件。提供记忆的读取、写入、删除、搜索功能，以及 MEMORY.md
 *   索引文件的自动维护。
 *
 * 【解决什么问题】
 *   1. 长期记忆：LLM 默认是无状态的，每次对话都是"失忆"的。Memory 系统
 *      让 AI 能记住用户偏好、项目约定、历史决策等跨越会话的信息。
 *   2. 双层记忆：用户级记忆（跨项目通用偏好）和项目级记忆（项目特定规范）
 *      分离存储，按需加载，避免混合导致混乱。
 *   3. 自动索引：通过 MEMORY.md 索引文件，快速列出所有可用记忆，
 *      方便 LLM 在对话开始阶段浏览并决定加载哪些相关记忆。
 *   4. 知识网络：通过 [[wiki-link]] 语法建立记忆间的引用关系，
 *      加载一条记忆时可以顺藤摸瓜发现相关记忆。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { MemoryEntry, MemoryIndexEntry, MemoryType } from "./types";

/**
 * MemoryStore — 记忆存储管理器
 *
 * 存储结构：
 *   ~/.y-claude-code/memory/          ← 用户级记忆目录
 *     MEMORY.md                        ← 索引文件
 *     coding-style.md                  ← 具体记忆
 *     favorite-libraries.md
 *   {project}/.y-claude/memory/          ← 项目级记忆目录
 *     MEMORY.md                        ← 索引文件
 *     architecture.md                  ← 具体记忆
 *     api-conventions.md
 */
export class MemoryStore {
    /** 用户级记忆目录（~/.y-claude-code/memory/） */
    private userMemoryDir: string;
    /** 项目级记忆目录（{cwd}/.y-claude/memory/），未设置时为 null */
    private projectMemoryDir: string | null = null;

    /**
     * @param workingDirectory — 可选的工作目录，用于初始化项目级记忆目录
     */
    constructor(workingDirectory?: string) {
        this.userMemoryDir = path.join(os.homedir(), ".y-claude-code", "memory");
        if (workingDirectory) {
            this.projectMemoryDir = path.join(workingDirectory, ".y-claude", "memory");
        }
    }

    /**
     * 设置/更新项目根目录
     *
     * 使用场景：用户在对话中切换工作目录时调用
     *
     * @param workingDirectory — 新的项目根目录
     */
    setProjectRoot(workingDirectory: string): void {
        this.projectMemoryDir = path.join(workingDirectory, ".y-claude", "memory");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 读取操作
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 加载 MEMORY.md 索引文件
     *
     * MEMORY.md 格式：
     *   - [Coding Style](coding-style.md) — 项目的编码规范约定
     *   - [Architecture](architecture.md) — 系统架构概览
     *
     * 为什么需要索引文件：
     *   - 避免每次都需要扫描目录并解析所有 .md 文件的 frontmatter
     *   - 索引一次性提供所有记忆的标题和描述，方便 LLM 筛选相关记忆
     *   - 类似 README，人类也可直接浏览
     *
     * @param source — 加载来源："user"（用户级）或 "project"（项目级）
     * @returns 索引条目列表，文件不存在则返回空数组
     */
    async loadIndex(source: "user" | "project"): Promise<MemoryIndexEntry[]> {
        const dir = source === "user" ? this.userMemoryDir : this.projectMemoryDir;
        if (!dir) return [];

        try {
            const content = await fs.readFile(path.join(dir, "MEMORY.md"), "utf-8");
            return this.parseIndex(content);
        } catch {
            // 索引文件不存在（新项目/新用户），返回空列表
            return [];
        }
    }

    /**
     * 加载单个记忆文件
     *
     * 文件格式：
     *   ---
     *   name: coding-style
     *   description: 项目的编码规范约定
     *   metadata:
     *     type: project
     *   ---
     *   记忆正文（Markdown 格式）
     *
     * @param name — 记忆名称（不含 .md 后缀）
     * @param source — 加载来源："user" 或 "project"
     * @returns 记忆条目，文件不存在或格式错误返回 null
     */
    async load(name: string, source: "user" | "project"): Promise<MemoryEntry | null> {
        const dir = source === "user" ? this.userMemoryDir : this.projectMemoryDir;
        if (!dir) return null;

        try {
            const raw = await fs.readFile(path.join(dir, `${name}.md`), "utf-8");
            return this.parseMemoryFile(raw, name);
        } catch {
            return null;
        }
    }

    /**
     * 加载指定来源的所有记忆
     *
     * 加载策略：
     *   - 遍历目录中所有 .md 文件（跳过 MEMORY.md 索引文件本身）
     *   - 逐个解析，失败的跳过（不因一个文件损坏中断整体加载）
     *   - 返回完整的 MemoryEntry 数组
     *
     * @param source — 加载来源："user" 或 "project"
     * @returns 所有记忆条目的数组
     */
    async loadAll(source: "user" | "project"): Promise<MemoryEntry[]> {
        const dir = source === "user" ? this.userMemoryDir : this.projectMemoryDir;
        if (!dir) return [];

        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const memories: MemoryEntry[] = [];

            for (const entry of entries) {
                // 跳过 MEMORY.md（索引文件）和非 .md 文件
                if (!entry.isFile() || entry.name === "MEMORY.md" || !entry.name.endsWith(".md")) continue;

                const name = entry.name.replace(".md", "");
                const memory = await this.load(name, source);
                if (memory) memories.push(memory);
            }

            return memories;
        } catch {
            // 目录不存在，返回空数组
            return [];
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 写入操作
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 保存记忆文件（自动更新 MEMORY.md 索引）
     *
     * 写入流程：
     *   1. 确保目录存在
     *   2. 生成带 frontmatter 的 Markdown 文件
     *   3. 写入 {name}.md
     *   4. 更新 MEMORY.md 索引（追加或替换同名条目）
     *
     * 为什么每次保存都更新索引：
     *   - 保持 MEMORY.md 与实际文件状态一致
     *   - MEMORY.md 是 LLM 浏览记忆的入口，必须反映最新状态
     *
     * @param memory — 要保存的记忆条目
     * @param source — 保存到："user"（默认）或 "project"
     */
    async save(memory: MemoryEntry, source: "user" | "project" = "user"): Promise<void> {
        const dir = source === "user" ? this.userMemoryDir : this.projectMemoryDir;
        if (!dir) throw new Error("未设置项目记忆目录");

        // 确保目标目录存在
        await fs.mkdir(dir, { recursive: true });

        // ─── 生成带 frontmatter 的记忆文件内容 ───
        // frontmatter 用于结构化存储元数据，正文是 Markdown 格式的知识内容
        const frontmatter = [
            "---",
            `name: ${memory.name}`,
            `description: ${memory.description}`,
            "metadata:",
            `  type: ${memory.type}`,
            "---",
        ].join("\n");

        const fileContent = `${frontmatter}\n\n${memory.content}`;
        await fs.writeFile(path.join(dir, `${memory.name}.md`), fileContent, "utf-8");

        // ─── 更新索引文件 ───
        // 确保 MEMORY.md 中有该记忆的条目
        await this.updateIndex(dir, memory);
    }

    /**
     * 删除记忆（同时从索引中移除）
     *
     * 为什么删除失败不抛异常：
     *   - 文件可能已被手动删除，静默处理更友好
     *   - 删除是幂等操作：重复删除不应报错
     *
     * @param name — 要删除的记忆名称
     * @param source — 删除来源："user"（默认）或 "project"
     */
    async remove(name: string, source: "user" | "project" = "user"): Promise<void> {
        const dir = source === "user" ? this.userMemoryDir : this.projectMemoryDir;
        if (!dir) return;

        try {
            // 删除记忆文件
            await fs.unlink(path.join(dir, `${name}.md`));
            // 从 MEMORY.md 索引中移除对应条目
            await this.removeFromIndex(dir, name);
        } catch {
            // 文件不存在，忽略（幂等操作）
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 搜索操作
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 简单关键词搜索记忆（同时搜索用户级和项目级）
     *
     * 搜索范围：name + description + content 三个字段（全部转小写匹配）
     *
     * 为什么使用简单字符串匹配而非全文搜索引擎：
     *   - 记忆数量通常不大（< 100 条）
     *   - 避免引入 elasticsearch/minisearch 等重型依赖
     *   - 简单匹配足够满足查找需求
     *
     * @param keyword — 搜索关键词
     * @returns 匹配的记忆条目数组
     */
    async search(keyword: string): Promise<MemoryEntry[]> {
        const userMemories = await this.loadAll("user");
        const projectMemories = await this.loadAll("project");

        // 合并两级记忆，统一搜索
        const all = [...userMemories, ...projectMemories];
        const lower = keyword.toLowerCase();

        return all.filter(
            (m) =>
                m.name.toLowerCase().includes(lower) ||
                m.description.toLowerCase().includes(lower) ||
                m.content.toLowerCase().includes(lower),
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 私有方法
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 解析 MEMORY.md 索引文件内容
     *
     * 支持的格式：
     *   - [Title](file.md) — description     (使用 — em-dash)
     *   - [Title](file.md) — description     (使用 — en-dash)
     *   - [Title](file.md) - description     (使用 ASCII hyphen)
     *
     * 为什么支持多种分隔符：
     *   - 不同编辑器和用户的输入习惯不同，兼容常见分隔符提升容错性
     *
     * @param content — MEMORY.md 的全文内容
     * @returns 解析出的索引条目列表
     */
    private parseIndex(content: string): MemoryIndexEntry[] {
        const entries: MemoryIndexEntry[] = [];
        const lines = content.split("\n");

        for (const line of lines) {
            // 匹配格式: - [Title](file.md) — one-line description
            // [—–-] 同时匹配三种常见分隔符：em-dash、en-dash、hyphen
            const match = line.match(/^-\s+\[(.+?)\]\((.+?)\)\s*[—–-]\s*(.+)$/);
            if (match) {
                entries.push({ title: match[1], file: match[2], description: match[3] });
            }
        }

        return entries;
    }

    /**
     * 解析记忆 Markdown 文件
     *
     * 除 frontmatter 字段外，还会扫描正文中的 [[wiki-link]] 语法提取关联记忆。
     *
     * Wiki-link 语法：[[other-memory-name]]
     *   - 建立记忆间的引用关系
     *   - 类似 Obsidian/Roam Research 的双向链接
     *
     * @param raw — 文件原始内容
     * @param name — 记忆名称（来自文件名）
     * @returns 解析成功返回 MemoryEntry，失败返回 null
     */
    private parseMemoryFile(raw: string, name: string): MemoryEntry | null {
        // ─── 提取 frontmatter ───
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
        if (!fmMatch) return null;

        const frontmatter = this.parseSimpleYaml(fmMatch[1]);
        const content = fmMatch[2].trim();

        // ─── 提取 [[wiki-link]] 关联记忆 ───
        // 例：参见 [[coding-style]] 中的规则 → related: ["coding-style"]
        const related: string[] = [];
        const linkRegex = /\[\[(.+?)\]\]/g;
        let linkMatch;
        while ((linkMatch = linkRegex.exec(content)) !== null) {
            related.push(linkMatch[1]);
        }

        return {
            name: frontmatter.name ?? name,
            description: frontmatter.description ?? "",
            type: (frontmatter.type as MemoryType) ?? "user",
            content,
            related,
            updatedAt: new Date().toISOString(), // 每次读取都刷新时间，标记最后访问
        };
    }

    /**
     * 更新 MEMORY.md 索引文件
     *
     * 策略：
     *   - 如果同名条目已存在：移除旧条目，追加新条目（实现"更新"效果）
     *   - 如果同名条目不存在：直接追加
     *   - 限制索引不超过 200 行：防止索引无限增长
     *   - 过滤空行：保持文件整洁
     *
     * 为什么限制 200 行：
     *   - 超过 200 条记忆说明用户记忆管理需要整理
     *   - 索引文件过大会降低加载性能和 LLM 浏览效率
     *
     * @param dir — 记忆目录路径
     * @param memory — 要更新到索引的记忆条目
     */
    private async updateIndex(dir: string, memory: MemoryEntry): Promise<void> {
        const indexPath = path.join(dir, "MEMORY.md");
        let existingContent = "";

        try {
            existingContent = await fs.readFile(indexPath, "utf-8");
        } catch {
            // 索引文件不存在，从空开始创建
        }

        const newEntry = `- [${memory.name}](${memory.name}.md) — ${memory.description}`;

        // ─── 检查并移除已存在的同名条目 ───
        const lines = existingContent.split("\n");
        const existingIndex = lines.findIndex((l) => l.includes(`(${memory.name}.md)`));

        if (existingIndex >= 0) {
            // 移除旧条目（实现更新而非重复）
            lines.splice(existingIndex, 1);
        }
        lines.push(newEntry);

        // ─── 限制行数并过滤空行 ───
        // 保留最新 200 行（最旧的记忆条目会被丢弃）
        const trimmed = lines.filter(Boolean).slice(-200);

        await fs.writeFile(indexPath, trimmed.join("\n") + "\n", "utf-8");
    }

    /**
     * 从 MEMORY.md 索引中移除指定记忆的条目
     *
     * 为什么不在删除前检查是否存在：
     *   - filter 天然处理了"不存在时不操作"的情况
     *   - 直接过滤比先检查再过滤更简洁
     *
     * @param dir — 记忆目录路径
     * @param name — 要移除的记忆名称
     */
    private async removeFromIndex(dir: string, name: string): Promise<void> {
        const indexPath = path.join(dir, "MEMORY.md");
        try {
            const content = await fs.readFile(indexPath, "utf-8");
            // 过滤掉包含 (name.md) 的行（匹配索引条目格式）
            const lines = content.split("\n").filter((l) => !l.includes(`(${name}.md)`));
            await fs.writeFile(indexPath, lines.join("\n"), "utf-8");
        } catch {
            // 索引文件不存在，无需操作
        }
    }

    /**
     * 简单 YAML 解析器（支持嵌套属性）
     *
     * 与 Skill 的 parseSimpleYaml 不同，本解析器额外支持嵌套属性：
     *   以两个空格缩进的行被视为上一行的子属性
     *   例：
     *     metadata:
     *       type: project
     *   → result.type = "project"
     *
     * 为什么不用完整的 YAML 库：
     *   - 记忆文件 frontmatter 结构简单，不需要完整的 YAML 解析
     *   - 避免引入 js-yaml 等依赖增加包体积
     *
     * @param yaml — frontmatter 字符串
     * @returns 解析后的键值对（扁平化的，嵌套属性直接以属性名为 key）
     */
    private parseSimpleYaml(yaml: string): Record<string, string> {
        const result: Record<string, string> = {};
        let currentKey = ""; // 追踪当前父级 key，用于处理嵌套属性

        for (const line of yaml.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue; // 跳过空行

            if (line.startsWith("  ")) {
                // ─── 嵌套属性（用两个空格缩进标记） ───
                // 例：  type: project → 解析为 type = "project"
                const colonIndex = trimmed.indexOf(":");
                if (colonIndex > 0 && currentKey) {
                    result[trimmed.slice(0, colonIndex).trim()] = trimmed.slice(colonIndex + 1).trim();
                }
                continue;
            }

            // ─── 顶层属性 ───
            const colonIndex = line.indexOf(":");
            if (colonIndex > 0) {
                currentKey = line.slice(0, colonIndex).trim();
                result[currentKey] = line.slice(colonIndex + 1).trim();
            }
        }

        return result;
    }
}
