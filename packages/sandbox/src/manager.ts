// ─── packages/sandbox/src/manager.ts ───
// DockerSandboxManager — 基于 Docker 的沙箱实现
// 解决问题：通过 Docker 容器提供隔离的命令执行环境，使 core 包可以在安全的
// 沙箱中运行 AI 生成的 shell 命令。核心设计要点：
//   1. 镜像预热（warmup）— CLI 启动时拉取镜像，避免首次调用时的冷启动延迟
//   2. 安全策略校验 — 执行前先通过 policy 模块校验命令和挂载的安全性
//   3. 超时控制 — 使用 Promise.race 实现硬超时，超时后强杀容器
//   4. 日志流解析 — Docker 的日志格式有 8 字节头部，需正确解析以分离 stdout/stderr
//   5. 自动清理 — 容器设置 AutoRemove，退出即自动删除，不留残留

import Docker from "dockerode";
import type { ISandbox, SandboxOptions, SandboxResult } from "./types";
import { DEFAULT_POLICY, validateCommand, validateMounts } from "./policy";
import type { SecurityPolicy } from "./policy";

// ─── DockerSandboxManager ───
// 实现 ISandbox 接口，使用 dockerode 库与 Docker daemon 通信
// 设计选择 Docker 而非 Podman/本地进程的原因：
//   - Docker 生态成熟，dockerode 库维护活跃
//   - 容器天然提供文件系统隔离、网络隔离、资源限制
//   - Linux/macOS/Windows 均可用（Windows 需 WSL2）

export class DockerSandboxManager implements ISandbox {
    /** Docker daemon 连接客户端 */
    private docker: Docker;

    /** 沙箱使用的 Docker 镜像名称 */
    private imageName: string;

    /** 镜像是否已拉取并就绪的标志 */
    private imageReady = false;

    /** 当前生效的安全策略（默认值 + 用户覆盖） */
    private policy: SecurityPolicy;

    /**
     * @param options.imageName - Docker 镜像名，默认 "node:20-alpine"（轻量、安全）
     * @param options.socketPath - Docker socket 路径，默认 "/var/run/docker.sock"
     * @param options.policy - 安全策略覆盖项，会与 DEFAULT_POLICY 合并
     */
    constructor(options?: {
        imageName?: string;
        socketPath?: string;
        policy?: Partial<SecurityPolicy>;
    }) {
        const socketPath = options?.socketPath ?? "/var/run/docker.sock";
        this.docker = new Docker({ socketPath });
        this.imageName = options?.imageName ?? "node:20-alpine";
        // 用户提供的 policy 覆盖项合并到默认策略上，未指定的项保持默认值
        this.policy = { ...DEFAULT_POLICY, ...options?.policy };
    }

    // ══════════════════════════════════════════════════════════════════
    // 公开方法 — ISandbox 接口实现
    // ══════════════════════════════════════════════════════════════════

    /**
     * 预热：拉取镜像并验证可用性
     * 建议在 CLI 启动时调用，避免首次 exec 时的冷启动延迟（拉镜像可能需要数十秒）
     * 设计思路：先检查本地是否已有镜像，有则跳过拉取，无则 pull
     */
    async warmup(): Promise<void> {
        const images = await this.docker.listImages();
        const exists = images.some((img) => img.RepoTags?.includes(this.imageName));
        if (!exists) {
            await this.pullImage();
        }
        this.imageReady = true;
    }

