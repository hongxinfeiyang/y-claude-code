/**
 * skills/loader.ts — Skill 加载器
 *
 * 【是什么】
 *   从 Markdown 文件中加载 Skill 定义（技能模块），解析其 frontmatter 元数据
 *   和正文内容，并将所有已加载 Skill 的内容注入到 system prompt 中，
 *   让 LLM 知道有哪些可用技能以及何时调用它们。
 *
 * 【解决什么问题】
 *   1. 技能模块化：将领域知识、工作流程、最佳实践封装为独立的 .md 文件，
 *      每个 Skill 解决一个特定问题（如 "代码审查"、"安全扫描"、"部署脚本生成"）。
 *      避免把所有知识塞进一个巨大的 system prompt 中。
 *   2. 三级覆盖机制（内置 < 项目 < 用户）：同名的 Skill 可以被更高优先级的
 *      版本覆盖。用户可以在项目级或用户级定制/增强内置 Skill。
 *   3. System Prompt 动态拼接：根据当前工作目录加载项目级 Skill，
 *      将 Skill 内容动态注入 system prompt，让 LLM 获得项目特定的能力。
 *   4. 零依赖 YAML 解析：Skill 文件使用 YAML frontmatter 定义元数据，
 *      通过内置简单解析器处理，避免引入完整的 YAML 库增加依赖体积。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/**
 * SkillDefinition — 单个技能的定义
 *
 * 来源：Markdown 文件的 YAML frontmatter + 正文
 *
 * 为什么使用 .md 格式：
 *   - Markdown 对人类和 AI 都友好，可读性强
 *   - 用户可以直接编辑，无需学习新语法
 *   - VCS（Git）对 .md 文件的 diff/merge 支持成熟
 */
export interface SkillDefinition {
    /** 技能名称（唯一标识符，用于匹配和覆盖） */
    name: string;
    /** 技能描述（帮助 LLM 判断何时调用此技能） */
    description: string;
    /**
     * 技能级别（优先级：function > module > project）
     *   - project：项目级技能（如 "运行此项目的测试"）
     *   - module：模块级技能（如 "操作 PostgreSQL 数据库"）
     *   - function：功能级技能（如 "生成单元测试模板"）
     */
    level: "project" | "module" | "function";
    /** Markdown 正文内容（注入到 system prompt，告诉 LLM 如何使用此技能） */
    content: string;
    /** 来源文件路径（用于调试和日志） */
    source: string;
}

/**
 * SkillLoader — 技能加载器
 *
 * 加载流程：
 *   1. 清除已有 Skill 缓存
 *   2. 加载内置 Skill（packages/core/src/skills/builtin/）
 *   3. 加载项目 Skill（{workingDir}/.y-claude/skills/）
 *   4. 加载用户 Skill（~/.y-claude-code/skills/）
 *   5. 后加载的同名 Skill 覆盖先加载的（实现优先级：用户 > 项目 > 内置）
 */
export class SkillLoader {
    /** 已加载的技能表，key = skill name */
    private skills: Map<string, SkillDefinition> = new Map();

