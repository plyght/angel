import type { Tool, ToolContext, ToolResult } from "./registry";

export const requestConfirmationTool: Tool = {
  name: "request_confirmation",
  description: "Request safe word confirmation for a dangerous action. Creates a pending confirmation and DMs the user. Use this in GROUP chats when a dangerous action needs the safe word — it stores the action so the DM chat can verify and execute it.",
  parameters: {
    type: "object",
    properties: {
      dm_id: { type: "string", description: "The user's DM-able ID (phone number, username, etc.)" },
      action_description: { type: "string", description: "Human-readable description of what will happen" },
      tool_name: { type: "string", description: "The tool to execute once confirmed" },
      tool_input: { type: "string", description: "JSON string of the tool input to execute once confirmed" },
    },
    required: ["dm_id", "action_description", "tool_name", "tool_input"],
  },
  risk: "medium",

  async execute(input: { dm_id: string; action_description: string; tool_name: string; tool_input: string }, ctx: ToolContext): Promise<ToolResult> {
    ctx.db.run(
      `INSERT INTO pending_confirmations (origin_chat_id, channel, dm_id, action_description, tool_name, tool_input)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [ctx.chatId, ctx.channel, input.dm_id, input.action_description, input.tool_name, input.tool_input]
    );
    const row = ctx.db.query("SELECT last_insert_rowid() as id").get() as { id: number };
    return { output: `Confirmation #${row.id} created. Now DM the user at ${input.dm_id} asking for the safe word and referencing confirmation #${row.id}.` };
  },
};

export const checkPendingConfirmationsTool: Tool = {
  name: "check_pending_confirmations",
  description: "Check pending confirmations waiting for this user's safe word. Use in DM chats when a user may be responding to a safe word request.",
  parameters: {
    type: "object",
    properties: {
      dm_id: { type: "string", description: "The user's DM ID to check for" },
    },
    required: ["dm_id"],
  },
  risk: "low",

  async execute(input: { dm_id: string }, ctx: ToolContext): Promise<ToolResult> {
    const rows = ctx.db.query(
      "SELECT id, origin_chat_id, channel, action_description, tool_name, created_at FROM pending_confirmations WHERE dm_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 10"
    ).all(input.dm_id) as any[];

    if (rows.length === 0) return { output: "No pending confirmations." };

    return {
      output: rows.map((r: any) =>
        `#${r.id} [${r.channel}] "${r.action_description}" (from chat ${r.origin_chat_id}, tool: ${r.tool_name}, created: ${r.created_at})`
      ).join("\n"),
    };
  },
};

export const approveConfirmationTool: Tool = {
  name: "approve_confirmation",
  description: "Approve a pending confirmation by providing the safe word. The safe word is verified server-side before executing the action.",
  parameters: {
    type: "object",
    properties: {
      confirmation_id: { type: "number", description: "The confirmation ID to approve" },
      safe_word: { type: "string", description: "The safe word provided by the user" },
    },
    required: ["confirmation_id", "safe_word"],
  },
  risk: "high",

  async execute(input: { confirmation_id: number; safe_word: string }, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.config.safe_word) return { output: "No safe word configured.", isError: true };
    if (input.safe_word.trim().toLowerCase() !== ctx.config.safe_word.trim().toLowerCase()) {
      return { output: "Incorrect safe word. Action not approved.", isError: true };
    }

    const row = ctx.db.query(
      "SELECT * FROM pending_confirmations WHERE id = ? AND status = 'pending'"
    ).get(input.confirmation_id) as any;

    if (!row) return { output: "Confirmation not found or already resolved.", isError: true };

    ctx.db.run(
      "UPDATE pending_confirmations SET status = 'approved', resolved_at = datetime('now') WHERE id = ?",
      [input.confirmation_id]
    );

    const toolInput = JSON.parse(row.tool_input);
    const originCtx: ToolContext = {
      chatId: row.origin_chat_id,
      channel: row.channel,
      workingDir: ctx.workingDir,
      db: ctx.db,
      config: ctx.config,
      registry: ctx.registry,
    };

    const result = await ctx.registry!.execute(row.tool_name, toolInput, originCtx);
    return { output: `Confirmed and executed. Result:\n${result.output}` };
  },
};

export const denyConfirmationTool: Tool = {
  name: "deny_confirmation",
  description: "Deny/cancel a pending confirmation.",
  parameters: {
    type: "object",
    properties: {
      confirmation_id: { type: "number", description: "The confirmation ID to deny" },
    },
    required: ["confirmation_id"],
  },
  risk: "low",

  async execute(input: { confirmation_id: number }, ctx: ToolContext): Promise<ToolResult> {
    ctx.db.run(
      "UPDATE pending_confirmations SET status = 'denied', resolved_at = datetime('now') WHERE id = ?",
      [input.confirmation_id]
    );
    return { output: `Confirmation #${input.confirmation_id} denied.` };
  },
};

export const confirmationTools = [requestConfirmationTool, checkPendingConfirmationsTool, approveConfirmationTool, denyConfirmationTool];
