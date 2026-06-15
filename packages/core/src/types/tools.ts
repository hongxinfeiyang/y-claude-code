// ─── packages/core/src/types/tools.ts ───
// 工具系统类型定义 — Tool 抽象基类、执行上下文、JSON Schema
// 解决问题: 定义"LLM 可以调用什么工具、工具如何执行、执行时需要什么上下文"的完整契约，
//          使工具注册、工具发现、工具执行三个环节解耦，支持内置工具和自定义工具的统一管理

import type { ToolResult } from "./messages";

// ─── JSON Schema 类型（工具参数描述）───

/**
 * JSON Schema 属性定义 — 描述工具参数的单个字段
 *
 * 解决问题:
 *   1. LLM 需要精确知道每个参数的类型、含义、可选值，才能生成合法调用
 *   2. 支持嵌套参数（通过 items 递归引用）描述数组元素结构
 *
 * 标记: "工具参数的元数据描述单元" — 一个 SchemaProperty 对应一个参数字段
 */
export interface SchemaProperty {
    /** 参数类型: "string" | "number" | "boolean" | "array" | "object" */
    type: string;

    /** 参数的人类可读描述，指导 LLM 理解参数含义 */
    description: string;

    /** 可选值枚举 — 约束参数只能从列表中取值，如 ["bash", "python"] */
    enum?: string[];

    /** 参数默认值 — 当 LLM 未提供该参数时使用的回退值 */
    default?: unknown;

    /** 数组元素 Schema — 当 type 为 "array" 时，描述每个元素的类型结构 */
    items?: SchemaProperty;
}

/**
 * 工具参数 JSON Schema — 工具的完整输入契约
 *
 * 解决问题:
 *   1. LLM 在调用工具前通过此 Schema 生成合法的 JSON 参数
 *   2. Agent 在收到工具调用后可据此校验参数完整性（required 字段）
 *
 * 标记: "工具的能力声明" — 工具通过此 Schema 向 LLM 声明"我能接受什么参数"
 */
export interface JSONSchema {
    /** 根类型固定为 object，参数以键值对形式组织 */
    type: "object";

    /** 参数字段映射 — key 为参数名，value 为其 Schema 定义 */
    properties: Record<string, SchemaProperty>;

    /** 必填参数列表 — 缺失任一必填参数时调用应被拒绝 */
    required?: string[];
}

// ─── 轻量级接口（避免循环依赖）───

/**
 * 轻量级 Logger 接口
 *
 * 解决问题:
 *   1. 工具执行过程中需要记录调试信息和错误，但不能直接依赖具体的日志实现
 *      （否则 core 包就会与日志包形成循环依赖）
 *   2. 通过接口抽象，让 ToolContext 持有 Logger 引用而不关心其具体实现
 *
 * 标记: "依赖倒置的桥梁" — core 定义接口，外部注入实现
 */
export interface Logger {
    /** 调试级别日志 — 开发排查时使用，默认不输出 */
    debug(msg: string, ...args: unknown[]): void;

    /** 信息级别日志 — 记录正常流程节点 */
    info(msg: string, ...args: unknown[]): void;

    /** 警告级别日志 — 非致命异常但需要关注 */
    warn(msg: string, ...args: unknown[]): void;

    /** 错误级别日志 — 工具执行失败等需要立即关注的问题 */
    error(msg: string, ...args: unknown[]): void;
}

/**
 * ISandbox 最小接口 — 沙箱执行环境的抽象
 *
 * 解决问题:
 *   1. Bash 等工具需要在隔离环境中执行命令以保证安全性
 *   2. core 包不能直接依赖 sandbox 包（会造成循环依赖），
 *      因此在此定义最小接口并让 sandbox 包实现它
 *   3. 调用方通过此接口提交命令并获取执行结果（退出码、输出、超时状态）
 *
 * 标记: "core 与 sandbox 的解耦契约"
 */
export interface ISandbox {
    /**
     * 在沙箱中执行命令
     *
     * @param command   - 要执行的 shell 命令
     * @param options   - 执行选项（工作目录、超时、最大输出长度）
     * @returns 执行结果，包含退出码、stdout、stderr、是否超时、执行耗时
     */
    exec(
        command: string,
        options: { workdir: string; timeout?: number; maxOutput?: number },
    ): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
        duration: number;
    }>;

    /** 检测沙箱是否可用 — 用于判断当前环境是否支持沙箱执行 */
    isAvailable(): Promise<boolean>;
}

// ─── 工具执行上下文 ───

