# AgentLoop 架构设计说明

## 1. 概述

`AgentLoop` 是本系统的调度中枢，实现了 **ReAct (Reasoning + Acting)** 范式的核心循环。它接收用户输入，交替驱动 LLM 推理和工具调用，通过异步事件流向外暴露过程状态，直到任务完成或触发终止条件。

**文件位置**: [packages/core/src/agent/loop.ts](packages/core/src/agent/loop.ts)

**核心职责**:
- 管理 Agent 生命周期状态机（8 种状态）
- 调度 LLM 推理→工具调用→观察→再推理的循环
- 将工具执行结果反馈给 LLM，形成闭环
- 编排子模块协作（PlanModeManager、LLMCallManager、ToolExecutor、ErrorRecoveryManager 等）

## 2. 在系统中的位置

```
┌─────────────────────────────────────────────────┐
│  IntentRouter                                   │
│    └── 自然语言输入 → AgentLoop.run()             │
├─────────────────────────────────────────────────┤
│  AgentLoop (编排层, 775 行)                       │
│    ├── buildInitialMessages()  // 构建上下文      │
│    ├── while (toolRounds < max)                 │
│    │    ├── llmCallManager.streamCall() // LLM  │
│    │    ├── toolExecutor.executeAll() // 工具    │
│    │    └── planModeManager.*()  // Plan Mode   │
│    ├── ErrorRecoveryManager      // 错误恢复      │
│    ├── ContextCompactor          // 上下文压缩    │
│    ├── MiddlewarePipeline        // 中间件管道    │
│    └── ObservabilityManager      // 可观测性      │
├──────────────────────────────────────────────────┤
│  提取的子模块 (agent/ 目录)                        │
│    ├── PlanModeManager     // Plan Mode 管理     │
│    ├── LLMCallManager      // LLM 流式调用       │
│    ├── ToolExecutor        // 工具执行管道        │
│    ├── ContextCompactor    // 上下文压缩          │
│    ├── MiddlewarePipeline  // 中间件管道          │
│    ├── PlanState           // 规划状态持有者       │
│    └── error-recovery/     // 错误恢复子系统       │
├──────────────────────────────────────────────────┤
│  LLMProvider (Anthropic / OpenAI)                │
│  ToolRegistry (23 个内置工具)                      │
└──────────────────────────────────────────────────┘
```

AgentLoop 是"编排者"而非"执行者"：具体的 LLM 调用、工具执行、Plan Mode 管理、上下文压缩均已委托给独立子模块。

## 3. 状态机设计

AgentLoop 内部维护一个 8 状态机。状态围绕 `while (toolRounds < maxToolRounds)` 循环流转。
核心要点：**while 循环只由工具调用驱动**，纯文本回答一轮就结束，不走循环。

