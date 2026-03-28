import type { ChannelAdapter, MessageHandler, IncomingMessage } from "./types";

export class WebChannel implements ChannelAdapter {
  name = "web";
  maxMessageLength = 100000;
  private handler: MessageHandler | null = null;
  private sockets: Map<string, any> = new Map();

  async start(onMessage: MessageHandler) {
    this.handler = onMessage;
  }

  registerSocket(chatId: string, ws: any) {
    this.sockets.set(chatId, ws);
  }

  unregisterSocket(chatId: string) {
    this.sockets.delete(chatId);
  }

  async handleIncoming(chatId: string, text: string, senderName = "User") {
    if (!this.handler) return;
    const msg: IncomingMessage = {
      externalChatId: chatId,
      chatType: "web_private",
      senderName,
      text,
    };
    await this.handler(msg);
  }

  async sendText(externalChatId: string, text: string) {
    const ws = this.sockets.get(externalChatId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "message", text }));
    }
  }

  sendTextDelta(externalChatId: string, delta: string) {
    const ws = this.sockets.get(externalChatId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "text_delta", delta }));
    }
  }

  sendToolEvent(externalChatId: string, event: string, data: any) {
    const ws = this.sockets.get(externalChatId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: event, ...data }));
    }
  }

  async sendTyping(externalChatId: string) {
    const ws = this.sockets.get(externalChatId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "typing" }));
    }
  }
}
