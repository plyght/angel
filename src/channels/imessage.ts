import type { ChildProcess } from "bun";
import type { ChannelAdapter, IncomingMessage, MessageHandler } from "./types";

type IMsgChat = {
  id: number;
  identifier?: string;
  name?: string;
};

type IMsgWatchMessage = {
  id?: number;
  chat_id?: number;
  sender?: string;
  is_from_me?: boolean;
  text?: string;
};

function normalizeService(service?: string): "imessage" | "sms" | "auto" {
  const normalized = (service || "auto").toLowerCase();
  if (normalized === "imessage") return "imessage";
  if (normalized === "sms") return "sms";
  if (normalized === "auto") return "auto";
  // Back-compat with existing setup values.
  if (service === "iMessage") return "imessage";
  if (service === "SMS") return "sms";
  return "auto";
}

export class iMessageChannel implements ChannelAdapter {
  name = "imessage";
  maxMessageLength = 100000;

  private handler: MessageHandler | null = null;
  private watchProcess: ChildProcess | null = null;
  private readonly imsgPath: string;
  private readonly service: "imessage" | "sms" | "auto";
  private readonly region: string;
  private readonly chatsById = new Map<number, IMsgChat>();
  private readonly allowedHandles: Set<string>;

  constructor(
    imsgPath = "imsg",
    service?: string,
    region = "US",
    allowedHandles?: string[],
  ) {
    this.imsgPath = imsgPath;
    this.service = normalizeService(service);
    this.region = region;
    this.allowedHandles = new Set(allowedHandles ?? []);
  }

  async start(onMessage: MessageHandler) {
    this.handler = onMessage;

    const available = await this.checkIMsgAvailable();
    if (!available) {
      console.error(
        `[angel] iMessage: imsg not found at '${this.imsgPath}'. Install it or set channels.imessage.imsg_path.`,
      );
      return;
    }

    await this.refreshChats();
    this.startWatchProcess();
  }

  async stop() {
    this.watchProcess?.kill();
    this.watchProcess = null;
  }

  private async checkIMsgAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn([this.imsgPath, "--help"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  private async refreshChats() {
    try {
      const proc = Bun.spawn(
        [this.imsgPath, "chats", "--json", "--limit", "500"],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const raw = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      if (!raw) return;

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as IMsgChat;
          if (typeof parsed.id === "number") {
            this.chatsById.set(parsed.id, parsed);
          }
        } catch {
          // Ignore malformed lines.
        }
      }
    } catch (err: any) {
      console.error(
        `[angel] iMessage: Failed to refresh chats: ${err.message}`,
      );
    }
  }

  private startWatchProcess() {
    this.watchProcess?.kill();

    this.watchProcess = Bun.spawn(
      [this.imsgPath, "watch", "--json", "--debounce", "250ms"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    this.readWatchStdout().catch((err: any) => {
      console.error(`[angel] iMessage watch read error: ${err.message}`);
    });

    this.readWatchStderr().catch(() => {});

    this.watchProcess.exited.then((code) => {
      console.error(`[angel] iMessage watch exited with code ${code}`);
    });

    console.log("[angel] iMessage: imsg watch started");
  }

  private async readWatchStdout() {
    if (!this.watchProcess?.stdout) return;

    const reader = this.watchProcess.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        await this.handleWatchLine(line);
      }
    }
  }

  private async readWatchStderr() {
    if (!this.watchProcess?.stderr) return;
    const stderr = await new Response(this.watchProcess.stderr).text();
    if (stderr.trim()) {
      console.error(`[angel] iMessage watch stderr: ${stderr.trim()}`);
    }
  }

  private async handleWatchLine(line: string) {
    if (!this.handler) return;

    let parsed: IMsgWatchMessage;
    try {
      parsed = JSON.parse(line) as IMsgWatchMessage;
    } catch {
      return;
    }

    if (parsed.is_from_me) return;
    if (typeof parsed.chat_id !== "number") return;

    const chat = this.chatsById.get(parsed.chat_id);
    if (!chat) {
      await this.refreshChats();
    }

    const refreshedChat = this.chatsById.get(parsed.chat_id);
    const externalChatId = refreshedChat?.identifier || String(parsed.chat_id);
    const isGroup = externalChatId.startsWith("chat");
    const text = parsed.text?.trim() || "";

    if (!text) return;

    if (isGroup && !/\bangel\b/i.test(text)) {
      return;
    }

    const sender = parsed.sender || "Unknown";

    // Optional hard allowlist: block any sender not explicitly listed.
    // Mirrors Signal's channel-specific sender gate behavior.
    if (this.allowedHandles.size > 0 && !this.allowedHandles.has(sender)) {
      console.log(
        `[angel] iMessage: blocked message from unauthorized handle ${sender}`,
      );
      return;
    }

    const msg: IncomingMessage = {
      externalChatId,
      chatType: isGroup ? "imessage_group" : "imessage_private",
      senderName: sender,
      text,
      isGroupMention: isGroup,
      senderDmId: !isGroup ? sender : undefined,
    };

    try {
      await this.handler(msg);
    } catch (err: any) {
      console.error(`[angel] iMessage handler error: ${err.message}`);
    }
  }

  async sendText(externalChatId: string, text: string) {
    try {
      const args = [
        "send",
        "--to",
        externalChatId,
        "--text",
        text,
        "--service",
        this.service,
        "--region",
        this.region,
      ];

      const proc = Bun.spawn([this.imsgPath, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = (await new Response(proc.stderr).text()).trim();
        console.error(
          `[angel] iMessage send error (code ${code}): ${stderr || "unknown error"}`,
        );
      }
    } catch (err: any) {
      console.error(`[angel] iMessage send error: ${err.message}`);
    }
  }

  async sendAttachment(
    externalChatId: string,
    filePath: string,
    caption?: string,
  ) {
    try {
      const args = [
        "send",
        "--to",
        externalChatId,
        "--file",
        filePath,
        "--service",
        this.service,
        "--region",
        this.region,
      ];
      if (caption?.trim()) {
        args.push("--text", caption);
      }

      const proc = Bun.spawn([this.imsgPath, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = (await new Response(proc.stderr).text()).trim();
        console.error(
          `[angel] iMessage send attachment error (code ${code}): ${stderr || "unknown error"}`,
        );
      }
    } catch (err: any) {
      console.error(`[angel] iMessage send attachment error: ${err.message}`);
    }
  }
}