/**
 * 工具执行上下文 — 工具执行时可访问的资源和引用
 *
 * 解决问题:
 *   1. 工具执行时需要知道自己"在哪里运行"（工作目录）、"属于哪个会话"、如何"反馈结果"
 *   2. 支持取消信号（AbortSignal），让用户可以在工具执行超时或不需要时中断
 *   3. 通过沙箱引用让工具在安全环境中执行命令
 *   4. 通过日志器让工具输出可追踪的诊断信息
 *
 * 标记: "工具与 Agent Loop 的沟通桥梁" — 工具不直接操作 Agent，而是通过 Context 交互
 */
export interface ToolContext {
    /** 当前项目工作目录 — 工具读取/写入文件时以此为根路径 */
    workingDirectory: string;

    /** 当前会话 ID — 用于关联工具调用与所属会话 */
    sessionId: string;

    /**
     * 追加消息到会话历史
     * 解决问题: 工具可能需要异步产出后续消息（如后台任务完成后的通知）
     */
    appendMessage: (content: string) => Promise<void>;

    /** 沙箱引用 — Bash 等需要执行命令的工具通过它获得安全的执行环境 */
    sandbox?: ISandbox;

    /** 日志器 — 工具通过它输出调试和错误信息 */
    logger?: Logger;

    /**
     * 取消信号 — 用于中断长时间运行的工具执行
     * 解决问题: 用户按 Ctrl+C 或工具超时时，工具应收到此信号并优雅退出
     */
    signal: AbortSignal;
}

// ─── 工具抽象基类 ───

/**
 * 工具抽象基类 — 所有内置工具和自定义工具的契约
 *
 * 解决问题:
 *   1. 统一工具注册流程：Agent 通过 name 发现工具，通过 description 理解工具用途，
 *      通过 parameters 生成合法参数，通过 execute 执行工具逻辑
 *   2. 支持权限控制：requiresApproval 让工具声明"我是否需要用户确认才能执行"
 *   3. 支持扩展：任何第三方只需继承 Tool 并实现抽象方法即可注册为自定义工具
 *
 * 标记: "工具的 Liskov 基类" — 所有具体工具必须是 Tool 的子类
 */
export abstract class Tool {
    /**
     * 工具名称 — LLM 通过此名称发起工具调用
     *
     * 解决问题: LLM 在推理中说"我要调用名为 X 的工具"，Agent 据此查找已注册的工具实例
     *
     * 标记: "工具的唯一标识符" — 在同一 Agent 实例中工具名不可重复
     */
    abstract name: string;

    /**
     * 工具描述 — 指导 LLM 何时及如何使用此工具
     *
     * 解决问题: LLM 需要理解工具的用途和使用场景才能做出正确的调用决策，
     *          描述质量直接影响 LLM 的工具选择准确率
     *
     * 标记: "LLM 的工具使用说明书"
     */
    abstract description: string;

    /**
     * 输入参数 JSON Schema — LLM 据此生成合法参数
     *
     * 解决问题: LLM 在调用工具前需要知道参数名、类型、是否必填，
     *          否则可能生成类型错误或缺失必填字段的非法调用
     *
     * 标记: "工具的参数契约" — 定义工具接受的完整输入结构
     */
    abstract parameters: JSONSchema;

    /**
     * 执行工具逻辑 — 工具的核心行为
     *
     * 解决问题: 当 LLM 决定调用此工具并提供参数后，此方法被 Agent Loop 调用，
     *          执行实际的文件读写、命令运行、网络请求等操作
     *
     * @param params  - LLM 生成的调用参数，已通过 JSON Schema 格式校验
     * @param context - 工具执行上下文，提供工作目录、取消信号等资源
     * @returns 工具执行结果，包含成功/失败状态和输出内容
     *
     * 标记: "工具的生命周期入口" — 这是 LLM 意图到实际系统操作的转换点
     */
    abstract execute(
        params: Record<string, unknown>,
        context: ToolContext,
    ): Promise<ToolResult>;

    /**
     * 判断此工具调用是否需要用户确认
     *
     * 解决问题:
     *   1. 安全控制：某些工具（如文件删除、git push）可能造成不可逆操作，
     *      需要在执行前征得用户同意
     *   2. 子类可通过覆写此方法根据 params 内容做细粒度判断
     *      （如 "只读操作自动放行，写操作需要确认"）
     *
     * @param _params - 工具调用参数，子类可据此判断风险等级
     * @returns 默认返回 false（不需要确认），子类可覆写为 true
     *
     * 标记: "权限门控" — Agent Loop 在 execute 前调用此方法决定是否弹确认框
     */
    requiresApproval(_params: Record<string, unknown>): boolean {
        return false;
    }
}