    /**
     * 在 Docker 容器中执行命令
     *
     * 执行流程：
     *   1. 确保镜像就绪（未就绪则自动 warmup）
     *   2. 安全策略校验（命令模式匹配 + 挂载路径检查）
     *   3. 创建容器（应用资源限制、网络限制）
     *   4. 启动容器 + 超时竞速（Promise.race）
     *   5. 收集日志输出（解析 Docker 8 字节头部格式）
     *   6. 超时处理（强杀容器 + 返回超时标记）
     *
     * @param command - 要执行的 shell 命令
     * @param options - 沙箱执行选项
     * @returns 执行结果
     */
    async exec(command: string, options: SandboxOptions): Promise<SandboxResult> {
        if (!this.imageReady) await this.warmup();

        // ─── 安全策略校验 ───
        // 在容器创建之前进行校验，拒绝危险命令，避免不必要的容器创建开销
        const cmdError = validateCommand(command, this.policy);
        if (cmdError) {
            throw new Error(`安全策略拦截: ${cmdError}`);
        }

        // 如果有挂载请求，额外校验挂载路径是否在允许范围内
        if (options.mounts) {
            const mountError = validateMounts(options.mounts, this.policy);
            if (mountError) {
                throw new Error(`安全策略拦截: ${mountError}`);
            }
        }

        // ─── 构建容器配置 ───
        // 将挂载映射转换为 Docker Bind 格式: "host_path:container_path:mode"
        const binds = options.mounts
            ? options.mounts.map((m) => `${m.host}:${m.container}:${m.mode}`)
            : [`${options.workdir}:/workspace`]; // 无挂载时默认挂载工作目录

        const container = await this.docker.createContainer({
            Image: this.imageName,
            Cmd: ["sh", "-c", command], // 通过 sh -c 执行，支持管道、重定向等 shell 特性
            WorkingDir: options.workdir,
            HostConfig: {
                Binds: binds,
                Memory: this.parseMemoryLimit(options.memoryLimit ?? this.policy.defaultMemoryLimit),
                NanoCpus: options.cpuLimit ? this.parseCpuLimit(options.cpuLimit) : undefined,
                NetworkMode: options.networkMode ?? this.policy.defaultNetworkMode,
                AutoRemove: true, // 容器退出后自动删除，避免残留容器占用磁盘
            },
        });

        const startTime = Date.now();

        try {
            await container.start();
            const timeout = options.timeout ?? 120_000;

            // ─── 超时控制 ───
            // 使用 Promise.race 在容器等待和超时定时器之间竞速
            // 设计原因：Docker API 的 wait 没有内置超时，需自行实现硬超时
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("timeout")), timeout);
            });

            const waitPromise = container.wait({ condition: "not-running" });
            await Promise.race([waitPromise, timeoutPromise]);

            // ─── 收集日志 ───
            // Docker 日志格式：[stream_type(1B)][0x00*3][length(4B BE)][content]
            // tail: 10000 限制从末尾截取，防止日志过大
            const logs = await container.logs({ stdout: true, stderr: true, tail: 10000 });
            const { stdout, stderr } = this.splitLogs(logs);
            const maxLen = options.maxOutput ?? 1_000_000;

            return {
                exitCode: 0,
                stdout: Buffer.from(stdout).toString().slice(0, maxLen),
                stderr: Buffer.from(stderr).toString().slice(0, maxLen),
                timedOut: false,
                duration: Date.now() - startTime,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "";
            // 超时处理：杀死容器并返回特定结果，而不是抛出异常
            // 设计原因：超时是预期内的情况（AI 可能生成慢或死循环），用标记位而非异常更方便调用方处理
            if (message.includes("timeout")) {
                await container.kill().catch(() => {});
                return {
                    exitCode: -1,
                    stdout: "",
                    stderr: "命令执行超时，已被强制终止",
                    timedOut: true,
                    duration: Date.now() - startTime,
                };
            }
            throw error;
        }
    }

    /**
     * 检查 Docker daemon 是否可用
     * 通过 ping 探测 Docker socket 是否可达
     * @returns Docker daemon 可达时返回 true
     */
    async isAvailable(): Promise<boolean> {
        try {
            await this.docker.ping();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 获取沙箱运行时状态信息
     * 用于健康检查和诊断
     * @returns Docker 版本、镜像状态等运行时元数据
     */
    async getStatus(): Promise<{ type: string; running: boolean; version: string }> {
        const info = await this.docker.info();
        return {
            type: "docker",
            running: this.imageReady,
            version: info.ServerVersion,
        };
    }

    // ══════════════════════════════════════════════════════════════════
    // 私有方法 — 内部实现细节
    // ══════════════════════════════════════════════════════════════════

    /**
     * 拉取 Docker 镜像（使用回调式 API，因为 dockerode pull 不支持 Promise）
     * 注意：dockerode 的 pull 方法是老式回调风格，需手动包装为 Promise
     */
    private pullImage(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.docker.pull(this.imageName, (err: Error | null) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * 解析 Docker 日志流，分离 stdout 和 stderr
     *
     * Docker 多路复用日志格式（每帧 8 字节头部）：
     *   - 字节 0: 流类型（1 = stdout, 2 = stderr）
     *   - 字节 1-3: 保留（全 0x00）
     *   - 字节 4-7: 帧数据长度（Big-Endian uint32）
     *   - 字节 8+: 实际日志内容
     *
     * 设计原因：直接使用原始日志会导致 stdout/stderr 混杂且含有二进制头部，无法展示给用户
     */
    private splitLogs(logs: Buffer): { stdout: Buffer; stderr: Buffer } {
        const result = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        let offset = 0;
        while (offset < logs.length) {
            const streamType = logs[offset];                    // 流类型：1=stdout, 2=stderr
            const length = logs.readUInt32BE(offset + 4);      // 数据长度（大端序）
            const content = logs.subarray(offset + 8, offset + 8 + length);
            if (streamType === 1) result.stdout = Buffer.concat([result.stdout, content]);
            else result.stderr = Buffer.concat([result.stderr, content]);
            offset += 8 + length;
        }
        return result;
    }

    /**
     * 解析内存限制字符串为字节数
     * 支持格式: "256m" (兆字节), "1g" (吉字节)
     * Docker API 要求 Memory 字段为字节数（整数），但用户更习惯使用 m/g 单位
     * @param limit - 内存限制字符串，如 "256m"
     * @returns 字节数，解析失败时返回默认 256MB
     */
    private parseMemoryLimit(limit: string): number {
        const match = limit.match(/^(\d+)(m|g)$/);
        if (!match) return 256 * 1024 * 1024; // 解析失败回退到安全默认值
        const value = parseInt(match[1], 10);
        return match[2] === "g" ? value * 1024 * 1024 * 1024 : value * 1024 * 1024;
    }

    /**
     * 解析 CPU 限制字符串为 nanoCPU 单位
     * Docker 的 NanoCpus 使用纳核（1 CPU = 1,000,000,000 nanoCPU）
     * 例如 "1.0" -> 1_000_000_000, "0.5" -> 500_000_000
     * @param limit - CPU 限制字符串，如 "1.0"
     * @returns nanoCPU 整数值
     */
    private parseCpuLimit(limit: string): number {
        return Math.floor(parseFloat(limit) * 1_000_000_000);
    }
}