```
                              ┌─────────┐
                              │  IDLE   │ ← 初始状态 / 等待用户输入
                              └────┬────┘
                                   │ run() 被调用
                                   ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  while (toolRounds < maxToolRounds)   ← 循环入口                  │
   │                                                                  │
   │     ┌──────────┐                                                 │
   │     │ THINKING │ ← LLM 推理中                                     │
   │     └────┬─────┘                                                 │
   │          │                                                       │
   │     ┌────┴────────────┐                                          │
   │     │                 │                                          │
   │  无工具调用         有工具调用       ← LLM 流式 chunk 返回 tool_use   │
   │  (文本回答)            │                                          │
   │     │                 ▼                                          │
   │     │          ┌────────────────┐                                 │
   │     │          │WAITING_APPROVAL│ ← 权限审批（需弹窗时才进入）        │
   │     │          └───────┬────────┘                                 │
   │     │             ┌────┴─────┐                                    │
   │     │          通过        拒绝                                    │
   │     │             │          │                                    │
   │     │             ▼          │                                    │
   │     │       ┌──────────┐     │                                    │
   │     │       │EXECUTING │     │ ← 逐工具顺序执行                     │
   │     │       └────┬─────┘     │                                    │
   │     │            │           │                                    │
   │     │       ┌────┴────┐      │                                    │
   │     │     成功      失败      │                                    │
   │     │       │         │      │                                    │
   │     │       └───┬─────┘      │                                    │
   │     │           │            │                                    │
   │     │           ▼            ▼                                    │
   │     │     ┌──────────────────────────┐                            │
   │     │     │ 收集 toolResult           │                            │
   │     │     │ (成功→consecutiveErrors=0 │                            │
   │     │     │  失败→consecutiveErrors++)│                            │
   │     │     └──────────┬───────────────┘                            │
   │     │                │                                            │
   │     │                ▼                                            │
   │     │     ┌─────────────────────┐                                 │
   │     │     │ Plan Mode 检测      │ ← EnterPlanMode → PLANNING       │
   │     │     │                     │   ExitPlanMode  → 恢复工具列表    │
   │     │     └──────────┬──────────┘                                 │
   │     │                │                                            │
   │     │           ┌────┴────────────┐                               │
   │     │           │                 │                               │
   │     │  consecutiveErrors < 3  consecutiveErrors >= 3              │
   │     │           │                 │                               │
   │     │           ▼                 │                               │
   │     │     ┌──────────────────┐    │                               │
   │     │     │ 结果追加到 messages │   │                               │
   │     │     │ toolRounds++     │    │                               │
   │     │     └────────┬─────────┘    │                               │
   │     │              │              │                               │
   │     │              ▼              │                               │
   │     │     ┌────────────────┐      │                               │
   │     │     │ while 条件判断  │      │                               │
   │     │     │ toolRounds<max?│      │                               │
   │     │     └───────┬────────┘      │                               │
   │     │        ┌────┴────┐          │                               │
   │     │        │         │          │                               │
   │     │       YES       NO          │                               │
   │     │        │         │          │                               │
   │     │        ▼         │          │                               │
   │     │   回到循环顶部     │          │                               │
   │     │   (下一轮迭代)     │          │                               │
   │     │                  │          │                               │
   └─────┼──────────────────┼──────────┼───────────────────────────────┘
         │                  │          │
         │                  │          │
         ▼                  ▼          ▼
    ┌──────────┐      ┌──────────┐  ┌──────────┐
    │  DONE    │      │  DONE    │  │  ERROR   │
    │(纯文本结束)│      │(达到上限) │  │(连续3次错)│
    └──────────┘      └──────────┘  └──────────┘

  特殊状态（在循环内部触发）：
  ┌───────────┐     ┌──────────┐
  │RECOVERING │     │PLANNING  │
  │错误恢复中   │     │ 计划模式中 │
  └─────┬─────┘     └────┬─────┘
        │                │
    continue        ExitPlanMode
    回到循环顶部      回到 THINKING
```

**三个退出点，都在 while 循环内部通过 `return` 触发**：

| 退出点 | 代码位置 | 状态 | 去向 |
| ------ | -------- | ---- | ---- |
| 无工具调用 | `toolUses.length === 0` | setState(DONE) | yield done, return |
| 连续 3 次错误 | `consecutiveErrors >= 3` | setState(ERROR) | yield error, return false |
| 用户中断 | `signal.aborted` | setState(DONE) | yield done, return |
| LLM 恢复失败 | `llmRecoveryCount > 3` / 不可恢复 | setState(ERROR) | yield error, return "abort" |
| 熔断触发 | `ToolExecutor 返回 abort=true` | setState(ERROR) | return |

第 4 个退出口在 while 之外：`toolRounds >= maxToolRounds` 导致 while 条件为 false，自然落出循环 (L591-601)，yield error + done。

**关键区分**：

- 只有工具调用才会回到 while 顶部继续下一轮迭代。纯文本回答通过 `return` 直接跳出，不经过 `toolRounds++`，不走 `while` 条件判断。
- `consecutiveErrors >= 3` 在追加结果到 messages **之前**检查（L564），所以错误轮次的结果不会污染上下文。
- RECOVERING 状态通过 `continue` 回到 while 顶部重新调 LLM，不走正常的工具结果追加流程。

