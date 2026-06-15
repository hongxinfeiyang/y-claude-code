# @y-claude-code/sandbox

Docker 沙箱 — 容器隔离执行 Shell 命令。独立包，通过 `ISandbox` 接口注入到 core。

## 文件

| 文件 | 职责 |
|------|------|
| `src/manager.ts` | DockerSandboxManager：镜像拉取、容器创建/启动/等待/清理、日志收集 |
| `src/policy.ts` | SecurityPolicy：危险命令正则拦截、挂载白名单、网络隔离、资源限制 |
| `src/types.ts` | ISandbox 接口、SandboxOptions、SandboxResult |

## ISandbox 接口

```typescript
interface ISandbox {
    exec(command: string, options: SandboxOptions): Promise<SandboxResult>;
    isAvailable(): Promise<boolean>;
    getStatus(): Promise<{ image: string; running: boolean; version: string }>;
}
```

core 包只依赖此接口，不感知 Docker 实现。

## 安全策略

| 规则 | 说明 |
|------|------|
| 危险命令拦截 | `rm -rf /`、`mkfs.`、`dd`、fork bomb 等正则匹配拒绝 |
| 网络隔离 | 默认 `--network none`，Bash 工具显式声明才开启 bridge |
| 挂载白名单 | 仅允许挂载项目工作目录 |
| 资源限制 | 内存 256MB 上限，可配 CPU 限制 |
| 用户隔离 | 容器内以 uid 1000 非 root 运行 |
| 自动清理 | `AutoRemove: true`，执行完自动删除容器 |

## 降级策略

Docker 不可用时，CLI 启动器记录警告日志，Bash 命令降级为本地 `child_process.exec` 执行，安全策略弱化为仅做命令正则校验 + 路径校验。
