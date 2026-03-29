import type { Database } from "bun:sqlite";
import type { AngelConfig } from "../config";
import type { LlmTool } from "../llm";

export interface ToolContext {
  chatId: number;
  channel: string;
  workingDir: string;
  db: Database;
  config: AngelConfig;
  registry?: ToolRegistry;
  sendIntermediate?: (text: string) => Promise<void>;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  metadata?: Record<string, any>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  risk: "low" | "medium" | "high";
  execute(input: any, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: Tool[]) {
    for (const t of tools) this.register(t);
  }

  unregister(name: string) {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): LlmTool[] {
    return [...this.tools.values()].map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async execute(name: string, input: any, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { output: `Unknown tool: ${name}`, isError: true };
    }
    try {
      return await tool.execute(input, ctx);
    } catch (err: any) {
      return { output: `Tool error: ${err.message}`, isError: true };
    }
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }

  count(): number {
    return this.tools.size;
  }
}
