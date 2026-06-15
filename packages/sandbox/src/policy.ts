// ─── packages/sandbox/src/policy.ts ───
// 安全策略模块 — 定义 Docker 沙箱的安全限制规则与校验逻辑
// 解决问题：在沙箱中执行 AI 生成的命令存在安全风险（如删库、提权、挖矿等），
// 安全策略通过多层规则（命令正则匹配、路径黑名单、资源上限等）在命令执行前进行拦截，
// 实现"默认拒绝 + 白名单放行"的安全模型

// ─── SecurityPolicy：安全策略配置 ───
// 集中管理所有安全限制参数，使安全规则可配置、可审计、可按环境定制
// 解决问题：开发环境和生产环境的安全需求不同（开发可能允许更多权限），
// 通过接口 + 默认值 + 可覆盖的方式，实现灵活的安全策略管理

/** 安全策略配置 */
export interface SecurityPolicy {
    /**
     * 禁止的命令正则模式
     * 匹配到任一模式即拒绝执行，从命令字符串层面拦截危险操作
     * 解决问题：防止 rm -rf /、写入裸设备、fork 炸弹、远程脚本管道执行等攻击
     */
    blockedCommands: RegExp[];

    /**
     * 允许的网络模式白名单
     * 限制用户可选用的网络模式范围
     */
    allowedNetworkModes: string[];

    /**
     * 默认网络模式
     * 解决问题：默认断网，防止恶意命令下载 payload 或外发数据，需要网络时由调用方显式指定
     */
    defaultNetworkMode: "none" | "bridge";

    /**
     * 允许挂载的宿主机路径白名单
     * 为空时拒绝所有挂载，需要时由调用方显式指定允许的路径
     */
    allowedMountPaths: string[];

    /**
     * 默认内存限制
     * 每个沙箱容器的默认内存上限，防止内存耗尽
     */
    defaultMemoryLimit: string;

    /**
     * 最大内存限制
     * 即使显式指定了更大的值也会被拦截，设置硬上限
     */
    maxMemoryLimit: string;

    /**
     * 禁止挂载的敏感路径黑名单
     * 解决问题：防止通过挂载窃取 /etc/passwd、/root/.ssh、/proc 等系统敏感信息
     */
    blockedMountPaths: string[];
}

// ─── DEFAULT_POLICY：默认安全策略 ───
// 采用最严格的安全配置，遵循"默认拒绝"原则
// 解决问题：防止因忘记配置安全策略而导致的安全漏洞，所有危险操作默认禁止

/** 默认安全策略 — 最严格的安全配置，遵循默认拒绝原则 */
export const DEFAULT_POLICY: SecurityPolicy = {
    blockedCommands: [
        /rm\s+-rf\s+\//,           // 防止 rm -rf /（删除根目录）
        />\s*\/dev\/sd[a-z]/,     // 防止写裸设备（直接操作磁盘，绕过文件系统权限）
        /mkfs\./,                  // 防止格式化文件系统（mkfs.ext4 等）
        /dd\s+if=/,               // 防止 dd 命令（常用于覆写磁盘或创建后门镜像）
        /:\(\)\s*\{/,              // fork bomb 特征（经典的 :(){ :|:& };: 模式）
        /curl.*\|\s*(ba)?sh/,     // 防止 curl 远程脚本管道执行（curl xxx | bash）
        /wget.*\|\s*(ba)?sh/,     // 防止 wget 远程脚本管道执行（wget xxx | bash）
        />\s*\/etc\//,            // 禁止覆盖 /etc 目录下的配置文件（如 /etc/passwd）
    ],
    allowedNetworkModes: ["none", "bridge"],
    defaultNetworkMode: "none",    // 默认无网络，防止数据外泄和远程 payload 下载
    allowedMountPaths: [],
    defaultMemoryLimit: "256m",    // 默认 256MB，平衡功能性与安全性
    maxMemoryLimit: "1g",          // 硬上限 1GB，防止单个容器吃光所有内存
    blockedMountPaths: [
        "/etc",                    // 包含密码哈希、系统配置等敏感信息
        "/root",                   // root 用户的 SSH 密钥、bash_history 等
        "/home",                   // 普通用户的家目录，可能含敏感数据
        "/var/run",                // Docker socket 等运行时文件
        "/proc",                   // 进程信息、内核参数等系统运行时数据
        "/sys",                    // 内核和设备信息
        "/dev",                    // 设备文件，直接读写可能造成数据破坏
        "/boot",                   // 内核镜像，被篡改可能导致系统无法启动
    ],
};

// ─── validateCommand：命令安全校验 ───
// 在执行前用正则模式匹配命令字符串，拒绝危险操作
// 解决问题：正则匹配虽然不能 100% 防止所有攻击，但可以拦截最常见的危险模式，
// 配合容器隔离、网络限制、资源限制形成多层纵深防御

/**
 * 校验命令是否符合安全策略
 * @param command - 待执行的 shell 命令字符串
 * @param policy - 当前生效的安全策略
 * @returns 校验通过返回 null，否则返回具体的拦截原因描述
 */
export function validateCommand(command: string, policy: SecurityPolicy): string | null {
    for (const pattern of policy.blockedCommands) {
        if (pattern.test(command)) {
            return `命令匹配禁止模式: ${pattern}`;
        }
    }
    return null;
}

// ─── validateMounts：挂载路径安全校验 ───
// 检查挂载的宿主机路径是否在敏感路径黑名单中
// 解决问题：即使攻击者控制了挂载参数，也无法将 /etc、/root 等敏感目录挂入容器

/**
 * 校验挂载路径是否符合安全策略
 * @param mounts - 待校验的挂载映射列表
 * @param policy - 当前生效的安全策略
 * @returns 校验通过返回 null，否则返回具体的拦截原因描述
 */
export function validateMounts(
    mounts: Array<{ host: string; container: string; mode: string }>,
    policy: SecurityPolicy,
): string | null {
    for (const mount of mounts) {
        for (const blocked of policy.blockedMountPaths) {
            if (mount.host.startsWith(blocked)) {
                return `禁止挂载敏感路径: ${mount.host}`;
            }
        }
    }
    return null;
}
