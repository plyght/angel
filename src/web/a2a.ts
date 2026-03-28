import type { Database } from "bun:sqlite";
import type { AngelConfig } from "../config";
import type { ToolRegistry } from "../tools/registry";
import { upsertChat } from "../db";
import { processMessage } from "../agent";

export async function handleA2aRequest(
  req: Request,
  db: Database,
  config: AngelConfig,
  registry: ToolRegistry
): Promise<Response> {
  const auth = req.headers.get("Authorization");
  const body = await req.json();

  const { channel, chat_id, message } = body;
  if (!message) {
    return new Response(JSON.stringify({ error: "message required" }), { status: 400 });
  }

  const ch = channel || "a2a";
  const externalId = chat_id || "a2a_default";
  const dbChatId = upsertChat(db, ch, externalId, "a2a");

  const result = await processMessage(message, {
    chatId: dbChatId,
    channel: ch,
    db,
    config,
    registry,
  });

  return new Response(JSON.stringify({ response: result }), {
    headers: { "Content-Type": "application/json" },
  });
}
