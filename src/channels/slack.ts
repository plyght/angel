import type { ChannelAdapter, IncomingMessage, MessageHandler } from "./types";

export class SlackChannel implements ChannelAdapter {
  name = "slack";
  maxMessageLength = 40000;
  private handler: MessageHandler | null = null;
  private app: any = null;
  private botToken: string;
  private appToken: string;

  constructor(botToken: string, appToken: string) {
    this.botToken = botToken;
    this.appToken = appToken;
  }

  async start(onMessage: MessageHandler) {
    this.handler = onMessage;

    const { App } = await import("@slack/bolt");
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    });

    const auth = await this.app.client.auth.test({ token: this.botToken });
    this.botUserId = auth.user_id || "";

    this.app.event("app_mention", async ({ event }: any) => {
      if (!this.handler) return;
      const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!text) return;

      const incoming: IncomingMessage = {
        externalChatId: event.channel,
        chatType: "slack_channel",
        senderName: event.user,
        text,
        isGroupMention: true,
      };

      this.handler(incoming).catch((err) =>
        console.error(`[angel] Slack handler error: ${err.message}`),
      );
    });

    this.app.event("message", async ({ event }: any) => {
      if (!this.handler) return;
      if (event.channel_type !== "im") return;
      if (event.bot_id || event.subtype) return;

      const incoming: IncomingMessage = {
        externalChatId: event.channel,
        chatType: "slack_dm",
        senderName: event.user,
        text: event.text || "",
      };

      this.handler(incoming).catch((err) =>
        console.error(`[angel] Slack handler error: ${err.message}`),
      );
    });

    await this.app.start();
    console.log(`[angel] Slack: Connected in socket mode`);
  }

  async stop() {
    await this.app?.stop();
  }

  async sendText(externalChatId: string, text: string) {
    if (!this.app) return;
    try {
      await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: externalChatId,
        text,
      });
    } catch (err: any) {
      console.error(`[angel] Slack send error: ${err.message}`);
    }
  }

  async sendTyping(_externalChatId: string) {}
}
