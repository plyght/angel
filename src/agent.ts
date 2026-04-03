import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AngelConfig } from "./config";
import { loadSession, logUsage, saveSession, storeMessage } from "./db";
import { runHook } from "./hooks";
import { chatComplete, type LlmMessage } from "./llm";
import { buildMemoryContext } from "./memory";
import type { ToolContext, ToolRegistry } from "./tools/registry";

export interface AgentOptions {
  chatId: number;
  channel: string;
  db: Database;
  config: AngelConfig;
  registry: ToolRegistry;
  onTextDelta?: (delta: string) => void;
  onToolStart?: (name: string, input: any) => void;
  onToolResult?: (name: string, result: string) => void;
  sendIntermediate?: (text: string) => Promise<void>;
  isOnboarding?: boolean;
  signal?: AbortSignal;
  usedSendMessage?: { value: boolean };
  senderName?: string;
  senderDmId?: string;
}

export const INTERRUPTED = Symbol("interrupted");

export async function processMessage(
  userMessage: string,
  opts: AgentOptions,
  image?: { base64: string; mimeType: string },
): Promise<string | typeof INTERRUPTED> {
  const { chatId, channel, db, config, registry } = opts;
  const senderDmId = opts.senderDmId;

  const sessionJson = loadSession(db, chatId);
  let messages: LlmMessage[] = sessionJson ? JSON.parse(sessionJson) : [];

  let systemPrompt = buildSystemPrompt(
    config,
    chatId,
    channel,
    db,
    registry,
    senderDmId,
  );

  if (opts.isOnboarding) {
    systemPrompt += `\n\n<onboarding>
This is a new user you haven't met before. Get to know them naturally in conversation. Over the course of one or a few messages, learn:
- Their name and what they like to be called
- What they do (work, school, interests)
- What they'd like you to help them with
- How they'd like to communicate (casual, formal, etc.)
- Their timezone if not already known

Be warm and conversational, not like a form. Ask 2-3 questions at a time max. Use the store_memory tool with category "profile" to save what you learn. Once you have a good picture, tell them you're all set and they can ask you anything.
</onboarding>`;
  }

  if (image) {
    messages.push({
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
        },
        { type: "text", text: userMessage || "What's in this image?" },
      ] as any,
    });
  } else {
    messages.push({ role: "user", content: userMessage });
  }

  if (messages.length > config.compaction_threshold) {
    messages = await compactMessages(messages, config);
  }

  const tools = registry.getDefinitions();
  let iterations = 0;
  const loopFingerprints: string[] = [];
  let finalText = "";

  while (iterations < config.max_tool_iterations) {
    if (opts.signal?.aborted) {
      saveSession(db, chatId, JSON.stringify(messages));
      return INTERRUPTED;
    }

    const hookResult = await runHook("before_llm", { messages, tools }, config);
    if (hookResult?.action === "block") {
      finalText = hookResult.reason || "Request blocked by hook.";
      break;
    }

    const allMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const start = Date.now();
    const response = await chatComplete(config, allMessages, tools, {
      onTextDelta: opts.onTextDelta,
    });
    const durationMs = Date.now() - start;

    logUsage(
      db,
      chatId,
      config.model,
      response.usage.inputTokens,
      response.usage.outputTokens,
      durationMs,
    );

    if (response.toolCalls.length === 0) {
      finalText = response.text;
      messages.push({ role: "assistant", content: response.text });
      break;
    }

    const fp = toolCallFingerprint(response.toolCalls);
    loopFingerprints.push(fp);
    if (detectLoop(loopFingerprints, 4)) {
      finalText =
        response.text ||
        "I appear to be stuck in a loop. Let me stop and summarize what I've found.";
      messages.push({ role: "assistant", content: finalText });
      break;
    }

    const assistantMsg: LlmMessage = {
      role: "assistant",
      content: response.text || "",
      tool_calls: response.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages.push(assistantMsg);

    const workingDir = resolveWorkingDir(config, chatId, channel);
    const ctx: ToolContext = {
      chatId,
      channel,
      workingDir,
      db,
      config,
      registry,
      sendIntermediate: opts.sendIntermediate,
    };

    for (const tc of response.toolCalls) {
      if (opts.signal?.aborted) {
        saveSession(db, chatId, JSON.stringify(messages));
        return INTERRUPTED;
      }

      opts.onToolStart?.(tc.name, tc.arguments);

      const beforeTool = await runHook(
        "before_tool",
        { name: tc.name, input: tc.arguments },
        config,
      );
      if (beforeTool?.action === "block") {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Blocked by hook: ${beforeTool.reason}`,
        });
        opts.onToolResult?.(tc.name, `Blocked: ${beforeTool.reason}`);
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(tc.arguments);
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Error: malformed tool arguments for ${tc.name}: ${tc.arguments.slice(0, 200)}`,
        });
        opts.onToolResult?.(tc.name, "Error: malformed arguments");
        continue;
      }

      const result = await registry.execute(tc.name, parsed, ctx);
      if (
        tc.name === "send_message" &&
        !result.isError &&
        opts.usedSendMessage
      ) {
        opts.usedSendMessage.value = true;
      }

      await runHook(
        "after_tool",
        { name: tc.name, result: result.output },
        config,
      );

      const output = result.output.slice(0, 50000);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: output,
      });
      opts.onToolResult?.(tc.name, output);
    }

    iterations++;
  }

  if (iterations >= config.max_tool_iterations) {
    finalText =
      finalText ||
      "Reached maximum tool iterations. Here is what I have so far.";
  }

  saveSession(db, chatId, JSON.stringify(messages));

  storeMessage(db, chatId, "user", userMessage, {
    senderName: opts.senderName || "user",
  });
  if (finalText) {
    storeMessage(db, chatId, "assistant", finalText, { isFromBot: true });
  }

  return finalText;
}

