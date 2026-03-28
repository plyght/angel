import type { Tool, ToolResult, ToolContext } from "./registry";
import { getRecentMessages } from "../db";
import { writeFileSync } from "fs";
import { join } from "path";

export const getCurrentTimeTool: Tool = {
  name: "get_current_time",
  description: "Get the current date and time, optionally in a specific timezone.",
  parameters: {
    type: "object",
    properties: {
      timezone: { type: "string", description: "IANA timezone (e.g., 'America/New_York'). Default: system timezone." },
    },
  },
  risk: "low",

  async execute(input: { timezone?: string }): Promise<ToolResult> {
    const tz = input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const now = new Date();
      const formatted = now.toLocaleString("en-US", {
        timeZone: tz,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      });
      return { output: `${formatted}\nISO: ${now.toISOString()}\nUnix: ${Math.floor(now.getTime() / 1000)}` };
    } catch (err: any) {
      return { output: `Time error: ${err.message}`, isError: true };
    }
  },
};

export const todoTool: Tool = {
  name: "todo",
  description: "Manage a simple todo list for the current chat. Actions: list, add, complete, remove.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "complete", "remove"], description: "Action to perform" },
      text: { type: "string", description: "Todo text (for add)" },
      index: { type: "number", description: "Todo index (for complete/remove, 1-based)" },
    },
    required: ["action"],
  },
  risk: "low",

  async execute(input: { action: string; text?: string; index?: number }, ctx: ToolContext): Promise<ToolResult> {
    const key = `todos_${ctx.chatId}`;
    const raw = ctx.db.query("SELECT value FROM db_meta WHERE key = ?").get(key) as { value: string } | null;
    let todos: Array<{ text: string; done: boolean }> = raw ? JSON.parse(raw.value) : [];

    switch (input.action) {
      case "list":
        if (todos.length === 0) return { output: "No todos." };
        return {
          output: todos.map((t, i) => `${i + 1}. [${t.done ? "x" : " "}] ${t.text}`).join("\n"),
        };
      case "add":
        if (!input.text) return { output: "Missing text", isError: true };
        todos.push({ text: input.text, done: false });
        break;
      case "complete":
        if (!input.index || input.index < 1 || input.index > todos.length)
          return { output: "Invalid index", isError: true };
        todos[input.index - 1].done = true;
        break;
      case "remove":
        if (!input.index || input.index < 1 || input.index > todos.length)
          return { output: "Invalid index", isError: true };
        todos.splice(input.index - 1, 1);
        break;
      default:
        return { output: `Unknown action: ${input.action}`, isError: true };
    }

    ctx.db.run("INSERT OR REPLACE INTO db_meta (key, value) VALUES (?, ?)", [key, JSON.stringify(todos)]);
    return { output: `Done. ${todos.length} todo(s).` };
  },
};

export const exportChatTool: Tool = {
  name: "export_chat",
  description: "Export chat history to a markdown file.",
  parameters: {
    type: "object",
    properties: {
      filename: { type: "string", description: "Output filename (default: chat_export.md)" },
      limit: { type: "number", description: "Number of recent messages (default: 100)" },
    },
  },
  risk: "low",

  async execute(input: { filename?: string; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
    const messages = getRecentMessages(ctx.db, ctx.chatId, input.limit || 100);
    const lines = messages.map((m: any) => {
      const role = m.is_from_bot ? "Angel" : (m.sender_name || "User");
      return `### ${role} (${m.timestamp})\n\n${m.content}\n`;
    });

    const filename = input.filename || "chat_export.md";
    const outPath = join(ctx.workingDir, filename);
    writeFileSync(outPath, `# Chat Export\n\n${lines.join("\n---\n\n")}`, "utf-8");
    return { output: `Exported ${messages.length} messages to ${filename}` };
  },
};

export const calculateTool: Tool = {
  name: "calculate",
  description: "Evaluate a mathematical expression. Supports basic arithmetic, Math functions, etc.",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Math expression (e.g., '2 + 3 * 4', 'Math.sqrt(144)')" },
    },
    required: ["expression"],
  },
  risk: "low",

  async execute(input: { expression: string }): Promise<ToolResult> {
    try {
      const sanitized = input.expression.replace(/[^0-9+\-*/().%^eE ,Math.sqrtpowabsceilfloorlogroundminmaxPIsincostan]/g, "");
      const result = new Function("Math", `"use strict"; return (${sanitized})`)(Math);
      return { output: String(result) };
    } catch (err: any) {
      return { output: `Calculation error: ${err.message}`, isError: true };
    }
  },
};

export const miscTools = [getCurrentTimeTool, todoTool, exportChatTool, calculateTool];
