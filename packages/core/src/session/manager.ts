/**
 * session/manager.ts — 会话生命周期管理
 *
 * 【是什么】
 *   管理 AI 编程助手会话的完整生命周期：创建、恢复、列表、删除、消息持久化。
 *   包含 FileSessionStore（文件系统存储实现）和 SessionManager（业务逻辑层）。
 *
 * 【解决什么问题】
 *   1. 会话持久化：用户与 AI 的对话需要跨进程存续。关闭终端后再打开，
 *      应该能恢复之前的会话继续工作，而非从头开始。
 *   2. 多会话管理：用户可能同时处理多个任务，需要列表/切换/删除会话的能力。
 *   3. 存储抽象：通过 SessionStore 接口将存储层与业务逻辑解耦，
 *      当前使用 JSON 文件实现，未来可替换为 SQLite 等。
 *   4. 会话预览：列表时提取首条用户消息作为预览，快速辨别会话内容。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Message, TokenUsage } from "../types/messages";
import type { SessionData, SessionSummary, SessionStore } from "../types/session";

/**
 * FileSessionStore — 基于文件系统的会话存储实现
 *
 * 存储路径：~/.y-claude-code/sessions/{sessionId}.json
 *
 * 为什么用 JSON 文件而不是数据库：
 *   - 会话数据量不大（单个会话通常 < 1MB）
 *   - JSON 文件可读性强，方便用户手动查看和调试
 *   - 零依赖，不需要额外安装数据库驱动
 *   - 备份简单：直接复制目录即可
 *
 * 实现 SessionStore 接口，可替换为其他存储后端。
 */
export class FileSessionStore implements SessionStore {
    /** 会话文件存储根目录 */
    private baseDir: string;

    /**
     * @param baseDir — 存储目录路径，默认为 ~/.y-claude-code/sessions
     */
    constructor(baseDir?: string) {
        this.baseDir = baseDir ?? path.join(os.homedir(), ".y-claude-code", "sessions");
    }

    /**
     * 保存会话到文件
     *
     * 策略：全量写入 JSON，简单可靠。会话数据量小，无需增量更新。
     *
     * @param session — 完整会话数据对象
     */
    async save(session: SessionData): Promise<void> {
        // 确保目录存在（recursive 避免首次保存时因目录不存在而报错）
        await fs.mkdir(this.baseDir, { recursive: true });
        const filePath = path.join(this.baseDir, `${session.id}.json`);
        // 格式化 JSON（缩进 2 空格）便于人工查看和版本管理
        await fs.writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
    }

    /**
     * 加载指定会话
     *
     * 为什么返回 null 而不是抛异常：
     *   - 会话文件可能被用户手动删除，这是正常情况而非异常
     *   - 上层代码根据 null 判断"会话不存在"并给出友好提示
     *
     * @param sessionId — 会话 UUID
     * @returns 会话数据，不存在则返回 null
     */
    async load(sessionId: string): Promise<SessionData | null> {
        const filePath = path.join(this.baseDir, `${sessionId}.json`);
        try {
            const data = await fs.readFile(filePath, "utf-8");
            return JSON.parse(data) as SessionData;
        } catch {
            // 文件不存在或解析失败，统一返回 null
            return null;
        }
    }

    /**
     * 列出所有历史会话（摘要形式）
     *
     * 处理策略：
     *   - 遍历目录中所有 .json 文件，解析并提取摘要
     *   - 损坏的文件静默跳过，不中断整体列表
     *   - 按创建时间倒序排列，最近会话排在最前
     *
     * @returns 会话摘要列表（id + 时间 + 预览）
     */
    async list(): Promise<SessionSummary[]> {
        await fs.mkdir(this.baseDir, { recursive: true });
        const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
        const sessions: SessionSummary[] = [];

        for (const entry of entries) {
            // 只处理 .json 文件，跳过目录和其他类型文件
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            try {
                const content = await fs.readFile(path.join(this.baseDir, entry.name), "utf-8");
                const session = JSON.parse(content) as SessionData;
                sessions.push({
                    id: session.id,
                    createdAt: session.createdAt,
                    preview: this.extractPreview(session.messages),
                });
            } catch {
                // 损坏的会话文件静默跳过，不影响其他正常会话的展示
            }
        }

        // 按创建时间倒序：最新会话在前，方便用户快速找到最近的对话
        return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    /**
     * 删除指定会话
     *
     * 为什么用 .catch(() => {}) 而不是先检查存在性：
     *   - 先检查再删除存在竞态条件（TOCTOU）
     *   - unlink 在文件不存在时会抛错，直接 catch 比 fs.exists + unlink 更安全
     *
     * @param sessionId — 要删除的会话 UUID
     */
    async delete(sessionId: string): Promise<void> {
        const filePath = path.join(this.baseDir, `${sessionId}.json`);
        await fs.unlink(filePath).catch(() => {});
    }

    /**
     * 提取首条用户消息作为会话预览文本
     *
     * 为什么用首条用户消息：
     *   - 首条用户消息通常是用户提出的任务/问题，能最准确地概括会话主题
     *   - 80 字符截断足以在列表中辨识会话，过长会破坏终端排版
     *
     * @param messages — 会话全部消息
     * @returns 预览文本（最多 80 字符）
     */
    private extractPreview(messages: Message[]): string {
        const firstUserMsg = messages.find((m) => m.role === "user");
        if (!firstUserMsg) return "(空会话)";
        // 统一处理 content 的两种格式：string 或 ContentBlock[]
        const content = typeof firstUserMsg.content === "string"
            ? firstUserMsg.content
            : Array.isArray(firstUserMsg.content)
                ? firstUserMsg.content.map((b) => ("text" in b ? b.text : "")).join("")
                : String(firstUserMsg.content ?? "");
        return content.slice(0, 80);
    }
}

/**
 * SessionManager — 会话管理器（业务逻辑层）
 *
 * 职责：
 *   1. 维护当前活跃会话的引用
 *   2. 封装 create / resume / appendMessage / list / delete 等操作
 *   3. 自动将消息变更持久化到存储层
 *
 * 为什么需要单独的 Manager 层：
 *   - FileSessionStore 只负责数据存取，不关心"当前会话"状态
 *   - SessionManager 维护"当前活跃会话"的概念，这是业务逻辑层的关注点
 *   - 分离后可以独立测试存储层和业务层
 */
export class SessionManager {
    /** 当前活跃会话，null 表示未创建/未恢复任何会话 */
    private current: SessionData | null = null;
    /** 会话存储实例（可注入，默认文件存储） */
    private store: SessionStore;

