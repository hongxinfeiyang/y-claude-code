# AgentLoop 架构设计说明

## 1. 概述

`AgentLoop` 是本系统的调度中枢，实现了 **ReAct (Reasoning + Acting)** 范式的核心循环。它接收用户输入，交替驱动 LLM 推理和工具调用，通过异步事件流向外暴露过程状态，直到任务完成或触发终止条件。

**文件位置**: [packages/core/src/agent/loop.ts](packages/core/src/agent/loop.ts)

**核心职责**:
- 管理 Agent 生命周期状态机（8 种状态）
- 调度 LLM 推理→工具调用→观察→再推理的循环
- 将工具执行结果反馈给 LLM，形成闭环
- 集成错误恢复、权限检查、可观测性等横切关注点

## 2. 在系统中的位置

```
┌─────────────────────────────────────────────────┐
│  IntentRouter                                   │
│    └── 自然语言输入 → AgentLoop.run()             │
├─────────────────────────────────────────────────┤
│  AgentLoop (本文档)                              │
│    ├── buildInitialMessages()  // 构建上下文      │
│    ├── while (toolRounds < max)                 │
│    │    ├── provider.chat()     // LLM 推理      │
│    │    ├── permissionMgr.check() // 权限检查     │
│    │    └── tool.execute()      // 工具执行 ⚡     │
│    ├── ErrorRecoveryManager      // 错误恢复      │
│    ├── Summarizer                // 上下文压缩    │
│    ├── CacheManager              // Prompt Cache │
│    ├── ContextMonitor            // Token 监控   │
│    └── ObservabilityManager      // 可观测性      │
├──────────────────────────────────────────────────┤
│  LLMProvider (Anthropic / OpenAI)                │
│  ToolRegistry (20+ 内置工具)                       │
└──────────────────────────────────────────────────┘
```

AgentLoop 是"调度者"而非"执行者"：它不直接调用 LLM API，不直接执行工具逻辑，而是通过接口编排下层模块协作。

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

| 退出点 | 代码位置 | 去向 |
| ------ | -------- | ---- |
| 无工具调用 | `toolUses.length === 0` (L379) | DONE |
| 连续 3 次错误 | `consecutiveErrors >= 3` (L564) | ERROR |
| 用户中断 | `signal.aborted` (L218) | DONE |

第 4 个退出口在 while 之外：`toolRounds >= maxToolRounds` 导致 while 条件为 false，自然落出循环 (L591-601)，yield error + done。

**关键区分**：

- 只有工具调用才会回到 while 顶部继续下一轮迭代。纯文本回答通过 `return` 直接跳出，不经过 `toolRounds++`，不走 `while` 条件判断。
- `consecutiveErrors >= 3` 在追加结果到 messages **之前**检查（L564），所以错误轮次的结果不会污染上下文。
- RECOVERING 状态通过 `continue` 回到 while 顶部重新调 LLM，不走正常的工具结果追加流程。

| 当前状态 | 触发事件 | 目标状态 |
|---------|---------|---------|
| IDLE | `run()` 被调用 | THINKING |
| THINKING | LLM 流式响应中 | THINKING |
| THINKING | LLM 返回 tool_use | WAITING_APPROVAL / EXECUTING |
| THINKING | LLM 返回文本，无工具调用 | DONE |
| THINKING | LLM 调用抛异常，可恢复 | RECOVERING → THINKING |
| THINKING | LLM 调用抛异常，不可恢复 | ERROR |
| WAITING_APPROVAL | 用户审批通过 | EXECUTING |
| WAITING_APPROVAL | 用户拒绝 | THINKING (反馈 LLM) |
| EXECUTING | 工具执行完成 (toolRounds < max) | THINKING (while 循环继续) |
| EXECUTING | 工具执行完成 (toolRounds >= max) | DONE (退出 while) |
| EXECUTING | 连续 3 次错误 | ERROR |
| EXECUTING | EnterPlanMode 工具调用 | PLANNING |
| PLANNING | ExitPlanMode 工具调用 | THINKING |
| (任意) | signal.aborted | DONE |

## 4. 核心数据结构

### 4.1 内部字段

```
AgentLoop
├── state: AgentState           // 当前状态机状态
├── messages: Message[]         // 累积的完整对话上下文
├── toolRounds: number          // 当前会话工具调用轮次计数
├── tokenUsage: TokenUsage      // Token 消耗统计 (input/output/cache)
├── consecutiveErrors: number   // 连续工具错误计数 (>=3 触发保护)
├── llmRecoveryCount: number    // LLM 恢复连续计数 (>=3 触发保护，防止恢复死循环)
├── planMode: boolean           // 是否处于计划模式
└── originalTools: Tool[]       // 进入计划模式前的完整工具列表
```

### 4.2 运行时依赖 (AgentLoopContext)

