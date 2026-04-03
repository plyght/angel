import type { Tool, ToolContext, ToolResult } from "./registry";

export const emitMessageTool: Tool = {
  name: "emit_message",
  description:
    "Send a message immediately to the current chat and continue working. Use this for mid-task updates when you have partial results or status to share before completing the full task. Unlike a final response, this sends instantly and lets you keep using tools.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Message text to send immediately",
      },
    },
    required: ["text"],
  },
  risk: "low",

  async execute(
    input: { text: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!ctx.sendIntermediate) {
      return {
        output: "Intermediate messaging not available in this context",
        isError: true,
      };
    }

    try {
      await ctx.sendIntermediate(input.text);
      return { output: "Message sent" };
    } catch (err: any) {
      return { output: `Failed to send: ${err.message}`, isError: true };
    }
  },
};
