# @y-claude-code/cli

终端 CLI — AI 编程助手命令行交互入口。

## 文件

| 文件 | 职责 |
|------|------|
| `src/index.ts` | CLI 入口（调用 startup → input-handler 创建 readline 交互主循环） |
| `src/commands/slash.ts` | 20 个斜杠命令的注册与执行 |
| `src/utils/startup.ts` | 启动器：Config 加载、Provider 创建、Sandbox 预热、Tools/Permissions/Hooks/Cron 初始化 |
| `src/utils/input-handler.ts` | 输入处理器：readline 设置、SIGINT 中断、用户 y/n/a 确认、Agent Loop 事件消费与终端输出 |
| `src/utils/renderer.ts` | 终端渲染器：ANSI 颜色码、spinner 帧、StreamingMarkdownRenderer（代码高亮+空白行压缩）、帮助信息 |
| `src/utils/diagnostics.ts` | 环境诊断（Node/平台/Shell/Provider/Model/配置路径） |

## 终端渲染

```
用户输入:  > [紫色提示符]

工具调用:  ⚙ 读取文件 src/app.ts 执行中...
           ⚙ 执行命令 npm test 执行中...

权限确认:  🔐 需要执行命令执行: npm test，是否允许？
           (y=允许 / n=拒绝 / a=本会话全允许此类操作):
             y → ✓ 已允许（后续相同操作自动放行）
             a → ✓ 已允许（本次会话自动放行所有 命令执行）

流式回复:  Markdown → ANSI（代码块高亮、粗体、行内代码、标题着色）
           连续空白行自动压缩（最多保留 2 行）
```

## 启动

```bash
y-claude-code               # 新会话
y-claude-code --resume <id>  # 恢复会话
y-claude-code --setup        # LLM 配置向导
y-claude-code --sessions     # 列出历史会话
y-claude-code --version      # 版本号
```

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| Enter | 发送消息 |
| Ctrl+C | 中断当前操作 |
| Ctrl+D | 退出 |
| Ctrl+R | 搜索历史 |
| `\` 结尾 | 多行续行 |
