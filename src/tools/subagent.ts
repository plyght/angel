import type { Tool, ToolContext, ToolResult } from "./registry";
import { processMessage } from "../agent";

const MAX_DEPTH = 2;
const MAX_CONCURRENT = 4;

const runningAgents: Map<number, { id: number; name: string; status: string; result?: string; [k: string]: any }> = new Map();
let nextId = 1;

export const spawnSubagentTool: Tool = {
  name: "spawn_subagent",
  description: "Spawn a sub-agent to handle a task in the background. The sub-agent runs autonomously with a restricted tool set.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name for the sub-agent" },
      prompt: { type: "string", description: "Task instruction for the sub-agent" },
      max_iterations: { type: "number", description: "Max tool iterations (default: 20)" },
    },
    required: ["name", "prompt"],
  },
  risk: "medium",

  async execute(input: { name: string; prompt: string; max_iterations?: number }, ctx: ToolContext): Promise<ToolResult> {
    const running = [...runningAgents.values()].filter((a) => a.status === "running");
    if (running.length >= MAX_CONCURRENT) {
      return { output: `Max concurrent sub-agents (${MAX_CONCURRENT}) reached`, isError: true };
    }

    const id = nextId++;
    const entry: { id: number; name: string; status: string; result?: string } = { id, name: input.name, status: "running" };
    runningAgents.set(id, entry);

    ctx.db.run(
      `INSERT INTO subagent_runs (chat_id, name, prompt, status, max_iterations) VALUES (?, ?, ?, 'running', ?)`,
      [ctx.chatId, input.name, input.prompt, input.max_iterations || 20]
    );

    (async () => {
      try {
        const rawResult = await processMessage(input.prompt, {
          chatId: ctx.chatId,
          channel: ctx.channel,
          db: ctx.db,
          config: { ...ctx.config, max_tool_iterations: input.max_iterations || 20 },
          registry: ctx.registry!,
        });
        const result = typeof rawResult === "string" ? rawResult : "Interrupted";
        entry.status = "completed";
        entry.result = result;
        ctx.db.run(
          `UPDATE subagent_runs SET status = 'completed', result = ?, finished_at = datetime('now') WHERE name = ? AND chat_id = ? AND status = 'running'`,
          [result, input.name, ctx.chatId]
        );
      } catch (err: any) {
        entry.status = "failed";
        entry.result = err.message;
        ctx.db.run(
          `UPDATE subagent_runs SET status = 'failed', result = ?, finished_at = datetime('now') WHERE name = ? AND chat_id = ? AND status = 'running'`,
          [err.message, input.name, ctx.chatId]
        );
      }
    })();

    return { output: `Sub-agent #${id} "${input.name}" spawned. Use list_subagents to check status.` };
  },
};

export const listSubagentsTool: Tool = {
  name: "list_subagents",
  description: "List all sub-agents and their status.",
  parameters: { type: "object", properties: {} },
  risk: "low",

  async execute(_input: any, ctx: ToolContext): Promise<ToolResult> {
    const runs = ctx.db.query(
      "SELECT * FROM subagent_runs WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10"
    ).all(ctx.chatId) as any[];

    if (runs.length === 0) return { output: "No sub-agents." };

    return {
      output: runs.map((r: any) =>
        `#${r.id} [${r.status}] "${r.name}" | ${r.result ? r.result.slice(0, 200) : "running..."}`
      ).join("\n"),
    };
  },
};

export const subagentTools = [spawnSubagentTool, listSubagentsTool];