    /**
     * @param store — 可选的 SessionStore 实现，用于依赖注入和测试
     */
    constructor(store?: SessionStore) {
        this.store = store ?? new FileSessionStore();
    }

    /**
     * 创建新会话
     *
     * 初始化时机：
     *   - 用户首次启动或使用 /new 命令时调用
     *   - 生成 UUID 作为会话唯一标识
     *   - 记录工作目录和模型选择（用于恢复时还原环境）
     *
     * @param workingDirectory — 会话绑定的工作目录
     * @param model — 用户选择的模型
     * @returns 新创建的会话数据
     */
    create(workingDirectory: string, model: string): SessionData {
        this.current = {
            id: randomUUID(), // UUID v4，全球唯一
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: [], // 空消息列表，等待用户首次输入
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            workingDirectory,
            model,
            metadata: {}, // 预留扩展字段
        };
        return this.current;
    }

    /**
     * 恢复历史会话
     *
     * 使用场景：
     *   - 用户在会话列表中选择历史会话恢复
     *   - 恢复后 current 指向该会话，后续 appendMessage 操作自动持久化
     *
     * @param sessionId — 要恢复的会话 ID
     * @returns 恢复的会话数据
     * @throws 会话不存在时抛出错误
     */
    async resume(sessionId: string): Promise<SessionData> {
        const data = await this.store.load(sessionId);
        if (!data) {
            // 明确告知用户会话不存在，而非静默失败
            throw new Error(`会话 "${sessionId}" 不存在，无法恢复`);
        }
        this.current = data;
        return data;
    }

    /**
     * 追加消息并自动持久化
     *
     * 为什么每次追加都立即保存：
     *   - 防止进程崩溃导致对话历史丢失
     *   - 用户可能随时关闭终端，必须保证数据已落盘
     *   - 消息量不大，全量 JSON 写入性能可接受
     *
     * @param message — 要追加的消息（user/assistant/system/tool_result）
     * @throws 无活跃会话时抛出错误
     */
    async appendMessage(message: Message): Promise<void> {
        if (!this.current) {
            throw new Error("无活跃会话，请先创建会话");
        }
        this.current.messages.push(message);
        this.current.updatedAt = new Date().toISOString(); // 更新修改时间
        await this.store.save(this.current);
    }

    /**
     * 列出所有历史会话（用于会话列表展示）
     *
     * 为什么直接委托给 store 不做额外处理：
     *   - list 是纯查询操作，不涉及"当前会话"状态
     *   - 直接在 store 层完成排序和摘要提取更高效
     *
     * @returns 会话摘要列表（按时间倒序）
     */
    async list(): Promise<SessionSummary[]> {
        return this.store.list();
    }

    /**
     * 删除指定会话
     *
     * 注意：删除的是持久化数据，当前 active session 不受影响
     * 如果正在删除当前活跃会话，应该先调用 create() 创建新会话
     *
     * @param sessionId — 要删除的会话 ID
     */
    async delete(sessionId: string): Promise<void> {
        await this.store.delete(sessionId);
    }

    /**
     * 获取当前活跃会话
     *
     * @returns 当前会话数据，未创建则返回 null
     */
    getCurrent(): SessionData | null {
        return this.current;
    }

    /**
     * 获取会话存储实例
     *
     * 为什么暴露 store：
     *   - 允许上层直接进行存储操作（如 migration、backup）
     *   - 遵循"组合优于继承"原则
     *
     * @returns 内部 SessionStore 实例
     */
    getStore(): SessionStore {
        return this.store;
    }
}