| 当前状态 | 触发事件 | 目标状态 |
|---------|---------|---------|
| IDLE | `run()` 被调用 | THINKING |
| THINKING | LLM 流式响应中 | THINKING |
| THINKING | LLM 返回 tool_use, 需审批 | WAITING_APPROVAL |
| THINKING | LLM 返回 tool_use, 无需审批 | EXECUTING |
| THINKING | LLM 返回文本，无工具调用 | DONE |
| THINKING | LLM 异常，可恢复 | RECOVERING → THINKING |
| THINKING | LLM 异常，不可恢复 | ERROR |
| THINKING | LLM error chunk, 可恢复 | RECOVERING → THINKING |
| WAITING_APPROVAL | 用户审批通过 | EXECUTING |
| WAITING_APPROVAL | 用户拒绝 | THINKING (反馈 LLM) |
| EXECUTING | 工具执行完成 | THINKING (while 循环继续) |
| EXECUTING | 连续 3 次错误 | ERROR |
| EXECUTING | EnterPlanMode 工具调用 | PLANNING |
| PLANNING | ExitPlanMode 工具调用 | THINKING |
| RECOVERING | 恢复完成 | THINKING (continue 回到循环顶部) |
| (任意) | signal.aborted | DONE |

所有状态转换均通过 `setState(newState, reason)` 统一入口，14 个调用点均带原因描述。

## 4. 核心数据结构

### 4.1 内部字段

```
AgentLoop (775 行)
├── state: AgentState           // 当前状态机状态 (通过 setState() 统一设置)
├── messages: Message[]         // 累积的完整对话上下文
├── toolRounds: number          // 当前会话工具调用轮次计数
├── tokenUsage: TokenUsage      // Token 消耗统计 (input/output/cache)
├── consecutiveErrors: number   // 连续工具错误计数 (>=3 触发保护)
├── llmRecoveryCount: number    // LLM 恢复连续计数 (>=3 触发保护)
├── planState: PlanState        // 规划闸门状态 (todos/修改计数/漂移计数)
│
├── [子模块 — 每个 run() 复用同一实例]
├── planModeManager: PlanModeManager   // Plan Mode 工具过滤+闸门+切换
├── llmCallManager: LLMCallManager     // LLM 流式调用+chunk 分发
├── toolExecutor: ToolExecutor         // 工具执行管道
├── compactor: ContextCompactor        // 上下文压缩
└── middleware: MiddlewarePipeline      // 中间件管道 (公开可读写)
```

已移除的字段: `planMode`, `originalTools` (→ PlanModeManager 内部管理)

### 4.2 运行时依赖 (AgentLoopContext)

AgentLoop 通过 `AgentLoopContext` 接口接收所有外部依赖。2026-06-16 重构引入 `services` 子对象收敛可选服务：

```
AgentLoopContext
├── [核心必需 — 4 个]
├── permissionManager: PermissionManager
├── sessionId: string
├── workingDirectory: string
├── appendMessage: (content: string) => Promise<void>
│
├── [顶层可选 — 向后兼容]
├── signal?: AbortSignal
├── logger?: Logger
├── sandbox?: ISandbox
├── errorRecoveryManager?: ErrorRecoveryManager
├── summarizer?: Summarizer
├── observability?: ObservabilityManager
├── cacheManager?: CacheManager
├── contextMonitor?: ContextMonitor
│
└── [服务聚合 — 推荐新代码使用]
    services?: AgentServices {
        errorRecovery, observability, summarizer,
        cacheManager, contextMonitor, sandbox
    }
```

实际代码中所有访问均使用 `services` 优先 + 顶层兜底:
`(loopCtx.services?.xxx ?? loopCtx.xxx)?.method()`

## 5. 主流程 (run 方法)

`run()` 拆分为三个阶段的子生成器，通过 `yield*` 委托调用。具体逻辑委托给子模块：

