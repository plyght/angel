import type { Database } from "bun:sqlite";
import type { AngelConfig } from "../config";
import type { ToolRegistry } from "../tools/registry";
import type { ChannelRegistry } from "../channels/types";
import type { WebChannel } from "../channels/web";
import { handleApiRoute } from "./routes";
import { processMessage } from "../agent";
import { upsertChat } from "../db";
import { splitMessage } from "../channels/types";
import { readFileSync } from "fs";
import { join } from "path";

export function startWebServer(
  db: Database,
  config: AngelConfig,
  registry: ToolRegistry,
  channels: ChannelRegistry,
  webChannel: WebChannel
) {
  const webConfig = config.channels.web;
  const port = webConfig?.port || 3000;
  const host = webConfig?.host || "127.0.0.1";

  Bun.serve<{ chatId: string }>({
    port,
    hostname: host,

    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const chatId = url.searchParams.get("chatId") || "default";
        const ok = server.upgrade(req, { data: { chatId } });
        if (ok) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/api/")) {
        return handleApiRoute(req, url, db, config, registry, channels);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        try {
          const html = readFileSync(join(import.meta.dir, "../../ui/index.html"), "utf-8");
          return new Response(html, { headers: { "Content-Type": "text/html" } });
        } catch {
          return new Response("UI not found", { status: 404 });
        }
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws: any) {
        const chatId = ws.data?.chatId || "default";
        webChannel.registerSocket(chatId, ws);
      },

      async message(ws: any, message: string) {
        try {
          const data = JSON.parse(message);
          if (data.type === "message" && data.text) {
            const chatId = ws.data?.chatId || "default";
            const dbChatId = upsertChat(db, "web", chatId, "web_private");

            webChannel.sendToolEvent(chatId, "thinking", {});

            const response = await processMessage(data.text, {
              chatId: dbChatId,
              channel: "web",
              db,
              config,
              registry,
              onTextDelta: (delta) => webChannel.sendTextDelta(chatId, delta),
              onToolStart: (name, input) => webChannel.sendToolEvent(chatId, "tool_start", { name, input }),
              onToolResult: (name, result) => webChannel.sendToolEvent(chatId, "tool_result", { name, result: result.slice(0, 500) }),
            });

            ws.send(JSON.stringify({ type: "message_complete", text: response }));
          }
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
      },

      close(ws: any) {
        const chatId = ws.data?.chatId || "default";
        webChannel.unregisterSocket(chatId);
      },
    },
  });

  console.log(`[angel] Web UI: http://${host}:${port}`);
}
