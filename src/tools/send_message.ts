import type { Tool, ToolContext, ToolResult } from "./registry";

let channelRegistryRef: any = null;
let dbRef: any = null;

export function setSendMessageDeps(channelRegistry: any, db: any) {
  channelRegistryRef = channelRegistry;
  dbRef = db;
}

export const sendMessageTool: Tool = {
  name: "send_message",
  description: "Send a message to a specific chat. Use for proactive updates, cross-chat messaging, or intermediate responses.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel name (e.g., 'discord', 'slack', 'imessage', 'signal', 'web')" },
      chat_id: { type: "string", description: "External chat ID for the target channel" },
      text: { type: "string", description: "Message text to send" },
    },
    required: ["text"],
  },
  risk: "medium",

  async execute(input: { channel?: string; chat_id?: string; text: string }, ctx: ToolContext): Promise<ToolResult> {
    if (!channelRegistryRef) return { output: "Channel registry not available", isError: true };

    const targetChannel = input.channel || ctx.channel;
    const adapter = channelRegistryRef.get(targetChannel);
    if (!adapter) return { output: `Channel not found: ${targetChannel}`, isError: true };

    let externalChatId = input.chat_id;
    if (!externalChatId) {
      const chatRow = dbRef?.query("SELECT external_chat_id FROM chats WHERE id = ?").get(ctx.chatId) as any;
      externalChatId = chatRow?.external_chat_id;
    }
    if (!externalChatId) return { output: "No target chat ID", isError: true };

    try {
      await adapter.sendText(externalChatId, input.text);
      return { output: `Message sent to ${targetChannel}:${externalChatId}` };
    } catch (err: any) {
      return { output: `Send error: ${err.message}`, isError: true };
    }
  },
};
