# @y-claude-code/core

核心引擎 — Agent 循环、工具系统、LLM 适配、权限、上下文管理等。CLI 和 VS Code 插件共享此运行时。

## 模块

| 模块 | 职责 |
|------|------|
| `agent/` | ReAct 主循环 (`loop.ts`) + PlanMode 管理 + LLM 调用管理 + 工具执行管道 + 中间件 + 上下文压缩 + 错误恢复 |
| `tools/builtin/` | 20 个内置工具：Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/Agent/AskUserQuestion/TodoWrite/NotebookEdit/EnterPlanMode/ExitPlanMode/EnterWorktree/ExitWorktree/TaskOutput/TaskStop/Skill/CronCreate/CronDelete/CronList/ScheduleWakeup |
| `llm/` | Anthropic + OpenAI Provider，Token 计数，Provider 工厂 |
| `context/` | 上下文构建、LLM 驱动渐进式摘要 (`summarizer.ts`)、Prompt Cache 管理、窗口监控 |
| `permission/` | 五级权限 + 规则引擎 + session 缓存（细粒度 key：Bash:cmd、Write/Edit:file_path） |
| `router/` | 意图识别路由（内置命令 / 直接工具调用 / 自然语言） |
| `session/` | 会话生命周期管理 + JSON 文件持久化 |
| `skills/` | Markdown + frontmatter 技能加载（用户/项目/内置三级优先级） |
| `hooks/` | 工具/LLM/会话生命周期事件钩子 |
| `memory/` | user/feedback/project/reference 四类持久记忆 |
| `observability/` | JSONL Transcript 记录 + Metrics (Counter/Histogram/Gauge) + Span Tracing |
| `config/` | cosmiconfig 多级配置加载（4 级合并） |
| `utils/` | Logger、Cron 调度器、Security（输入净化/输出脱敏/注入检测）、AutoUpdate、Telemetry、Tmux 集成 |

## 关键类型

| 文件 | 类型 |
|------|------|
| `types/agent.ts` | AgentConfig, AgentState, TurnEvent, AgentLoopContext, AgentServices |
| `types/messages.ts` | Message, ToolUse, ToolResult, ResponseChunk, TokenUsage |
| `types/config.ts` | LLMProvider, PermissionRule, PermissionLevel |
| `types/session.ts` | SessionData |
| `types/tools.ts` | Tool, ToolContext, JSONSchema |

## 使用

```typescript
import { AgentLoop, ToolRegistry, PermissionManager } from "@y-claude-code/core";

const loop = new AgentLoop();
const ctx: AgentLoopContext = { /* ... */ };
for await (const event of loop.run("帮我分析代码", config, ctx)) {
    // 处理 text / tool_call / tool_result / error / done 事件
}
```

## 依赖注入

core 包零外部副作用依赖。沙箱 (`ISandbox`)、文件系统等由上层注入接口实现，不直接依赖 `dockerode`、`fs` 等。
