import type { Tool, ToolContext, ToolResult } from "./registry";
import { getMemories, insertMemory, archiveMemory } from "../db";
import { writeAgentsMd } from "../memory";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

export const readMemoryTool: Tool = {
  name: "read_memory",
  description: "Read memories for the current chat. Returns stored facts, preferences, and knowledge.",
  parameters: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["chat", "global", "all"], description: "Memory scope (default: all)" },
      limit: { type: "number", description: "Max memories to return (default: 20)" },
    },
  },
  risk: "low",

  async execute(input: { scope?: string; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
    const limit = input.limit || 20;
    let memories: any[] = [];

    if (input.scope === "global") {
      memories = getMemories(ctx.db, null, limit);
    } else if (input.scope === "chat") {
      memories = ctx.db.query(
        "SELECT * FROM memories WHERE chat_id = ? AND is_archived = 0 ORDER BY updated_at DESC LIMIT ?"
      ).all(ctx.chatId, limit);
    } else {
      memories = getMemories(ctx.db, ctx.chatId, limit);
    }

    const agentsPath = join(ctx.config.data_dir, "AGENTS.md");
    let fileMemory = "";
    if (existsSync(agentsPath)) {
      fileMemory = readFileSync(agentsPath, "utf-8").trim();
    }

    let output = "";
    if (fileMemory) output += `[File Memory (AGENTS.md)]\n${fileMemory}\n\n`;
    if (memories.length > 0) {
      output += `[Structured Memories (${memories.length})]\n`;
      output += memories.map((m: any) =>
        `#${m.id} [${m.category}] ${m.content} (source: ${m.source}, confidence: ${m.confidence})`
      ).join("\n");
    }

    return { output: output || "No memories found." };
  },
};

export const writeMemoryTool: Tool = {
  name: "write_memory",
  description: "Store a fact or piece of knowledge in memory. Use for important information that should persist across conversations.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "The fact or knowledge to remember" },
      category: { type: "string", enum: ["profile", "knowledge", "event", "general"], description: "Memory category" },
      scope: { type: "string", enum: ["chat", "global"], description: "Where to store (default: chat)" },
      target: { type: "string", enum: ["db", "file"], description: "Storage target: db (structured) or file (AGENTS.md). Default: db" },
    },
    required: ["content"],
  },
  risk: "low",

  async execute(input: { content: string; category?: string; scope?: string; target?: string }, ctx: ToolContext): Promise<ToolResult> {
    if (input.content.length < 5) return { output: "Content too short", isError: true };

    if (input.target === "file") {
      writeAgentsMd(ctx.config, input.content, ctx.chatId, ctx.channel);
      return { output: "Written to AGENTS.md" };
    }

    const chatId = input.scope === "global" ? null : ctx.chatId;
    const id = insertMemory(ctx.db, chatId, input.content, input.category || "general", "agent");
    return { output: `Memory #${id} stored (${input.category || "general"})` };
  },
};

export const deleteMemoryTool: Tool = {
  name: "delete_memory",
  description: "Archive (soft-delete) a memory by ID.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "number", description: "Memory ID to archive" },
    },
    required: ["id"],
  },
  risk: "low",

  async execute(input: { id: number }, ctx: ToolContext): Promise<ToolResult> {
    archiveMemory(ctx.db, input.id);
    return { output: `Memory #${input.id} archived.` };
  },
};

export const searchMemoryTool: Tool = {
  name: "search_memory",
  description: "Search memories by keyword.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keywords" },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
    required: ["query"],
  },
  risk: "low",

  async execute(input: { query: string; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
    const limit = input.limit || 10;
    const keywords = input.query.toLowerCase().split(/\s+/);
    const all = getMemories(ctx.db, ctx.chatId, 100);

    const scored = all
      .map((m: any) => {
        const content = m.content.toLowerCase();
        const score = keywords.filter((k: string) => content.includes(k)).length / keywords.length;
        return { ...m, score };
      })
      .filter((m: any) => m.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, limit);

    if (scored.length === 0) return { output: "No matching memories." };

    return {
      output: scored.map((m: any) =>
        `#${m.id} [${m.category}] ${m.content} (relevance: ${(m.score * 100).toFixed(0)}%)`
      ).join("\n"),
    };
  },
};

export const updateMemoryTool: Tool = {
  name: "update_memory",
  description: "Update an existing memory's content, category, or confidence.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "number", description: "Memory ID to update" },
      content: { type: "string", description: "New content" },
      category: { type: "string", enum: ["profile", "knowledge", "event", "general"], description: "New category" },
      confidence: { type: "number", description: "New confidence (0-1)" },
    },
    required: ["id"],
  },
  risk: "low",

  async execute(input: { id: number; content?: string; category?: string; confidence?: number }, ctx: ToolContext): Promise<ToolResult> {
    const sets: string[] = [];
    const params: any[] = [];
    if (input.content) { sets.push("content = ?"); params.push(input.content); }
    if (input.category) { sets.push("category = ?"); params.push(input.category); }
    if (input.confidence !== undefined) { sets.push("confidence = ?"); params.push(input.confidence); }
    if (sets.length === 0) return { output: "Nothing to update", isError: true };
    sets.push("updated_at = datetime('now')");
    params.push(input.id);
    ctx.db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params);
    return { output: `Memory #${input.id} updated.` };
  },
};

export const memoryTools = [readMemoryTool, writeMemoryTool, deleteMemoryTool, searchMemoryTool, updateMemoryTool];
