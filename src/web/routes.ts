import type { Database } from "bun:sqlite";
import type { AngelConfig } from "../config";
import type { ToolRegistry } from "../tools/registry";
import type { ChannelRegistry } from "../channels/types";
import { getRecentMessages, getUsageStats, getMemories } from "../db";

export async function handleApiRoute(
  req: Request,
  url: URL,
  db: Database,
  config: AngelConfig,
  registry: ToolRegistry,
  channels: ChannelRegistry
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (path === "/api/chats" && method === "GET") {
      const chats = db.query("SELECT * FROM chats ORDER BY created_at DESC LIMIT 50").all();
      return json(chats, corsHeaders);
    }

    const chatMatch = path.match(/^\/api\/chats\/(\d+)\/messages$/);
    if (chatMatch && method === "GET") {
      const chatId = parseInt(chatMatch[1]);
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const messages = getRecentMessages(db, chatId, limit);
      return json(messages, corsHeaders);
    }

    if (path === "/api/usage" && method === "GET") {
      const days = parseInt(url.searchParams.get("days") || "30");
      const stats = getUsageStats(db, days);
      return json(stats, corsHeaders);
    }

    if (path === "/api/memories" && method === "GET") {
      const chatId = url.searchParams.get("chat_id");
      const memories = getMemories(db, chatId ? parseInt(chatId) : null, 50);
      return json(memories, corsHeaders);
    }

    if (path === "/api/tasks" && method === "GET") {
      const tasks = db.query("SELECT * FROM scheduled_tasks ORDER BY created_at DESC LIMIT 50").all();
      return json(tasks, corsHeaders);
    }

    if (path === "/api/config" && method === "GET") {
      const safe = { ...config, openai_api_key: config.openai_api_key ? "***" : "" };
      return json(safe, corsHeaders);
    }

    if (path === "/api/tools" && method === "GET") {
      return json(registry.listNames(), corsHeaders);
    }

    if (path === "/api/health" && method === "GET") {
      return json({ status: "ok", tools: registry.count(), channels: channels.all().length }, corsHeaders);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}

function json(data: any, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
