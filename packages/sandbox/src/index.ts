// ─── packages/sandbox/src/index.ts ───
// @y-claude-code/sandbox 模块公共 API 入口
// 解决问题：通过统一的入口文件对外暴露类型、实现和工具函数，
// 使外部消费者（如 core 包、CLI 包）只需 import 此模块即可获取所有沙箱相关能力，
// 无需了解内部文件组织结构
//
// 设计原则：
//   - 类型导出使用 `export type` 确保编译后不产生运行时代码
//   - 实现类通过具名导出，方便外部做依赖注入和 Mock 替换
//   - 安全策略相关的工具函数与常量也一并导出，方便外部做策略自定义

// ─── 类型导出（仅编译时） ───
// ISandbox 是核心抽象接口，SandboxOptions/Result 是执行选项和结果的类型契约
export type { ISandbox, SandboxOptions, SandboxResult } from "./types";

// ─── 实现类导出（运行时） ───
// DockerSandboxManager 是默认的沙箱实现，外部可通过 new 实例化或继承扩展
export { DockerSandboxManager } from "./manager";

// ─── 安全策略导出 ───
// DEFAULT_POLICY 提供开箱即用的安全默认值
// validateCommand / validateMounts 可用于在沙箱外独立进行安全校验
export { DEFAULT_POLICY, validateCommand, validateMounts } from "./policy";
export type { SecurityPolicy } from "./policy";
