export interface IncomingMessage {
  externalChatId: string;
  chatType: string;
  senderName: string;
  text: string;
  imageBase64?: string;
  imageMimeType?: string;
  audioTranscription?: string;
  isGroupMention?: boolean;
  senderDmId?: string;
  replyToMessageId?: string;
  /** True if this message represents a reaction event rather than a text message */
  isReaction?: boolean;
  /** The emoji used in the reaction (when isReaction is true) */
  reactionEmoji?: string;
  /** True if this is a reaction removal rather than addition */
  reactionIsRemoval?: boolean;
  /** True if the reaction is on Angel's own message */
  reactionToSelf?: boolean;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface ChannelAdapter {
  name: string;
  start(onMessage: MessageHandler): Promise<void>;
  stop?(): Promise<void>;
  sendText(externalChatId: string, text: string): Promise<void>;
  sendTyping?(externalChatId: string): Promise<void>;
  sendAttachment?(externalChatId: string, filePath: string, caption?: string): Promise<void>;
  maxMessageLength?: number;
}

export class ChannelRegistry {
  private adapters: Map<string, ChannelAdapter> = new Map();

  register(adapter: ChannelAdapter) {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): ChannelAdapter | undefined {
    return this.adapters.get(name);
  }

  all(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  async startAll(handler: MessageHandler) {
    const startPromises = this.all().map(async (adapter) => {
      try {
        await adapter.start(handler);
        console.log(`[angel] Channel started: ${adapter.name}`);
      } catch (err: any) {
        console.error(`[angel] Failed to start channel ${adapter.name}: ${err.message}`);
      }
    });
    await Promise.all(startPromises);
  }

  async stopAll() {
    for (const adapter of this.all()) {
      try {
        await adapter.stop?.();
      } catch {}
    }
  }
}

export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