```
run(userInput, config, loopCtx)
 │
 ├─ 1. 重置内部状态 + setState(IDLE)
 ├─ 2. planState.reset() → TodoWriteTool.setPlanState(planState)
 ├─ 3. planModeManager.reset(enforcementMode)
 ├─ 4. buildInitialMessages(userInput, config)
 │
 └─ 5. while (toolRounds < maxToolRounds):
       │
       ├─ 5.1 signal.aborted? → setState(DONE), return
       │
       ├─ 5.2 Phase 1: yield* executeThinkingPhase(config, loopCtx, signal)
       │     ├─ proactiveContextCheck() — 主动上下文检查 (阈值从 config 读取)
       │     ├─ setState(THINKING)
       │     ├─ planModeManager.filterTools() — Plan Mode 工具过滤
       │     ├─ llmCallManager.streamCall() — 流式 LLM 调用 (chunk 分发+token 追踪)
       │     │   ├─ "text" / "thinking" → yield 透传
       │     │   ├─ "tool_use" → 收集
       │     │   ├─ "stop" → tokenUsage 更新 + cacheManager/contextMonitor 同步
       │     │   └─ "error" → errorRecoveryManager.classifyErrorCode() 分类
       │     ├─ result.hasError? → handleLLMRecovery() 处理 error chunk
       │     ├─ catch 异常 → handleLLMRecovery()
       │     └─ toolUses.length === 0? → setState(DONE), return
       │
       ├─ 5.3 追加 assistant 消息到 messages[]
       │
       ├─ 5.4 Phase 2: yield* executeToolPhase(toolUses, config, loopCtx, signal)
       │     └─ toolExecutor.executeAll() — 六步管道:
       │          1. 查找工具 (config.tools.find)
       │          2. 熔断器检查 (errorRecoveryManager.checkCircuitBreaker)
       │          3. 权限检查 (permissionManager.willPromptUser + check)
       │          4. 规划闸门 (planModeManager.enforceGate)
       │          5. 工具执行 (tool.execute)
       │          6. 错误处理 (errorRecoveryManager.handleToolError + 熔断)
       │        回调: onStateChange → setState, onConsecutiveError → consecutiveErrors
       │
       ├─ 5.5 Phase 3: yield* finalizeRound(toolResults, toolUses, config, loopCtx)
       │     ├─ planModeManager.handleTransitions() — Plan Mode 检测
       │     ├─ consecutiveErrors >= 3? → setState(ERROR), return
       │     ├─ truncateToolResults() — 截断过大结果 (ASCII/CJK 区分估)
       │     ├─ 追加 tool_result 到 messages[]
       │     └─ toolRounds++
       │
       └─ (回到 5.1)
```

### 5.1 提取的子模块职责

| 子模块 | 原位置 | 提取后行数 | 调用方式 |
|--------|--------|-----------|---------|
| `PlanModeManager` | AgentLoop.enforcePlanningGate + handlePlanModeTransitions + 字段 | 130 行 | `filterTools()` / `enforceGate()` / `handleTransitions()` |
| `LLMCallManager` | executeThinkingPhase 内 ~60 行 switch-case | 166 行 | `yield* streamCall(messages, ctx, tokenUsage)` |
| `ToolExecutor` | executeToolPhase 内 ~140 行管道 | 223 行 | `yield* executeAll(toolUses, ctx, onStateChange, onError)` |
| `ContextCompactor` | AgentLoop.compactMessages (32 行) | 82 行 | `compactor.compact(messages, summarizer)` |
| `MiddlewarePipeline` | (新增) | 156 行 | `loop.middleware.use(mw)` |
| `PlanState` | TodoWriteTool 静态字段 | 108 行 | `TodoWriteTool.setPlanState(planState)` |

### 5.1 新增保护机制

| 机制 | 位置 | 说明 |
| ---- | ---- | ---- |
| 主动上下文压缩 | `executeThinkingPhase` 入口 | ContextMonitor ≥ 85% 时不等 API 报错，主动调用 compactMessages |
| LLM 恢复死循环保护 | `handleLLMRecovery` | llmRecoveryCount > 3 次连续恢复失败 → 终止，防止反复 RETRY/COMPACT |
| 工具结果截断 | `finalizeRound` | 结果追加前估算 token (>8000 截断)，防止单个工具输出撑爆上下文 |

### 5.2 关键设计决策

**为什么工具调用是顺序执行而非并发？**
LLM 返回的多个 tool_use 之间有隐式依赖（如先 `Write` 文件再 `Bash` 执行），顺序执行保证这些依赖关系被正确满足。

