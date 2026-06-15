// ─── packages/core/src/skills/__tests__/loader.test.ts ───
// 技能加载器测试 — 覆盖加载、优先级、frontmatter 解析、system prompt 构建

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLoader, type SkillDefinition } from "../loader";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── 辅助：创建临时 Skill 文件 ───

function createSkillFile(dir: string, name: string, opts: {
    description?: string;
    level?: string;
    content?: string;
} = {}) {
    const desc = opts.description ?? `${name} 的描述`;
    const level = opts.level ?? "function";
    const body = opts.content ?? `# ${name}\n\n这是 ${name} 的技能内容。`;

    const text = `---
name: ${name}
description: ${desc}
level: ${level}
---
${body}`;

    writeFileSync(join(dir, `${name}.md`), text);
}

// ═══════════════════════════════════════════════════════════════════════════════
// loadFromDirectory — 单目录加载
// ═══════════════════════════════════════════════════════════════════════════════

describe("SkillLoader — loadFromDirectory", () => {
    let loader: SkillLoader;
    let testDir: string;

    beforeEach(() => {
        loader = new SkillLoader();
        testDir = join(tmpdir(), `y-claude-skills-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("应加载目录中所有 .md 文件", async () => {
        createSkillFile(testDir, "skill-a");
        createSkillFile(testDir, "skill-b");

        await loader.loadFromDirectory(testDir);

        expect(loader.listNames()).toHaveLength(2);
        expect(loader.get("skill-a")).toBeDefined();
        expect(loader.get("skill-b")).toBeDefined();
    });

    it("目录不存在时应静默跳过", async () => {
        await loader.loadFromDirectory("/nonexistent/skills/dir");
        expect(loader.listAll()).toEqual([]);
    });

    it("应忽略非 .md 文件", async () => {
        writeFileSync(join(testDir, "readme.txt"), "not a skill");
        writeFileSync(join(testDir, "notes.md"), "no frontmatter = ignored");

        await loader.loadFromDirectory(testDir);
        // notes.md 无 frontmatter，skill 解析失败 → 0 个 skill
        expect(loader.listNames()).toHaveLength(0);
    });

    it("空目录应返回空结果", async () => {
        await loader.loadFromDirectory(testDir);
        expect(loader.listAll()).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseSkillFile / parseSimpleYaml — 通过 loadFromDirectory 间接验证
// ═══════════════════════════════════════════════════════════════════════════════

describe("SkillLoader — Skill 文件解析", () => {
    let loader: SkillLoader;
    let testDir: string;

    beforeEach(() => {
        loader = new SkillLoader();
        testDir = join(tmpdir(), `y-claude-skills-parse-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("应正确解析 frontmatter 字段", async () => {
        createSkillFile(testDir, "parse-test", {
            description: "测试解析",
            level: "module",
            content: "技能正文",
        });

        await loader.loadFromDirectory(testDir);
        const skill = loader.get("parse-test")!;

        expect(skill.name).toBe("parse-test");
        expect(skill.description).toBe("测试解析");
        expect(skill.level).toBe("module");
        expect(skill.content).toBe("技能正文");
        expect(skill.source).toContain("parse-test.md");
    });

    it("无 name 字段的 Skill 应被跳过", async () => {
        writeFileSync(join(testDir, "no-name.md"), `---
description: 缺少 name 字段
level: function
---
一些内容`);

        await loader.loadFromDirectory(testDir);
        expect(loader.listAll()).toEqual([]);
    });

    it("无正文内容（content 为空）的 Skill 应被跳过", async () => {
        writeFileSync(join(testDir, "empty.md"), `---
name: empty-skill
description: 内容为空
---
`);

        await loader.loadFromDirectory(testDir);
        expect(loader.get("empty-skill")).toBeUndefined();
    });

    it("无 frontmatter 的 .md 文件应被跳过", async () => {
        writeFileSync(join(testDir, "nofm.md"), "# 直接就是内容\n无 frontmatter");

        await loader.loadFromDirectory(testDir);
        expect(loader.listAll()).toEqual([]);
    });

    it("默认 level 应为 function", async () => {
        writeFileSync(join(testDir, "default-level.md"), `---
name: default-level
description: 无 level 字段
---
内容`);

        await loader.loadFromDirectory(testDir);
        expect(loader.get("default-level")!.level).toBe("function");
    });

    it("默认 description 应为空字符串", async () => {
        writeFileSync(join(testDir, "no-desc.md"), `---
name: no-desc
---
内容`);

        await loader.loadFromDirectory(testDir);
        expect(loader.get("no-desc")!.description).toBe("");
    });

    it("格式损坏的文件应静默跳过", async () => {
        writeFileSync(join(testDir, "broken.md"), "这不是有效的 skill 文件");

        await loader.loadFromDirectory(testDir);
        expect(loader.listAll()).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 同名覆盖 — 优先级机制
// ═══════════════════════════════════════════════════════════════════════════════

describe("SkillLoader — 同名覆盖（优先级）", () => {
    let loader: SkillLoader;

    beforeEach(() => {
        loader = new SkillLoader();
    });

    it("后加载的同名 Skill 应覆盖先加载的", async () => {
        const dir1 = join(tmpdir(), `y-claude-skills-prio-low-${Date.now()}`);
        const dir2 = join(tmpdir(), `y-claude-skills-prio-high-${Date.now()}`);
        mkdirSync(dir1, { recursive: true });
        mkdirSync(dir2, { recursive: true });

        try {
            createSkillFile(dir1, "shared-skill", { description: "低优先级版本", content: "低优先级内容" });
            createSkillFile(dir2, "shared-skill", { description: "高优先级版本", content: "高优先级内容" });

            await loader.loadFromDirectory(dir1);
            await loader.loadFromDirectory(dir2); // dir2 后加载，覆盖 dir1

            const skill = loader.get("shared-skill")!;
            expect(skill.description).toBe("高优先级版本");
            expect(skill.content).toBe("高优先级内容");
        } finally {
            rmSync(dir1, { recursive: true, force: true });
            rmSync(dir2, { recursive: true, force: true });
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadAll — 完整加载流程
// ═══════════════════════════════════════════════════════════════════════════════

describe("SkillLoader — loadAll", () => {
    it("loadAll 应清空旧缓存再重新加载", async () => {
        const loader = new SkillLoader();
        const testDir = join(tmpdir(), `y-claude-skills-all-${Date.now()}`);
        const skillsDir = join(testDir, ".y-claude", "skills");
        mkdirSync(skillsDir, { recursive: true });

        try {
            createSkillFile(skillsDir, "project-skill");

            // 先手动设置一个缓存值（模拟旧数据）
            (loader as unknown as Record<string, Map<string, unknown>>)["skills"].set("stale", {
                name: "stale",
                description: "旧缓存",
                level: "function",
                content: "旧内容",
                source: "none",
            });

            await loader.loadAll(testDir);

            // 旧缓存应被清除
            expect(loader.get("stale")).toBeUndefined();
            // 新 skill 应被加载
            expect(loader.get("project-skill")).toBeDefined();
        } finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("无项目 Skill 目录时应正常完成不抛异常", async () => {
        const loader = new SkillLoader();
        const emptyDir = join(tmpdir(), `y-claude-skills-noproj-${Date.now()}`);
        mkdirSync(emptyDir, { recursive: true });

        try {
            await loader.loadAll(emptyDir);
            // 不应抛异常
        } finally {
            rmSync(emptyDir, { recursive: true, force: true });
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// get / listAll / listNames
// ═══════════════════════════════════════════════════════════════════════════════

describe("SkillLoader — get / listAll / listNames", () => {
    let loader: SkillLoader;
    let testDir: string;

    beforeEach(async () => {
        loader = new SkillLoader();
        testDir = join(tmpdir(), `y-claude-skills-list-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });

        createSkillFile(testDir, "skill-1");
        createSkillFile(testDir, "skill-2");
        createSkillFile(testDir, "skill-3");
        await loader.loadFromDirectory(testDir);
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it("get 应返回指定 Skill", () => {
        const skill = loader.get("skill-2");
        expect(skill).toBeDefined();
        expect(skill!.name).toBe("skill-2");
    });

    it("get 不存在的 Skill 应返回 undefined", () => {
        expect(loader.get("nonexistent")).toBeUndefined();
    });

    it("listAll 应返回所有 Skill 的数组", () => {
        const all = loader.listAll();
        expect(all).toHaveLength(3);
        expect(all.every((s) => s instanceof Object)).toBe(true);
    });

    it("listNames 应只返回名称列表", () => {
        const names = loader.listNames();
        expect(names).toHaveLength(3);
        expect(names).toContain("skill-1");
        expect(names).toContain("skill-2");
        expect(names).toContain("skill-3");
        // 验证返回的是字符串数组，不是对象
        expect(typeof names[0]).toBe("string");
    });

    it("空 SkillLoader 的 listAll 应返回空数组", () => {
        const empty = new SkillLoader();
        expect(empty.listAll()).toEqual([]);
        expect(empty.listNames()).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildSystemPromptSection
// ═══════════════════════════════════════════════════════════════════════════════

describe("SkillLoader — buildSystemPromptSection", () => {
    let loader: SkillLoader;
    let testDir: string;

    beforeEach(async () => {
        loader = new SkillLoader();
        testDir = join(tmpdir(), `y-claude-skills-prompt-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });

        createSkillFile(testDir, "code-review", {
            description: "代码审查技能",
            level: "module",
            content: "审查代码的最佳实践。",
        });
        await loader.loadFromDirectory(testDir);
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it("应包含 '可用技能 (Skills)' 标题", () => {
        const section = loader.buildSystemPromptSection();
        expect(section).toContain("可用技能 (Skills)");
    });

    it("应包含 Skill 名称、描述和级别", () => {
        const section = loader.buildSystemPromptSection();
        expect(section).toContain("Skill: code-review");
        expect(section).toContain("代码审查技能");
        expect(section).toContain("module");
    });

    it("应包含 Skill 正文内容", () => {
        const section = loader.buildSystemPromptSection();
        expect(section).toContain("审查代码的最佳实践。");
    });

    it("空 SkillLoader 应返回空字符串", () => {
        const empty = new SkillLoader();
        expect(empty.buildSystemPromptSection()).toBe("");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseSimpleYaml — 边界场景
// ═══════════════════════════════════════════════════════════════════════════════

describe("SkillLoader — parseSimpleYaml 边界", () => {
    it("应正确处理冒号在值中的情况", async () => {
        const loader = new SkillLoader();
        const testDir = join(tmpdir(), `y-claude-skills-colon-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });

        try {
            writeFileSync(join(testDir, "colon-value.md"), `---
name: colon-skill
description: 包含:冒号的值
---
内容`);

            await loader.loadFromDirectory(testDir);
            const skill = loader.get("colon-skill")!;
            expect(skill.description).toBe("包含:冒号的值");
        } finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("空行和注释行（无冒号）应被跳过", async () => {
        const loader = new SkillLoader();
        const testDir = join(tmpdir(), `y-claude-skills-blank-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });

        try {
            writeFileSync(join(testDir, "with-blanks.md"), `---
name: blank-skill
description: 有空行的 skill

level: project
---
内容有换行`);

            await loader.loadFromDirectory(testDir);
            const skill = loader.get("blank-skill")!;
            expect(skill.level).toBe("project");
        } finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
});
