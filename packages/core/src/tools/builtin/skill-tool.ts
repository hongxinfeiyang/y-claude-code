// ─── packages/core/src/tools/builtin/skill.ts ───
// Skill 工具 — 调用项目定义的技能
// 解决问题: 让 Agent 通过工具调用方式触发 Skill，而非仅在 system prompt 中注入

import { Tool } from "../../types/tools";
import type { JSONSchema, ToolContext } from "../../types/tools";
import type { ToolResult } from "../../types/messages";
import { SkillLoader } from "../../skills/loader";

let skillLoaderInstance: SkillLoader | null = null;

export function setSkillLoader(loader: SkillLoader): void {
    skillLoaderInstance = loader;
}

export class SkillTool extends Tool {
    name = "Skill";
    description = "调用项目或用户定义的技能（Skill）。Skill 是预定义的任务模板，如代码审查、测试生成、重构等。使用 Skill 可以确保任务按最佳实践执行。";

    parameters = {
        type: "object" as const,
        properties: {
            skill: {
                type: "string",
                description: "要调用的 Skill 名称（如 'code-review'、'test-generator'、'refactor' 等）",
            },
            args: {
                type: "string",
                description: "传递给 Skill 的参数（可选）",
            },
        },
        required: ["skill"],
    } as unknown as JSONSchema;

    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        if (!skillLoaderInstance) {
            return { tool_use_id: "", content: "SkillLoader 未初始化", is_error: true };
        }

        const skillName = params.skill as string;
        const args = (params.args as string) ?? "";

        const skill = skillLoaderInstance.get(skillName);
        if (!skill) {
            const available = skillLoaderInstance
                .listAll()
                .map((s) => s.name)
                .join(", ");
            return {
                tool_use_id: "",
                content: `未找到 Skill "${skillName}"。\n可用 Skills: ${available || "无"}`,
                is_error: true,
            };
        }

        return {
            tool_use_id: "",
            content: `## Skill: ${skill.name}\n**描述**: ${skill.description}\n**级别**: ${skill.level}\n\n${skill.content}${args ? `\n\n参数: ${args}` : ""}`,
        };
    }

    requiresApproval(): boolean { return false; }
}