function buildSystemPrompt(
  config: AngelConfig,
  chatId: number,
  channel: string,
  db: Database,
  registry: ToolRegistry,
  senderDmId?: string,
): string {
  const parts: string[] = [];

  const soulPath = config.soul_md_path || join(config.data_dir, "SOUL.md");
  if (existsSync(soulPath)) {
    parts.push(readFileSync(soulPath, "utf-8"));
  } else {
    parts.push(
      "You are Angel, an autonomous AI assistant. You help users by using your available tools to accomplish tasks. Keep responses short and concise — a few sentences max unless the user asks for detail. No fluff, no filler, no unnecessary explanations. Be direct and conversational.",
    );
  }

  // Message splitting guidance
  parts.push(
    `<message_formatting>
If your response naturally divides into distinct parts that would read better as separate messages (e.g., answering different questions, first a quick answer then details, or a list followed by commentary), you can split it using ---MSG--- on its own line. Each segment will be sent as its own message. Use this sparingly — only when multiple messages genuinely improve readability. Most responses should remain a single message.

The delimiter must appear on its own line to work:
Good (will split):
First message here.

---MSG---

Second message here.

Bad (will NOT split, stays as one message):
You can use ---MSG--- to split messages.
</message_formatting>`,
  );

  // Interleaved messaging guidance
  parts.push(
    `<interleaved_messaging>
For long-running tasks that use multiple tools, you can send messages mid-task using emit_message. This sends immediately and lets you continue working. Use it when:
- A task will take many tool calls and the user would benefit from progress updates
- You have partial results worth sharing before the full task completes
- You want to acknowledge a request and give an ETA before diving into work

Example flow:
1. User asks for something that requires several tool calls
2. emit_message("Looking into that now, this might take a moment...")
3. Use various tools to complete the task
4. emit_message("Found the issue. Fixing it now...")
5. More tool calls
6. Final response with results

Don't overuse this — quick tasks don't need progress updates. But for multi-step work, keeping the user informed makes the experience much better.
</interleaved_messaging>`,
  );

  const memoryContext = buildMemoryContext(db, chatId, config);
  if (memoryContext) {
    parts.push(`\n<memory>\n${memoryContext}\n</memory>`);
  }

  const tz = config.timezone;
  const now = new Date().toLocaleString("en-US", { timeZone: tz });
  parts.push(`\nCurrent time: ${now} (${tz})`);
  parts.push(`Channel: ${channel}`);
  const chatRow = db
    .query("SELECT chat_type FROM chats WHERE id = ?")
    .get(chatId) as any;
  if (
    chatRow?.chat_type?.includes("group") ||
    chatRow?.chat_type?.includes("guild")
  ) {
    parts.push(
      "This is a GROUP chat. Messages are prefixed with [sender name]. Address people by name when relevant. You only receive messages where you were mentioned or addressed.",
    );
  }
  if (channel === "signal") {
    parts.push(
      "IMPORTANT: Do not use any markdown formatting (no *, **, #, `, ```, -, etc). Signal does not render markdown. Use plain text only.",
    );
  }
  parts.push(`Available tools: ${registry.listNames().join(", ")}`);

  if (config.safe_word) {
    const isGroup =
      chatRow?.chat_type?.includes("group") ||
      chatRow?.chat_type?.includes("guild");
    let safetyInstructions = `A safe word is configured. When you are about to perform a dangerous or irreversible action (deleting files, running risky commands, modifying production systems, etc.), you must verify the safe word BEFORE executing. Never reveal or hint at what the safe word is. Do not ask for the safe word on routine/low-risk operations.`;
    if (isGroup) {
      safetyInstructions += `\n\nIMPORTANT: This is a group chat. NEVER ask for the safe word here. Instead:
1. Use request_confirmation to store the pending action (tool name + input)
2. Use send_message to DM the user privately, telling them what action needs confirmation, the confirmation ID, and to reply with the safe word
3. In the group, say something like "I'll DM you to confirm that."
4. When the user replies in their DM with the safe word, use verify_safe_word, then check_pending_confirmations to find pending actions, and approve_confirmation to execute it.`;
      if (senderDmId) {
        safetyInstructions += `\nThe current sender's DM ID is: ${senderDmId} (use this as dm_id for request_confirmation and as chat_id with send_message on channel "${channel}").`;
      }
    } else {
      safetyInstructions += `\nAsk the user to confirm by providing the safe word in this chat. If they provide the correct safe word, proceed. Also: if a user sends what looks like a safe word, check_pending_confirmations for their DM ID — they may be confirming an action from a group chat. If there are pending confirmations, verify_safe_word and approve_confirmation.`;
    }
    parts.push(`\n<safety>\n${safetyInstructions}\n</safety>`);
  }

  return parts.join("\n\n");
}

