import type { Database } from "bun:sqlite";
import type { AngelConfig } from "../config";
import type { ToolRegistry } from "../tools/registry";
import { upsertChat } from "../db";
import { processMessage } from "../agent";

export async function startAcpServer(
  db: Database,
  config: AngelConfig,
  registry: ToolRegistry
) {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  console.error("[angel] ACP: Listening on stdin");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        const response = await handleAcpRequest(request, db, config, registry);
        process.stdout.write(JSON.stringify(response) + "\n");
      } catch (err: any) {
        process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
      }
    }
  }
}

async function handleAcpRequest(
  request: any,
  db: Database,
  config: AngelConfig,
  registry: ToolRegistry
): Promise<any> {
  if (request.method === "process") {
    const chatId = upsertChat(db, "acp", request.chat_id || "acp_default", "acp");
    const result = await processMessage(request.message, {
      chatId,
      channel: "acp",
      db,
      config,
      registry,
    });
    return { id: request.id, result };
  }

  if (request.method === "tools") {
    return { id: request.id, tools: registry.listNames() };
  }

  return { id: request.id, error: "unknown method" };
}
