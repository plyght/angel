import { Client, GatewayIntentBits, type Message } from "discord.js";
import type { ChannelAdapter, IncomingMessage, MessageHandler } from "./types";

export class DiscordChannel implements ChannelAdapter {
  name = "discord";
  maxMessageLength = 2000;
  private client: Client | null = null;
  private handler: MessageHandler | null = null;
  private token: string;

  constructor(token: string, botUsername?: string) {
    this.token = token;
    this.botUsername = botUsername || "angel";
  }

  async start(onMessage: MessageHandler) {
    this.handler = onMessage;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on("messageCreate", async (msg: Message) => {
      if (msg.author.bot) return;
      if (!this.handler) return;

      const isDM = !msg.guild;
      const isMentioned = msg.mentions.has(this.client!.user!);

      if (!isDM && !isMentioned) return;

      let text = msg.content;
      if (isMentioned) {
        text = text.replace(/<@!?\d+>/g, "").trim();
      }
      if (!text) return;

      const incoming: IncomingMessage = {
        externalChatId: msg.channel.id,
        chatType: isDM ? "discord_dm" : "discord_guild",
        senderName: msg.author.displayName || msg.author.username,
        text,
        isGroupMention: !isDM && isMentioned,
        senderDmId: msg.author.id,
      };

      this.handler(incoming).catch((err) =>
        console.error(`[angel] Discord handler error: ${err.message}`),
      );
    });

    this.client.on("ready", () => {
      console.log(`[angel] Discord: Logged in as ${this.client!.user!.tag}`);
    });

    await this.client.login(this.token);
  }

  async stop() {
    await this.client?.destroy();
  }

  async sendText(externalChatId: string, text: string) {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(externalChatId);
      if (channel && "send" in channel) {
        await (channel as any).send(text);
      }
    } catch (err: any) {
      console.error(`[angel] Discord send error: ${err.message}`);
    }
  }

  async sendTyping(externalChatId: string) {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(externalChatId);
      if (channel && "sendTyping" in channel) {
        await (channel as any).sendTyping();
      }
    } catch {}
  }
}
