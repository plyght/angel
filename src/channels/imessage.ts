import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ChannelAdapter, IncomingMessage, MessageHandler } from "./types";

const MESSAGES_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const POLL_INTERVAL = 2000;

export class iMessageChannel implements ChannelAdapter {
  name = "imessage";
  maxMessageLength = 100000;
  private handler: MessageHandler | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRowId = 0;
  private messagesDb: Database | null = null;

  async start(onMessage: MessageHandler) {
    this.handler = onMessage;

    if (!existsSync(MESSAGES_DB_PATH)) {
      console.error(
        "[angel] iMessage: Messages database not found. Ensure Full Disk Access is granted.",
      );
      return;
    }

    try {
      this.messagesDb = new Database(MESSAGES_DB_PATH, { readonly: true });
      const latest = this.messagesDb
        .query("SELECT MAX(ROWID) as max_id FROM message")
        .get() as any;
      this.lastRowId = latest?.max_id || 0;

      this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL);
      console.log("[angel] iMessage: Polling started");
    } catch (err: any) {
      console.error(
        `[angel] iMessage: Failed to open database: ${err.message}`,
      );
    }
  }

  async stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.messagesDb?.close();
  }

  private async poll() {
    if (!this.messagesDb || !this.handler) return;

    try {
      const rows = this.messagesDb
        .query(`
        SELECT m.ROWID, m.text, m.is_from_me, m.date,
               c.chat_identifier, c.display_name,
               h.id as sender_id
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.text IS NOT NULL
        ORDER BY m.ROWID ASC
        LIMIT 10
      `)
        .all(this.lastRowId) as any[];

      for (const row of rows) {
        const isGroup = row.chat_identifier.startsWith("chat");
        if (isGroup && !/\bangel\b/i.test(row.text)) {
          this.lastRowId = row.ROWID;
          continue;
        }

        const msg: IncomingMessage = {
          externalChatId: row.chat_identifier,
          chatType: isGroup ? "imessage_group" : "imessage_private",
          senderName: row.sender_id || "Unknown",
          text: row.text,
          isGroupMention: isGroup,
        };

        try {
          await this.handler(msg);
          this.lastRowId = row.ROWID;
        } catch (err: any) {
          console.error(`[angel] iMessage handler error: ${err.message}`);
          this.lastRowId = row.ROWID;
        }
      }
    } catch (err: any) {
      console.error(`[angel] iMessage poll error: ${err.message}`);
    }
  }

  async sendText(externalChatId: string, text: string) {
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const isGroup = externalChatId.startsWith("chat");

    let script: string;
    if (isGroup) {
      script = `
        tell application "Messages"
          set targetChat to a reference to chat id "${externalChatId}"
          send "${escaped}" to targetChat
        end tell
      `;
    } else {
      script = `
        tell application "Messages"
          set targetService to 1st account whose service type = iMessage
          set targetBuddy to participant "${externalChatId}" of targetService
          send "${escaped}" to targetBuddy
        end tell
      `;
    }

    try {
      const proc = Bun.spawn(["osascript", "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
    } catch (err: any) {
      console.error(`[angel] iMessage send error: ${err.message}`);
    }
  }
}
