import type { AngelConfig } from "./config";
import type { Tool, ToolContext, ToolResult } from "./tools/registry";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

interface SkillDef {
  name: string;
  description: string;
  instruction: string;
  activated: boolean;
}

const skillCache: Map<string, SkillDef> = new Map();

export function discoverSkills(config: AngelConfig): Tool[] {
  const skillsDir = config.skills_dir || join(config.data_dir, "skills");
  if (!existsSync(skillsDir)) return [];

  for (const entry of readdirSync(skillsDir)) {
    const skillPath = join(skillsDir, entry);
    const skillFile = join(skillPath, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const content = readFileSync(skillFile, "utf-8");
    const nameMatch = content.match(/^#\s+(.+)/m);
    const descMatch = content.match(/^>\s*(.+)/m);

    skillCache.set(entry, {
      name: entry,
      description: descMatch?.[1] || nameMatch?.[1] || entry,
      instruction: content,
      activated: false,
    });
  }

  return [activateSkillTool, listSkillsTool];
}

const activateSkillTool: Tool = {
  name: "activate_skill",
  description: "Activate a skill to get specialized instructions. Use list_skills to see available skills.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name to activate" },
    },
    required: ["name"],
  },
  risk: "low",

  async execute(input: { name: string }): Promise<ToolResult> {
    const skill = skillCache.get(input.name);
    if (!skill) {
      const available = [...skillCache.keys()].join(", ");
      return { output: `Skill "${input.name}" not found. Available: ${available}`, isError: true };
    }

    skill.activated = true;
    return { output: `Skill "${input.name}" activated.\n\n${skill.instruction}` };
  },
};

const listSkillsTool: Tool = {
  name: "list_skills",
  description: "List all available skills.",
  parameters: { type: "object", properties: {} },
  risk: "low",

  async execute(): Promise<ToolResult> {
    if (skillCache.size === 0) return { output: "No skills installed." };

    return {
      output: [...skillCache.values()]
        .map((s) => `${s.activated ? "●" : "○"} ${s.name}: ${s.description}`)
        .join("\n"),
    };
  },
};
