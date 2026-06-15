/**
 * memory/types.ts — Memory 系统类型定义
 *
 * 【是什么】
 *   定义 Memory（记忆）系统所需的 TypeScript 类型：记忆类型枚举、Memory 条目、
 *   索引条目。被 memory/store.ts 引用，确保记忆系统的类型安全。
 *
 * 【解决什么问题】
 *   1. 类型安全：编译期确保记忆的 type、name、related 等字段类型正确
 *   2. 接口契约：明确定义 MemoryEntry 和 MemoryIndexEntry 的结构
 *   3. 代码可读性：通过 MemoryType 联合类型自文档化记忆分类
 */

/**
 * MemoryType — 记忆类型分类
 *
 * 分类依据（为什么需要分类）：
 *   - 不同类型按不同优先级和生命周期管理
 *   - user：跨项目的用户偏好和习惯
 *   - feedback：用户对 AI 行为的反馈，用于持续改进
 *   - project：项目特定的约定、架构信息
 *   - reference：通用参考资料（如 API 文档、术语表）
 */
export type MemoryType = "user" | "feedback" | "project" | "reference";

/**
 * MemoryEntry — 记忆条目
 *
 * 每个条目对应一个 .md 文件，存储在 ~/.y-claude-code/memory/ 或
 * .y-claude/memory/ 目录下。
 *
 * 设计思路：
 *   - name 是文件 slug，也是用户引用记忆的标识符
 *   - description 用于系统判断该记忆是否与当前问题相关
 *   - content 是 Markdown 正文，作为注入 LLM 上下文的内容
 *   - related 实现记忆间的关联网络（通过 [[wiki-link]] 语法）
 */
export interface MemoryEntry {
    /** 短横线命名的唯一标识符（对应文件名，不含 .md 后缀） */
    name: string;
    /** 一句话描述，用于 LLM 判断该记忆是否与当前问题相关 */
    description: string;
    /** 记忆类型（影响加载优先级和生命周期） */
    type: MemoryType;
    /** Markdown 格式的正文内容（注入到 system prompt 中） */
    content: string;
    /** 关联的其他记忆 name 列表（相互引用形成知识网络） */
    related: string[];
    /** 最后更新时间（ISO 8601 格式） */
    updatedAt: string;
}

/**
 * MemoryIndexEntry — MEMORY.md 索引中的条目
 *
 * MEMORY.md 是所有记忆的索引文件，类似于 README 之于项目文件。
 * 每行的格式为：- [Title](file.md) — description
 */
export interface MemoryIndexEntry {
    /** 记忆标题（用于展示） */
    title: string;
    /** 对应的 .md 文件名 */
    file: string;
    /** 一句话描述 */
    description: string;
}