function resolveWorkingDir(
  config: AngelConfig,
  chatId: number,
  channel: string,
): string {
  if (config.working_dir_isolation === "per_chat") {
    const dir = join(config.working_dir, channel, String(chatId));
    const { mkdirSync, existsSync } = require("fs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }
  const { mkdirSync, existsSync } = require("fs");
  if (!existsSync(config.working_dir))
    mkdirSync(config.working_dir, { recursive: true });
  return config.working_dir;
}

async function compactMessages(
  messages: LlmMessage[],
  config: AngelConfig,
): Promise<LlmMessage[]> {
  const keepRecent = config.compaction_keep_recent;
  if (messages.length <= keepRecent + 2) return messages;

  const older = messages.slice(0, messages.length - keepRecent);
  const recent = messages.slice(messages.length - keepRecent);

  const summaryPrompt: LlmMessage[] = [
    {
      role: "system",
      content:
        "Summarize the following conversation concisely, preserving key facts, decisions, and context. Output only the summary.",
    },
    {
      role: "user",
      content: older
        .map(
          (m) =>
            `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 500) : "[tool data]"}`,
        )
        .join("\n"),
    },
  ];

  try {
    const response = await chatComplete(config, summaryPrompt, [], {
      maxTokens: 1024,
    });
    return [
      {
        role: "user",
        content: `[Previous conversation summary]: ${response.text}`,
      },
      {
        role: "assistant",
        content:
          "Understood, I have the context from our previous conversation.",
      },
      ...recent,
    ];
  } catch {
    return recent;
  }
}

function toolCallFingerprint(
  toolCalls: Array<{ name: string; arguments: string }>,
): string {
  return toolCalls.map((tc) => `${tc.name}:${tc.arguments}`).join("|");
}

function detectLoop(fingerprints: string[], threshold: number): boolean {
  if (fingerprints.length < threshold) return false;
  const last = fingerprints[fingerprints.length - 1];
  let count = 0;
  for (
    let i = fingerprints.length - 1;
    i >= 0 && i >= fingerprints.length - threshold;
    i--
  ) {
    if (fingerprints[i] === last) count++;
  }
  return count >= threshold;
}