    /**
     * 从指定目录加载所有 .md 技能文件
     *
     * 为什么用 Map 存储并用 name 去重：
     *   - 同名 Skill 后加载覆盖先加载，实现优先级覆盖机制
     *   - Map 的 O(1) 查找效率高
     *
     * 为什么目录不存在时静默跳过：
     *   - 项目和用户可能没有自定义 Skill 目录，这不是错误
     *   - 只有内置 Skill 目录是必须存在的
     *
     * @param dir — Skill 文件所在目录路径
     */
    async loadFromDirectory(dir: string): Promise<void> {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                // 只加载 .md 文件，忽略子目录和其他格式
                if (entry.isFile() && entry.name.endsWith(".md")) {
                    const filePath = path.join(dir, entry.name);
                    const skill = await this.parseSkillFile(filePath);
                    if (skill) {
                        // 同名覆盖：后加载的（更高优先级）替换先加载的
                        this.skills.set(skill.name, skill);
                    }
                }
            }
        } catch {
            // 目录不存在时静默跳过，不是错误
        }
    }

    /**
     * 加载所有 Skill（内置 + 项目 + 用户级别）
     *
     * 加载顺序决定了优先级：
     *   第 1 步加载内置 Skill → 最低优先级，提供默认能力
     *   第 2 步加载项目 Skill → 中等优先级，项目可定制内置 Skill
     *   第 3 步加载用户 Skill → 最高优先级，用户可覆盖一切
     *
     * 何时调用：
     *   - 应用启动时
     *   - 用户切换工作目录后（项目级 Skill 可能变化）
     *
     * @param workingDirectory — 当前项目工作目录，用于定位项目级 Skill
     */
    async loadAll(workingDirectory: string): Promise<void> {
        // 清除旧缓存，避免切换项目后残留上一项目的 Skill
        this.skills.clear();

        // ─── 1. 内置 Skill（最低优先级） ───
        // 内置 Skill 定义在 packages/core/src/skills/builtin/ 目录下
        // 提供基础能力如：file-editing、code-review、git-operations 等
        const builtinDir = path.join(import.meta.dirname ?? __dirname, "builtin");
        await this.loadFromDirectory(builtinDir);

        // ─── 2. 项目级 Skill（中等优先级） ───
        // 项目可以在 .y-claude/skills/ 下定义项目特定的 Skill
        // 例如：run-tests、deploy-staging、database-migration 等
        const projectSkillsDir = path.join(workingDirectory, ".y-claude", "skills");
        await this.loadFromDirectory(projectSkillsDir);

        // ─── 3. 用户级 Skill（最高优先级） ───
        // 用户在 ~/.y-claude-code/skills/ 下定义的全局 Skill
        // 可以覆盖同名的内置或项目 Skill，实现个性化定制
        const userSkillsDir = path.join(os.homedir(), ".y-claude-code", "skills");
        await this.loadFromDirectory(userSkillsDir);
    }

    /**
     * 按名称获取指定 Skill
     *
     * @param name — Skill 名称
     * @returns Skill 定义，不存在则返回 undefined
     */
    get(name: string): SkillDefinition | undefined {
        return this.skills.get(name);
    }

    /**
     * 列出所有已加载的 Skill（完整信息）
     *
     * @returns 所有 Skill 定义的数组
     */
    listAll(): SkillDefinition[] {
        return Array.from(this.skills.values());
    }

    /**
     * 列出所有已加载的 Skill 名称
     *
     * 为什么单独提供 name-only 版本：
     *   - 某些场景只需要名称列表（如展示可用 Skill 列表、Tab 补全）
     *   - 避免传输完整的 content 字段减少内存开销
     *
     * @returns 所有 Skill 名称的数组
     */
    listNames(): string[] {
        return Array.from(this.skills.keys());
    }

    /**
     * 将所有已加载 Skill 的内容拼接为 system prompt 的一个章节
     *
     * 拼接格式：
     *   ```
     *   ## 可用技能 (Skills)
     *   ## Skill: <name>
     *   **描述**: <description>
     *   **级别**: <level>
     *   <content>
     *   ```
     *
     * 为什么拼到 system prompt 而不是作为 tool 定义：
     *   - Skill 是"指导 LLM 如何进行某项任务"的知识，不是可调用的工具
     *   - 放在 system prompt 中让 LLM 始终看到可用技能，自主决定何时应用
     *
     * @returns 格式化后的 system prompt 片段，无 Skill 时返回空字符串
     */
    buildSystemPromptSection(): string {
        const allSkills = this.listAll();
        if (allSkills.length === 0) return "";

        const sections = allSkills.map((skill) => {
            return `## Skill: ${skill.name}
**描述**: ${skill.description}
**级别**: ${skill.level}

${skill.content}`;
        });

        return `\n\n---\n## 可用技能 (Skills)\n\n${sections.join("\n\n")}\n`;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 私有方法
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 解析单个 Skill 的 Markdown 文件
     *
     * 文件格式要求：
     *   ```
     *   ---
     *   name: my-skill
     *   description: 这是一个示例技能
     *   level: project
     *   ---
     *   技能正文内容（Markdown 格式）
     *   ```
     *
     * 为什么要求 name 和 content 都不为空：
     *   - 没有 name 的 Skill 无法被引用和覆盖
     *   - 没有 content 的 Skill 对 LLM 没有价值
     *
     * @param filePath — Skill Markdown 文件路径
     * @returns 解析成功返回 SkillDefinition，失败返回 null（静默跳过）
     */
    private async parseSkillFile(filePath: string): Promise<SkillDefinition | null> {
        try {
            const raw = await fs.readFile(filePath, "utf-8");

            // ─── 解析 YAML frontmatter（以 --- 包围的元数据块） ───
            // 正则：匹配开头的 --- ... --- ... 结构
            const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
            if (!fmMatch) return null; // 没有 frontmatter，不是有效的 Skill 文件

            const frontmatter = this.parseSimpleYaml(fmMatch[1]);
            const content = fmMatch[2].trim();

            // 必须字段校验：name 和 content 缺一不可
            if (!frontmatter.name || !content) return null;

            return {
                name: frontmatter.name as string,
                description: (frontmatter.description as string) ?? "",
                level: (frontmatter.level as "project" | "module" | "function") ?? "function",
                content,
                source: filePath,
            };
        } catch {
            // 文件读取失败或格式错误，静默跳过该文件
            return null;
        }
    }

    /**
     * 简单 YAML 解析器（仅支持 key: value 格式）
     *
     * 为什么不引入完整的 YAML 库：
     *   - Skill 文件的 frontmatter 是简单的 key: value 结构，不需要完整 YAML 解析
     *   - 减少 npm 依赖数量和安装体积
     *   - 避免 YAML 库可能的安全漏洞（如 js-yaml 的 unsafeLoad）
     *
     * 解析规则：
     *   - 每行格式：key: value
     *   - colonIndex > 0 确保 key 不为空
     *   - 不支持嵌套结构、列表、引用等高级 YAML 特性
     *
     * @param yaml — frontmatter 的字符串内容
     * @returns 解析后的键值对
     */
    private parseSimpleYaml(yaml: string): Record<string, string> {
        const result: Record<string, string> = {};
        for (const line of yaml.split("\n")) {
            const colonIndex = line.indexOf(":");
            // colonIndex > 0 确保冒号不在行首（key 非空）
            if (colonIndex > 0) {
                const key = line.slice(0, colonIndex).trim();
                const value = line.slice(colonIndex + 1).trim();
                result[key] = value;
            }
        }
        return result;
    }
}