AgentLoop 通过 `AgentLoopContext` 接口接收所有外部依赖，遵循依赖倒置原则：

| 依赖 | 类型 | 作用 |
|------|------|------|
| `permissionManager` | PermissionManager | 工具调用前的权限校验 |
| `sandbox` | ISandbox (可选) | 容器化隔离执行 |
| `logger` | Logger (可选) | 结构化日志记录 |
| `sessionId` | string | 会话标识，工具上下文透传 |
| `workingDirectory` | string | 工作目录，工具相对路径解析 |
| `appendMessage` | callback | 推送中间状态消息到 UI |
| `signal` | AbortSignal (可选) | 用户取消信号 |
| `errorRecoveryManager` | ErrorRecoveryManager (可选) | 错误分类、重试、回退、熔断 |
| `summarizer` | Summarizer (可选) | LLM 驱动的对话摘要压缩 |
| `observability` | ObservabilityManager (可选) | Transcript、Metrics、Span Tracing |
| `cacheManager` | CacheManager (可选) | Prompt Cache 状态追踪 |
| `contextMonitor` | ContextMonitor (可选) | Token 使用率实时监控 |

## 5. 主流程 (run 方法)

`run()` 拆分为三个阶段的子生成器，通过 `yield*` 委托调用，主循环只做编排：

```
run(userInput, config, loopCtx)
 │
 ├─ 1. 重置内部状态 (state/toolRounds/consecutiveErrors/llmRecoveryCount/planMode)
 ├─ 2. buildInitialMessages(userInput, config) 构建消息上下文
 ├─ 3. observability.startTurn() 开启 Trace
 │
 └─ 4. while (toolRounds < maxToolRounds):
       │
       ├─ 4.1 signal.aborted? → yield done, return
       │
       ├─ 4.2 Phase 1: yield* executeThinkingPhase(config, loopCtx, signal)
       │     ├─ proactiveContextCheck() — 主动检查上下文使用率 (>=85% 预压缩)
       │     ├─ provider.chat() → 流式 chunk 处理
       │     │   ├─ "text" / "thinking" → yield
       │     │   ├─ "tool_use" → 收集
       │     │   ├─ "stop" → 更新 token 统计, llmRecoveryCount=0
       │     │   └─ "error" → classifyChunkError → handleLLMRecovery()
       │     ├─ catch 异常 → handleLLMRecovery()
       │     │   ├─ 可恢复 + llmRecoveryCount <= 3 → yield recovering, continue
       │     │   └─ 不可恢复 或 llmRecoveryCount > 3 → yield error, return
       │     └─ toolUses.length === 0? → yield done, return
       │
       ├─ 4.3 追加 assistant 消息
       │
       ├─ 4.4 Phase 2: yield* executeToolPhase(toolUses, config, loopCtx, signal)
       │     └─ for each toolUse (顺序):
       │          ├─ findTool() / 熔断检查 / requiresApproval → permissionManager.check()
       │          ├─ tool.execute() → 成功: consecutiveErrors=0, 失败: 错误恢复
       │          └─ 熔断触发 → return abort=true
       │
       ├─ 4.5 Phase 3: yield* finalizeRound(toolResults, toolUses, config, loopCtx)
       │     ├─ handlePlanModeTransitions() — Plan Mode 检测
       │     ├─ consecutiveErrors >= 3? 或 llmRecoveryCount > 3? → yield error, return
       │     ├─ truncateToolResults() — 截断过大结果 (>8000 token 估)
       │     ├─ 追加 tool_result 到 messages[]
       │     └─ toolRounds++
       │
       └─ (回到 4.1)
```

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
  → classifyChunkError(code) 映射错误码到 ErrorCategory
  → errorRecoveryManager.handleLLMError(...)
  → 同上恢复流程
```

### 6.3 工具执行层

```
tool.execute() 抛异常
  → errorRecoveryManager.handleToolError(err, toolName)
    ├─ CIRCUIT_BREAK: yield error, return (终止循环)
    └─ FEEDBACK_TO_LLM: 结果标记 is_error, 继续循环
```

错误码到 ErrorCategory 的映射逻辑在 `classifyChunkError()`:

| LLM 错误码 | ErrorCategory |
|-----------|---------------|
| `rate_limit_error`, `rate_limit` | RATE_LIMIT |
| `authentication_error`, `invalid_auth` | AUTH |
| `invalid_request_error` | INVALID_REQUEST |
| `context_length_exceeded`, `token_limit_exceeded` | CONTEXT_OVERFLOW |
| `server_error`, `api_error`, `overloaded` | PROVIDER_ERROR |
| `network_error`, `timeout`, `connection_error` | NETWORK |

## 7. 上下文压缩

当 LLM 返回 CONTEXT_OVERFLOW 错误时，`compactMessages()` 被调用：

```
compactMessages(summarizer?)
  │
  ├─ 保留 system 消息 (role: "system")
  ├─ 保留最近 50% 的非 system 消息
  │
  └─ 生成摘要消息插入中间:
       ├─ summarizer.getAccumulatedSummary() (LLM 语义摘要)
       └─ 或 "[上下文压缩]: 省略了 N 条历史消息" (简单截断)