**为什么错误恢复使用 `continue` 回到循环顶部？**
`continue` 利用了 while 循环的一次性入口特性，所有恢复逻辑（重试、切换 Provider、压缩上下文）都通过 `continue` 回到同一代码路径执行 LLM 调用，避免代码重复。

**为什么 tool_result 以 `role: "user"` 追加？**
这是 Anthropic/OpenAI API 的标准格式要求。tool_result 必须以 user 角色出现，LLM 才能正确解析为"这是我之前调用工具的结果，我需要基于此继续推理"。

## 6. 错误恢复集成

AgentLoop 在三个位置集成 ErrorRecoveryManager：

### 6.1 LLM 调用层 (try/catch)

```
provider.chat() 抛异常
  → errorRecoveryManager.handleLLMError(err, model)
    ├─ RETRY:          yield recovering, continue
    ├─ SWITCH_PROVIDER: yield recovering, 更新 config.provider, continue
    ├─ COMPACT_CONTEXT: 调用 compactMessages(), continue
    └─ ABORT_TURN/SESSION: yield error, return
```

### 6.2 LLM 流式 error chunk

```
chunk.type === "error"
  → errorRecoveryManager.classifyErrorCode(code) — 统一入口，消除 AgentLoop 内重复分类
  → handleLLMRecovery() — 同上恢复流程
```

错误码分类已从 `AgentLoop.classifyChunkError()` 迁移到 `ErrorClassifier.classifyByCode()`，通过 `ErrorRecoveryManager.classifyErrorCode()` 公开调用。LLMCallManager 内部保留回退分类（errorRecoveryManager 不可用时）。

### 6.3 工具执行层

```
toolExecutor.executeAll() 内部
  → tool.execute() 抛异常
    → errorRecoveryManager.handleToolError(err, toolName)
      ├─ CIRCUIT_BREAK: 回调 abort，AgentLoop setState(ERROR) + return
      └─ FEEDBACK_TO_LLM: 结果标记 is_error，继续循环
```

## 7. 上下文压缩

当 LLM 返回 CONTEXT_OVERFLOW 或 ContextMonitor 超过阈值时，`ContextCompactor.compact()` 被调用（已从 AgentLoop.compactMessages 提取）：

```
compactor.compact(messages, summarizer?)
  │
  ├─ 保留 system 消息 (role: "system") — AI 的行为宪章必须完整保留
  ├─ 保留最近 50% 的非 system 消息 (最少 2 条)
  │
  └─ 生成摘要消息插入中间:
       ├─ summarizer.getAccumulatedSummary() (LLM 语义摘要)
       └─ 或 "[上下文压缩]: 省略了 N 条历史消息" (简单截断降级)
```

压缩阈值从 `config.contextCompressThreshold` 读取（默认 85），不再硬编码。

## 8. 计划模式

计划模式通过 `PlanModeManager` 管理（已从 AgentLoop 提取为独立模块），通过两个内置工具触发：

- **EnterPlanMode**: `PlanModeManager.handleTransitions()` 检测到后设置内部 `planMode = true`，下次 LLM 调用前 `filterTools()` 将工具过滤为只读子集
- **ExitPlanMode**: `handleTransitions()` 检测到后设置 `planMode = false`，恢复完整工具列表

`enforceGate()` 提供三级闸门 (off/soft/hard)：
- **off**: 完全跳过
- **soft**: 首次修改提醒，二次拒绝
- **hard**: 无计划拒绝修改，漂移 3 次强制重规划

工具过滤发生在每次 LLM 调用前（`planModeManager.filterTools(config.tools)`），非一次性快照，确保运行时工具变动也能正确过滤。

## 9. 安全保护机制

