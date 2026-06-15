// ─── packages/sandbox/src/types.ts ───
// 沙箱模块类型定义 — 为 core 包提供与具体容器运行时解耦的沙箱抽象契约
// 解决问题：core 包需要执行不受信任的代码（如 AI 生成的脚本），但不能直接依赖
// Docker/Podman/本地进程等具体实现，通过 ISandbox 接口实现依赖倒置，方便测试和替换运行时

// ─── SandboxOptions：沙箱执行选项 ───
// 封装一次沙箱命令执行所需的全部运行环境配置
// 解决问题：不同场景对隔离性、资源限制、文件挂载的需求不同（如代码审查只需只读挂载，
// 而代码生成需要读写挂载），通过统一选项结构让调用方灵活控制

/** 沙箱执行选项 */
export interface SandboxOptions {
    /**
     * 工作目录（容器内路径）
     * 所有命令在此目录下执行，用于隔离不同任务的工作空间
     */
    workdir: string;

    /**
     * 环境变量
     * 键值对形式注入容器，用于传递运行时配置（如 API_KEY、NODE_ENV 等）
     */
    env?: Record<string, string>;

    /**
     * 超时毫秒数（默认 120000 = 2分钟）
     * 解决问题：防止 AI 生成的死循环或耗时命令无限占用资源
     */
    timeout?: number;

    /**
     * 最大输出字节数（默认 1MB）
     * 解决问题：防止命令输出过大导致内存溢出，对日志/标准输出做截断保护
     */
    maxOutput?: number;

    /**
     * 挂载目录映射 (host -> container)
     * 解决问题：将宿主机项目目录挂载到容器内，使容器中的命令能访问源码文件
     * mode "ro" 用于只读场景（如代码分析），"rw" 用于需要写入的场景（如构建）
     */
    mounts?: Array<{ host: string; container: string; mode: "ro" | "rw" }>;

    /**
     * 网络模式
     * - "none": 完全断网，最安全（默认策略）
     * - "bridge": Docker 桥接网络，可访问外网
     * - "host": 使用宿主机网络栈（高风险，一般禁止）
     */
    networkMode?: "none" | "bridge" | "host";

    /**
     * 内存限制 (e.g. "256m")
     * 解决问题：防止单个沙箱任务消耗过多宿主机内存影响其他服务
     */
    memoryLimit?: string;

    /**
     * CPU 限制 (e.g. "1.0" = 1 core)
     * 解决问题：防止 CPU 密集型任务（如挖矿脚本）占用所有计算资源
     */
    cpuLimit?: string;
}

// ─── SandboxResult：沙箱执行结果 ───
// 封装命令执行后的完整反馈信息
// 解决问题：调用方需要知道命令是否成功、输出内容、是否超时、耗时多久，
// 统一的结果结构让错误处理和日志记录更规范

/** 沙箱执行结果 */
export interface SandboxResult {
    /**
     * 退出码
     * 0 表示成功，非 0 表示失败，-1 表示被超时强杀
     */
    exitCode: number;

    /**
     * 标准输出
     * 命令正常执行时产生的输出内容
     */
    stdout: string;

    /**
     * 标准错误
     * 命令执行过程中的错误信息，用于诊断问题
     */
    stderr: string;

    /**
     * 是否因超时被强制终止
     * 区分正常退出与超时杀死的标记，让调用方知道是否需要重试或调整超时
     */
    timedOut: boolean;

    /**
     * 实际执行耗时 (ms)
     * 用于性能分析和超时策略调优
     */
    duration: number;
}

// ─── ISandbox：沙箱抽象接口 ───
// core 包只依赖此接口，不感知具体实现（Docker/Podman/本地进程）
// 解决问题：实现了"依赖倒置原则"——高层模块（core）不依赖低层模块（Docker），
// 二者都依赖抽象（ISandbox）。这样做的好处是：
//   1. 单元测试时可以用 Mock 实现替代真实 Docker
//   2. 未来可以切换到 Podman 或其他容器运行时无需修改 core 代码
//   3. 开发和 CI 环境可以使用不同实现

/** 沙箱抽象接口 — core 包只依赖此接口，不感知具体实现（Docker/Podman/本地） */
export interface ISandbox {
    /**
     * 在隔离容器中执行命令
     * @param command - 要执行的 shell 命令字符串
     * @param options - 沙箱执行选项
     * @returns 执行结果，包含退出码、输出、是否超时等
     */
    exec(command: string, options: SandboxOptions): Promise<SandboxResult>;

    /**
     * 检查沙箱运行时是否可用
     * @returns true 表示 Docker/Podman 已安装且可连接
     */
    isAvailable(): Promise<boolean>;

    /**
     * 获取沙箱运行时状态信息
     * @returns 包含运行时类型、镜像就绪状态、版本号等信息
     */
    getStatus(): Promise<{ type: string; running: boolean; version: string }>;
}