```

压缩策略优先使用 LLM 驱动的语义摘要，保留更多关键信息；未配置 Summarizer 时回退到简单截断。

## 8. 计划模式

计划模式是一个特殊的运行状态，通过两个内置工具触发：

- **EnterPlanMode**: 保存完整工具列表 (`originalTools`)，将可用工具过滤为只读子集 (`filterToolsForPlanMode`)，状态切换为 `PLANNING`
- **ExitPlanMode**: 恢复完整工具列表，输出 plan 内容，状态返回 `THINKING`

计划模式下的工具过滤发生在每次 LLM 调用前（`loop.ts:243-245`），而非一次性切换，这确保了即使工具列表在运行时变动也能正确过滤。

## 9. 安全保护机制

| 机制 | 触发条件 | 行为 |
| ---- | -------- | ---- |
| 连续工具错误保护 | `consecutiveErrors >= 3` | 终止循环，yield error |
| LLM 恢复死循环保护 | `llmRecoveryCount > 3` | 连续 RETRY/SWITCH/COMPACT 超过 3 次 → 终止 |
| 最大轮次限制 | `toolRounds >= maxToolRounds` | 终止循环，yield error + done |
| 用户中断检测 | `signal.aborted` | 每次循环入口检测，立即终止 |
| 熔断器 | `errorRecoveryManager.checkCircuitBreaker()` | 工具执行前检查，熔断中直接拒绝 |
| 权限检查 | `tool.requiresApproval()` | 弹窗→用户确认→放行/拒绝 |
| 主动上下文压缩 | `contextMonitor.usagePercent >= 85%` | 每次 LLM 调用前检查，不等 API 报错 |
| 工具结果截断 | 估算 token > 8000 | 追加到 messages 前截断，防止撑爆上下文 |

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

1. **动态工具注册**: `config.tools` 每次 LLM 调用前读取，支持运行时增删工具
2. **Provider 运行时切换**: ErrorRecoveryManager 可以通过更新 `config.provider` 实现 Provider 热切换
3. **自定义错误分类**: `classifyChunkError()` 可以扩展新的错误码映射
4. **消息拦截**: `buildInitialMessages()` 可扩展，在 system prompt 和历史消息之间插入自定义消息
5. **新 TurnEvent 类型**: AsyncGenerator 的 yield 机制天然支持新增事件类型，UI 层按 type 分发

## 12. 架构评估

### 优点

**依赖倒置彻底**
`AgentLoopContext` 接口注入全部 12 项外部依赖（权限、沙箱、日志、错误恢复、可观测性等），`AgentLoop` 自身零外部 import（不依赖 fs、网络、具体 Provider SDK）。这使得 core 包可独立测试，上层接入可替换任意实现。

**事件流解耦 UI**
`run()` 是 AsyncGenerator，以 `yield TurnEvent` 向外输出。CLI、VS Code、Web 三种 UI 形态共享同一事件流，只需按 `type` 分发渲染。新增事件类型不影响已有消费者。

**错误恢复分层合理**
LLM 层错误（重试/切换 Provider/压缩上下文）和工具层错误（反馈 LLM/熔断）分开处理，各自有独立的决策链路。Provider 回退链支持运行时热切换，用户无感知。

**安全保护多层兜底**
连续错误（≥3）、最大轮次、信号中断、熔断器、权限审批五层保护互相独立。任意一层触发都能终止循环，不存在单点失效。熔断器提供工具级保护，连续错误保护是兜底。

**Plan Mode 无侵入**
通过 `EnterPlanMode` / `ExitPlanMode` 两个工具在循环内切换，不破坏主流程结构。工具过滤发生在每次 LLM 调用前而非一次性快照，运行时工具变动也能正确响应。

### 缺点与改进方向

**待优化**：目前看收益有限，后续根据反馈持续优化

**工具调用无并发**
多个 tool_use 之间不一定有依赖（如同时读两个文件、并行搜索），但当前一律顺序执行。LLM 返回的 tool_use 顺序只是"建议顺序"，不是强制依赖。
→ 可引入工具依赖声明（`dependsOn: ["tool_id"]`），无依赖的工具并发执行。

**缺少中间件机制**
如果在 LLM 调用前后或工具执行前后需要插入自定义逻辑（审计、额外脱敏、自定义限流），当前只能修改 AgentLoop 源码。Hook 系统在 AgentLoop 外部，不能介入循环内部环节。
→ 可引入 `AgentMiddleware` 链：`(ctx, next) => yield* next(ctx)`。
