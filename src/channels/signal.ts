import type { ChannelAdapter, MessageHandler, IncomingMessage } from "./types";

export class SignalChannel implements ChannelAdapter {
  name = "signal";
  maxMessageLength = 6000;
  private handler: MessageHandler | null = null;
  private account: string;
  private cliPath: string;
  private process: any = null;

  constructor(account: string, cliPath = "signal-cli") {
    this.account = account;
    this.cliPath = cliPath;
  }

  async start(onMessage: MessageHandler) {
    this.handler = onMessage;

    this.process = Bun.spawn(
      [this.cliPath, "-a", this.account, "jsonRpc"],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
      }
    );

    this.readLoop();
    console.log(`[angel] Signal: JSON-RPC started for ${this.account}`);
  }

  private async readLoop() {
    if (!this.process?.stdout) return;
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.handleJsonRpc(msg);
          } catch {}
        }
      }
    } catch {}
  }

  private handleJsonRpc(msg: any) {
    if (!this.handler) return;
    if (msg.method !== "receive") return;

    const envelope = msg.params?.envelope;
    if (!envelope?.dataMessage?.message) return;

    const sender = envelope.sourceName || envelope.sourceNumber || "Unknown";
    const text = envelope.dataMessage.message;
    const groupId = envelope.dataMessage.groupInfo?.groupId;

    const incoming: IncomingMessage = {
      externalChatId: groupId || envelope.sourceNumber || "",
      chatType: groupId ? "signal_group" : "signal_private",
      senderName: sender,
      text,
      isGroupMention: !!groupId,
    };

    this.handler(incoming).catch((err) =>
      console.error(`[angel] Signal handler error: ${err.message}`)
    );
  }

  async stop() {
    this.process?.kill();
  }

  async sendText(externalChatId: string, text: string) {
    if (!this.process?.stdin) return;

    const isGroup = externalChatId.length > 20;
    const request = {
      jsonrpc: "2.0",
      method: "send",
      id: crypto.randomUUID(),
      params: isGroup
        ? { message: text, groupId: externalChatId }
        : { message: text, recipient: [externalChatId] },
    };

    const writer = this.process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(request) + "\n"));
    writer.releaseLock();
  }
}
