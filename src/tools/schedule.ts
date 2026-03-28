import type { Tool, ToolContext, ToolResult } from "./registry";
import { createScheduledTask, updateTaskStatus } from "../db";
import { getNextCronRun } from "../scheduler";

export const createTaskTool: Tool = {
  name: "schedule_task",
  description: "Schedule a task to run on a cron schedule or as a one-shot at a specific time.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Task name" },
      prompt: { type: "string", description: "The instruction to execute when the task runs" },
      cron: { type: "string", description: "Cron expression (e.g., '0 9 * * *' for daily at 9am). Omit for one-shot." },
      run_at: { type: "string", description: "ISO datetime for one-shot tasks (e.g., '2025-01-15T14:00:00Z')" },
      timezone: { type: "string", description: "IANA timezone (default: UTC)" },
    },
    required: ["name", "prompt"],
  },
  risk: "medium",

  async execute(input: { name: string; prompt: string; cron?: string; run_at?: string; timezone?: string }, ctx: ToolContext): Promise<ToolResult> {
    const tz = input.timezone || ctx.config.timezone || "UTC";

    let nextRunAt: string;
    if (input.cron) {
      try {
        nextRunAt = getNextCronRun(input.cron, tz);
      } catch (err: any) {
        return { output: `Invalid cron expression: ${err.message}`, isError: true };
      }
    } else if (input.run_at) {
      nextRunAt = new Date(input.run_at).toISOString();
    } else {
      return { output: "Either 'cron' or 'run_at' is required", isError: true };
    }

    const id = createScheduledTask(ctx.db, ctx.chatId, input.name, input.prompt, input.cron || null, nextRunAt, tz);
    return { output: `Task #${id} "${input.name}" scheduled. Next run: ${nextRunAt}` };
  },
};

export const listTasksTool: Tool = {
  name: "list_scheduled_tasks",
  description: "List all scheduled tasks for the current chat.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "paused", "completed", "failed", "all"], description: "Filter by status" },
    },
  },
  risk: "low",

  async execute(input: { status?: string }, ctx: ToolContext): Promise<ToolResult> {
    const status = input.status || "all";
    let query = "SELECT * FROM scheduled_tasks WHERE chat_id = ?";
    const params: any[] = [ctx.chatId];

    if (status !== "all") {
      query += " AND status = ?";
      params.push(status);
    }
    query += " ORDER BY created_at DESC LIMIT 20";

    const tasks = ctx.db.query(query).all(...params) as any[];
    if (tasks.length === 0) return { output: "No scheduled tasks." };

    return {
      output: tasks.map((t: any) =>
        `#${t.id} [${t.status}] "${t.name}" | cron: ${t.cron_expr || "one-shot"} | next: ${t.next_run_at}`
      ).join("\n"),
    };
  },
};

export const cancelTaskTool: Tool = {
  name: "cancel_scheduled_task",
  description: "Cancel or pause a scheduled task.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "number", description: "Task ID" },
      action: { type: "string", enum: ["cancel", "pause", "resume"], description: "Action to take" },
    },
    required: ["task_id", "action"],
  },
  risk: "low",

  async execute(input: { task_id: number; action: string }, ctx: ToolContext): Promise<ToolResult> {
    const statusMap: Record<string, string> = {
      cancel: "cancelled",
      pause: "paused",
      resume: "active",
    };
    const newStatus = statusMap[input.action];
    if (!newStatus) return { output: `Unknown action: ${input.action}`, isError: true };

    updateTaskStatus(ctx.db, input.task_id, newStatus);
    return { output: `Task #${input.task_id} ${input.action}d.` };
  },
};

export const scheduleTools = [createTaskTool, listTasksTool, cancelTaskTool];
