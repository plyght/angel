import type { Database } from "bun:sqlite";
import type { AngelConfig } from "./config";
import { getMemories, getUsageStats } from "./db";

export interface CommandResult {
  text: string;
  handled: boolean;
}

export function handleCommand(text: string, chatId: number, db: Database, config: AngelConfig): CommandResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { text: "", handled: false };

  const [cmd, ...args] = trimmed.split(/\s+/);
  const arg = args.join(" ");

  switch (cmd) {
    case "/help":
      return {
        handled: true,
        text: `Available commands:
/help — Show this help
/new — Start a new chat session
/model [name] — Show or change current model
/memory — Show stored memories
/usage — Show token usage stats
/settings — Show current settings
/clear — Clear session history
/version — Show version`,
      };

    case "/model":
      if (arg) {
        db.run(
          "INSERT INTO sessions (chat_id, model_override, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET model_override = excluded.model_override",
          [chatId, arg]
        );
        return { handled: true, text: `Model set to: ${arg}` };
      }
      const session = db.query("SELECT model_override FROM sessions WHERE chat_id = ?").get(chatId) as any;
      return { handled: true, text: `Current model: ${session?.model_override || config.model}` };

    case "/memory":
      const memories = getMemories(db, chatId, 20);
      if (memories.length === 0) return { handled: true, text: "No memories stored." };
      return {
        handled: true,
        text: memories.map((m: any) => `#${m.id} [${m.category}] ${m.content}`).join("\n"),
      };

    case "/usage":
      const stats = getUsageStats(db);
      if (stats.length === 0) return { handled: true, text: "No usage data." };
      return {
        handled: true,
        text: stats.map((s: any) =>
          `${s.model}: ${s.calls} calls, ${s.total_input} input tokens, ${s.total_output} output tokens`
        ).join("\n"),
      };

    case "/new":
      db.run("DELETE FROM messages WHERE chat_id = ?", [chatId]);
      db.run("DELETE FROM sessions WHERE chat_id = ?", [chatId]);
      return { handled: true, text: "New chat started." };

    case "/settings":
      const enabledChannels = Object.entries(config.channels)
        .filter(([_, v]: [string, any]) => v?.enabled !== false)
        .map(([k]) => k);
      return {
        handled: true,
        text: `Model: ${config.model}
Max tokens: ${config.max_tokens}
Max tool iterations: ${config.max_tool_iterations}
History messages: ${config.max_history_messages}
Timezone: ${config.timezone}
Channels: ${enabledChannels.join(", ")}`,
      };

    case "/clear":
      db.run("DELETE FROM sessions WHERE chat_id = ?", [chatId]);
      return { handled: true, text: "Session cleared." };

    case "/version":
      return { handled: true, text: "Angel v0.1.0" };

    default:
      return { text: "", handled: false };
  }
}
