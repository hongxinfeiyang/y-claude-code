// ─── packages/cli/src/utils/renderer.ts ───
// CLI 渲染器 — 终端输出格式化：颜色、Markdown 渲染、代码高亮、帮助信息
// 从 index.ts 拆分，纯输出层，不依赖 I/O 或业务逻辑

// ─── ANSI 颜色码 ───
export const C = {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    purple: "\x1b[35m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    bold: "\x1b[1m",
    blue: "\x1b[34m",
};

/** 旋转指示器帧 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ─── 代码块语法高亮 ───
// 使用 ANSI 颜色高亮关键字、字符串、注释、数字

export function highlightCodeBlock(code: string, _language?: string): string {
    const keywords = /\b(import|export|const|let|var|function|class|return|if|else|for|while|async|await|try|catch|throw|new|extends|implements|interface|type|enum|from|default|switch|case|break|continue|typeof|instanceof|void|null|undefined|true|false|this|super|yield|static|public|private|protected|readonly|abstract|implements|namespace|module|require|module\.exports)\b/g;
    const strings = /("[^"]*"|'[^']*'|`[^`]*`)/g;
    const comments = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;
    const numbers = /\b(\d+\.?\d*)\b/g;

    return code
        .split("\n")
        .map((line) => {
            if (line.trim().startsWith("//") || line.trim().startsWith("/*")) {
                return `${C.dim}${line}${C.reset}`;
            }
            let colored = line;
            colored = colored.replace(strings, `${C.green}$1${C.reset}`);
            colored = colored.replace(comments, `${C.dim}$1${C.reset}`);
            colored = colored.replace(keywords, `${C.cyan}$1${C.reset}`);
            colored = colored.replace(numbers, `${C.yellow}$1${C.reset}`);
            return colored;
        })
        .join("\n");
}

// ─── 流式 Markdown 渲染器 ───
// 解决问题: LLM 文本是分 chunk 流式到达的，但 Markdown 渲染需要按行处理
//         （代码块边界检测、标题识别依赖行首），不能直接对 chunk 做渲染。
//         本类维护行缓冲 + 代码块状态，增量消费完整行，返回 ANSI 格式化结果。

export class StreamingMarkdownRenderer {
    private lineBuffer = "";
    private inCodeBlock = false;
    private codeLang = "";
    private codeBuffer: string[] = [];
    /** 跨 chunk 追踪连续空白行数，防止模型输出大片空白 */
    private blankRun = 0;

    /** 喂入文本 chunk，返回可立即输出的 ANSI 格式化文本 */
    processChunk(chunk: string): string {
        this.lineBuffer += chunk;
        const lines = this.lineBuffer.split("\n");
        // 最后一段是不完整行，保留在缓冲中
        this.lineBuffer = lines.pop() ?? "";

        // 无完整行可消费时直接返回，避免多余换行
        if (lines.length === 0) return "";

        const output: string[] = [];
        for (const line of lines) {
            // 兼容 \r\n：去掉行尾的 \r
            const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
            if (cleanLine.trim().startsWith("```")) {
                if (this.inCodeBlock) {
                    const highlighted = highlightCodeBlock(this.codeBuffer.join("\n"), this.codeLang);
                    if (highlighted) {
                        output.push(highlighted);
                        this.blankRun = 0;
                    }
                    this.codeBuffer = [];
                    this.inCodeBlock = false;
                    this.codeLang = "";
                } else {
                    this.inCodeBlock = true;
                    this.codeLang = cleanLine.trim().slice(3).trim();
                }
                continue;
            }
            if (this.inCodeBlock) {
                this.codeBuffer.push(cleanLine);
                continue;
            }
            const rendered = this.renderInline(cleanLine);
            if (rendered.trim() === "") {
                this.blankRun++;
                if (this.blankRun <= 2) {
                    output.push(rendered);
                }
                // 超过 2 连续空白行则丢弃，防止大片空白区域
            } else {
                this.blankRun = 0;
                output.push(rendered);
            }
        }
        // 每个被消费的行对应输入中的一个 \n，必须还给输出
        // 若全部都是被跳过的空白行（output 为空），则不输出任何内容
        if (output.length === 0) return "";
        return output.join("\n") + "\n";
    }

    /** 流结束，冲刷缓冲区 */
    flush(): string {
        const output: string[] = [];
        // 未闭合的代码块
        if (this.codeBuffer.length > 0) {
            const highlighted = highlightCodeBlock(this.codeBuffer.join("\n"), this.codeLang);
            if (highlighted) {
                output.push(highlighted);
                this.blankRun = 0;
            }
            this.codeBuffer = [];
            this.inCodeBlock = false;
        }
        // 残余的半行
        if (this.lineBuffer) {
            const rendered = this.renderInline(this.lineBuffer);
            if (rendered.trim() === "") {
                this.blankRun++;
                if (this.blankRun <= 2) {
                    output.push(rendered);
                }
            } else {
                this.blankRun = 0;
                output.push(rendered);
            }
            this.lineBuffer = "";
        }
        return output.join("\n");
    }

    /** 单行的内联格式: **bold** `code` [link](url) # header */
    private renderInline(line: string): string {
        let formatted = line;
        if (/^#{1,6}\s/.test(formatted)) {
            formatted = `${C.bold}${formatted}${C.reset}`;
        }
        formatted = formatted.replace(/\*\*(.+?)\*\*/g, `${C.bold}$1${C.reset}`);
        formatted = formatted.replace(/`([^`]+)`/g, `${C.yellow}$1${C.reset}`);
        formatted = formatted.replace(/\[([^\]]+)\]\([^)]+\)/g, `${C.cyan}$1${C.reset}`);
        return formatted;
    }
}

// ─── 非流式 Markdown 渲染（plan 展示等一次性输出场景）───
export function renderMarkdown(text: string): string {
    const renderer = new StreamingMarkdownRenderer();
    return renderer.processChunk(text) + renderer.flush();
}

// ─── 帮助文本 ───

export function showHelp(): void {
    console.log(`y-claude-code — AI 编程助手 CLI

用法: y-claude-code [选项]
  --model <name>   指定模型
  --setup          进入 LLM 自助配置向导
  --resume <id>    恢复指定会话
  --sessions       列出历史会话
  --version        显示版本号
  --help           显示帮助信息`);
}
