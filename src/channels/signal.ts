import type { ChannelAdapter, MessageHandler, IncomingMessage } from "./types";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import OpenAI, { toFile } from "openai";

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

  private async handleJsonRpc(msg: any) {
    if (!this.handler) return;
    if (msg.method !== "receive") return;

    const envelope = msg.params?.envelope;
    if (!envelope?.dataMessage) return;
    if (envelope.dataMessage.attachments?.length) {
      console.log(`[angel] Signal attachments raw:`, JSON.stringify(envelope.dataMessage.attachments));
    }

    const dataMsg = envelope.dataMessage;
    if (!dataMsg.message && !dataMsg.attachments?.length) return;

    const sender = envelope.sourceName || envelope.sourceNumber || "Unknown";
    const text = dataMsg.message || "";
    const groupId = dataMsg.groupInfo?.groupId;

    const incoming: IncomingMessage = {
      externalChatId: groupId || envelope.sourceNumber || "",
      chatType: groupId ? "signal_group" : "signal_private",
      senderName: sender,
      text: text || (dataMsg.attachments?.length ? "[image]" : ""),
      isGroupMention: !!groupId,
    };

    const attachments = dataMsg.attachments || [];
    const imageAttachment = attachments.find((a: any) => a.contentType?.startsWith("image/"));
    if (imageAttachment) {
      const attDir = join(homedir(), ".local", "share", "signal-cli", "attachments");
      const attId = imageAttachment.id || imageAttachment.filename;
      if (attId) {
        const attPath = join(attDir, attId);
        console.log(`[angel] Signal attachment: ${attPath} exists=${existsSync(attPath)}`);
        if (existsSync(attPath)) {
          incoming.imageBase64 = readFileSync(attPath).toString("base64");
          incoming.imageMimeType = imageAttachment.contentType;
        }
      }
    }

    const audioAttachment = attachments.find((a: any) => a.contentType?.startsWith("audio/"));
    if (audioAttachment) {
      const attDir = join(homedir(), ".local", "share", "signal-cli", "attachments");
      const attId = audioAttachment.id || audioAttachment.filename;
      if (attId) {
        const attPath = join(attDir, attId);
        if (existsSync(attPath)) {
          try {
            const client = new OpenAI();
            const audioBuffer = readFileSync(attPath);
            const file = await toFile(audioBuffer, audioAttachment.filename || "voice.m4a");
            const transcription = await client.audio.transcriptions.create({
              model: "whisper-1",
              file,
            });
            incoming.audioTranscription = transcription.text;
            if (!incoming.text || incoming.text === "[image]") {
              incoming.text = `[voice message]: ${transcription.text}`;
            } else {
              incoming.text = `${incoming.text}\n\n[voice message]: ${transcription.text}`;
            }
            console.log(`[angel] Transcribed voice note: ${transcription.text}`);
          } catch (err: any) {
            console.error(`[angel] Voice transcription error: ${err.message}`);
          }
        }
      }
    }

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

    this.process.stdin.write(JSON.stringify(request) + "\n");
    this.process.stdin.flush();
  }
}