| 机制 | 触发条件 | 行为 |
| ---- | -------- | ---- |
| 连续工具错误保护 | `consecutiveErrors >= 3` | 终止循环，yield error |
| LLM 恢复死循环保护 | `llmRecoveryCount > 3` | 连续 RETRY/SWITCH/COMPACT 超过 3 次 → 终止 |
| 最大轮次限制 | `toolRounds >= maxToolRounds` | 终止循环，yield error + done |
| 用户中断检测 | `signal.aborted` | 每次循环入口检测，立即终止 |
| 熔断器 | `errorRecoveryManager.checkCircuitBreaker()` | 工具执行前检查，熔断中直接拒绝 |
| 权限检查 | `tool.requiresApproval()` | 弹窗→用户确认→放行/拒绝 |
| 主动上下文压缩 | `config.contextCompressThreshold` (默认 85%) | 每次 LLM 调用前检查，不等 API 报错 |
| 工具结果截断 | 估算 token > 8000 (ASCII/CJK 区分估算) | 追加到 messages 前在安全边界（换行符）截断 |
| 路径 / 命令安全 | Bash 命令解析 (extractBashBaseCommand) + 路径规范化 (normalizeFilePath) | 权限细粒度缓存 key，防绕过 |

## 10. 可观测性

AgentLoop 通过可选的 `ObservabilityManager` 记录：

| 事件 | 记录内容 |
|------|---------|
| `startTurn()` | 轮次开始 + 用户输入 |
| `recordLLMCall()` | LLM 调用开始 + span 创建 |
| `recordLLMResult()` | LLM 调用结束 + token 用量 + 工具调用数 |
| `recordToolCall()` | 工具调用开始 + 工具名 + 参数 keys |
| `recordToolResult()` | 工具调用结果 + 成功/失败 + 输出内容 |
| `recordError()` | 异常记录 |
| `recordRecovery()` | 恢复策略 + 成功/失败 |
| `endTurn()` | 轮次结束 + 总 token 用量 + 总轮次数 |

## 11. 扩展点

AgentLoop 的设计预留了以下扩展点：

1. **动态工具注册**: `config.tools` 每次 LLM 调用前读取，`ToolRegistry.register(tool, { replace: true })` 支持热替换
2. **Provider 运行时切换**: ErrorRecoveryManager 可以通过更新 `config.provider` 实现 Provider 热切换
3. **中间件管道**: `loop.middleware.use(mw)` 注册拦截器，6 个生命周期钩子 (beforeLLMCall / afterLLMCall / beforeToolExecution / afterToolExecution / afterRound)
4. **消息拦截**: `buildInitialMessages()` 可扩展，在 system prompt 和历史消息之间插入自定义消息
5. **新 TurnEvent 类型**: AsyncGenerator 的 yield 机制天然支持新增事件类型
6. **services 注入**: 通过 `AgentLoopContext.services` 统一注入可选服务，新服务加入 `AgentServices` 接口即可

## 12. 架构评估

### 优点

**职责拆分清晰**
`AgentLoop` 从 1035 行单一类演进为 775 行编排层 + 6 个子模块（PlanModeManager / LLMCallManager / ToolExecutor / ContextCompactor / MiddlewarePipeline / PlanState），每个模块职责单一、可独立测试。

**依赖倒置彻底**
`AgentLoopContext` 接口注入全部外部依赖，`services` 子对象收敛可选服务。`AgentLoop` 自身零外部副作用依赖（不依赖 fs、网络、具体 Provider SDK）。

**事件流解耦 UI**
`run()` 是 AsyncGenerator，以 `yield TurnEvent` 向外输出。CLI、VS Code、Web 三种 UI 形态共享同一事件流。

**错误恢复分层合理**
LLM 层错误（重试/切换 Provider/压缩上下文）和工具层错误（反馈 LLM/熔断）分开处理。错误码分类统一在 `ErrorRecoveryManager` 中。

**安全保护多层兜底**
连续错误（≥3）、最大轮次、信号中断、熔断器、权限审批、规划闸门六层保护互相独立。

**中间件可扩展**
`MiddlewarePipeline` 提供 6 个生命周期钩子，支持审计、限流、脱敏等横切关注点，无需修改 AgentLoop 源码。

### 缺点与改进方向

**工具调用无并发**: 多个 tool_use 之间不一定有依赖但不支持并发执行。LLM 返回的 tool_use 顺序只是"建议顺序"。

**services 向后兼容层**: 顶层可选字段和 `services` 子对象双通道并存，新增代码需统一走 `services`。
