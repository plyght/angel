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
      action: { type: "string", enum: ["list", "add", "complete", "remove", "edit"], description: "Action to perform" },
      text: { type: "string", description: "Todo text (for add/edit)" },
      index: { type: "number", description: "Todo index (for complete/remove/edit, 1-based)" },
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
      case "edit":
        if (!input.index || input.index < 1 || input.index > todos.length)
          return { output: "Invalid index", isError: true };
        if (!input.text) return { output: "Missing text", isError: true };
        todos[input.index - 1].text = input.text;
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

export const listChatsTool: Tool = {
  name: "list_chats",
  description: "List known chats across all channels. Useful for finding chat IDs for cross-channel messaging.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Filter by channel (e.g., 'signal', 'discord')" },
      limit: { type: "number", description: "Max results (default: 20)" },
    },
  },
  risk: "low",

  async execute(input: { channel?: string; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
    let query = "SELECT id, channel, external_chat_id, chat_type, title, created_at FROM chats";
    const params: any[] = [];
    if (input.channel) {
      query += " WHERE channel = ?";
      params.push(input.channel);
    }
    query += " ORDER BY id DESC LIMIT ?";
    params.push(input.limit || 20);

    const chats = ctx.db.query(query).all(...params) as any[];
    if (chats.length === 0) return { output: "No chats found." };

    return {
      output: chats.map((c: any) =>
        `#${c.id} [${c.channel}] ${c.title || c.external_chat_id} (${c.chat_type})`
      ).join("\n"),
    };
  },
};

export const verifySafeWordTool: Tool = {
  name: "verify_safe_word",
  description: "Verify the user's safe word before performing a dangerous action. Returns whether the provided word matches.",
  parameters: {
    type: "object",
    properties: {
      word: { type: "string", description: "The safe word provided by the user" },
    },
    required: ["word"],
  },
  risk: "low",

  async execute(input: { word: string }, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.config.safe_word) return { output: "No safe word configured", isError: true };
    const match = input.word.trim().toLowerCase() === ctx.config.safe_word.trim().toLowerCase();
    return { output: match ? "verified" : "incorrect" };
  },
};

export const manageAllowedUsersTool: Tool = {
  name: "manage_allowed_users",
  description: "Add or remove users who are allowed to interact with Angel on a specific channel. Requires safe word verification for security.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "remove", "list"], description: "Action to perform" },
      channel: { type: "string", description: "Channel (e.g., 'signal', 'discord', 'slack', 'imessage')" },
      user_id: { type: "string", description: "User identifier (phone number for Signal, username for Discord, etc.)" },
    },
    required: ["action", "channel"],
  },
  risk: "high",

  async execute(input: { action: string; channel: string; user_id?: string }, ctx: ToolContext): Promise<ToolResult> {
    if (input.action === "list") {
      const rows = ctx.db.query("SELECT user_id, added_by, created_at FROM allowed_users WHERE channel = ?").all(input.channel) as any[];
      if (rows.length === 0) return { output: `No allowed users for ${input.channel} (all users permitted).` };
      return {
        output: rows.map((r: any) => `${r.user_id} (added by: ${r.added_by}, ${r.created_at})`).join("\n"),
      };
    }

    if (!input.user_id) return { output: "user_id is required for add/remove", isError: true };

    if (input.action === "add") {
      ctx.db.run(
        "INSERT OR IGNORE INTO allowed_users (channel, user_id, added_by) VALUES (?, ?, 'agent')",
        [input.channel, input.user_id]
      );
      return { output: `Added ${input.user_id} to ${input.channel} allowlist.` };
    }

    if (input.action === "remove") {
      ctx.db.run(
        "DELETE FROM allowed_users WHERE channel = ? AND user_id = ?",
        [input.channel, input.user_id]
      );
      return { output: `Removed ${input.user_id} from ${input.channel} allowlist.` };
    }

    return { output: `Unknown action: ${input.action}`, isError: true };
  },
};

export const readChatHistoryTool: Tool = {
  name: "read_chat_history",
  description: "Read recent messages from any chat by its ID. Use list_chats to find chat IDs. Useful for cross-referencing conversations or checking what was said in another chat.",
  parameters: {
    type: "object",
    properties: {
      chat_id: { type: "number", description: "Chat ID to read from" },
      limit: { type: "number", description: "Number of recent messages (default: 20)" },
    },
    required: ["chat_id"],
  },
  risk: "low",

  async execute(input: { chat_id: number; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
    const limit = input.limit || 20;
    const messages = getRecentMessages(ctx.db, input.chat_id, limit);
    if (messages.length === 0) return { output: "No messages found in that chat." };

    return {
      output: messages.map((m: any) => {
        const who = m.is_from_bot ? "Angel" : (m.sender_name || "User");
        return `[${m.timestamp}] ${who}: ${m.content?.slice(0, 500) || "[no content]"}`;
      }).join("\n"),
    };
  },
};

export const miscTools = [getCurrentTimeTool, todoTool, exportChatTool, calculateTool, listChatsTool, verifySafeWordTool, manageAllowedUsersTool, readChatHistoryTool];
