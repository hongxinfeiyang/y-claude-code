// ─── packages/core/src/agent/error-recovery/index.ts ───
// 错误恢复模块 barrel export
// 解决问题: 统一导出所有错误恢复相关的类、类型和常量

export { ErrorClassifier } from "./classifier";
export { RetryManager } from "./retry";
export { CircuitBreakerManager, CircuitState } from "./circuit-breaker";
export { ProviderFailoverManager } from "./failover";
export { ErrorRecoveryManager } from "./manager";
export type { ErrorRecoveryConfig } from "./manager";

export {
    ErrorCategory,
    RecoveryStrategy,
    DEFAULT_RETRY_CONFIG,
    DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "./types";

export type {
    ErrorInfo,
    RecoveryResult,
    RetryConfig,
    CircuitBreakerConfig,
    ProviderFailoverConfig,
} from "./types";
