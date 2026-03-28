import type { Database } from "bun:sqlite";
import type { AngelConfig } from "./config";
import type { ToolRegistry, ToolContext } from "./tools/registry";
import { chatComplete, type LlmMessage, type LlmTool } from "./llm";
import { loadSession, saveSession, logUsage, storeMessage } from "./db";
import { buildMemoryContext } from "./memory";
import { runHook } from "./hooks";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

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
}

export async function processMessage(userMessage: string, opts: AgentOptions, image?: { base64: string; mimeType: string }): Promise<string> {
  const { chatId, channel, db, config, registry } = opts;

  const sessionJson = loadSession(db, chatId);
  let messages: LlmMessage[] = sessionJson ? JSON.parse(sessionJson) : [];

  let systemPrompt = buildSystemPrompt(config, chatId, channel, db, registry);

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
        { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
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
  let loopFingerprints: string[] = [];
  let finalText = "";

  while (iterations < config.max_tool_iterations) {
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

    logUsage(db, chatId, config.model, response.usage.inputTokens, response.usage.outputTokens, durationMs);

    if (response.toolCalls.length === 0) {
      finalText = response.text;
      messages.push({ role: "assistant", content: response.text });
      break;
    }

    const fp = toolCallFingerprint(response.toolCalls);
    loopFingerprints.push(fp);
    if (detectLoop(loopFingerprints, 4)) {
      finalText = response.text || "I appear to be stuck in a loop. Let me stop and summarize what I've found.";
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
      sendIntermediate: opts.sendIntermediate,
    };

    for (const tc of response.toolCalls) {
      opts.onToolStart?.(tc.name, tc.arguments);

      const beforeTool = await runHook("before_tool", { name: tc.name, input: tc.arguments }, config);
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
        parsed = {};
      }

      const result = await registry.execute(tc.name, parsed, ctx);

      await runHook("after_tool", { name: tc.name, result: result.output }, config);

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
    finalText = finalText || "Reached maximum tool iterations. Here is what I have so far.";
  }

  saveSession(db, chatId, JSON.stringify(messages));

  storeMessage(db, chatId, "user", userMessage, { senderName: "user" });
  if (finalText) {
    storeMessage(db, chatId, "assistant", finalText, { isFromBot: true });
  }

  return finalText;
}

function buildSystemPrompt(config: AngelConfig, chatId: number, channel: string, db: Database, registry: ToolRegistry): string {
  const parts: string[] = [];

  const soulPath = config.soul_md_path || join(config.data_dir, "SOUL.md");
  if (existsSync(soulPath)) {
    parts.push(readFileSync(soulPath, "utf-8"));
  } else {
    parts.push("You are Angel, an autonomous AI assistant. You help users by using your available tools to accomplish tasks. Be concise, accurate, and proactive.");
  }

  const memoryContext = buildMemoryContext(db, chatId, config);
  if (memoryContext) {
    parts.push(`\n<memory>\n${memoryContext}\n</memory>`);
  }

  const tz = config.timezone;
  const now = new Date().toLocaleString("en-US", { timeZone: tz });
  parts.push(`\nCurrent time: ${now} (${tz})`);
  parts.push(`Channel: ${channel}`);
  parts.push(`Available tools: ${registry.listNames().join(", ")}`);

  return parts.join("\n\n");
}

function resolveWorkingDir(config: AngelConfig, chatId: number, channel: string): string {
  if (config.working_dir_isolation === "per_chat") {
    const dir = join(config.working_dir, channel, String(chatId));
    const { mkdirSync, existsSync } = require("fs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }
  const { mkdirSync, existsSync } = require("fs");
  if (!existsSync(config.working_dir)) mkdirSync(config.working_dir, { recursive: true });
  return config.working_dir;
}

async function compactMessages(messages: LlmMessage[], config: AngelConfig): Promise<LlmMessage[]> {
  const keepRecent = config.compaction_keep_recent;
  if (messages.length <= keepRecent + 2) return messages;

  const older = messages.slice(0, messages.length - keepRecent);
  const recent = messages.slice(messages.length - keepRecent);

  const summaryPrompt: LlmMessage[] = [
    { role: "system", content: "Summarize the following conversation concisely, preserving key facts, decisions, and context. Output only the summary." },
    { role: "user", content: older.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 500) : "[tool data]"}`).join("\n") },
  ];

  try {
    const response = await chatComplete(config, summaryPrompt, [], { maxTokens: 1024 });
    return [
      { role: "user", content: `[Previous conversation summary]: ${response.text}` },
      { role: "assistant", content: "Understood, I have the context from our previous conversation." },
      ...recent,
    ];
  } catch {
    return recent;
  }
}

function toolCallFingerprint(toolCalls: Array<{ name: string; arguments: string }>): string {
  return toolCalls.map((tc) => `${tc.name}:${tc.arguments}`).join("|");
}

function detectLoop(fingerprints: string[], threshold: number): boolean {
  if (fingerprints.length < threshold) return false;
  const last = fingerprints[fingerprints.length - 1];
  let count = 0;
  for (let i = fingerprints.length - 1; i >= 0 && i >= fingerprints.length - threshold; i--) {
    if (fingerprints[i] === last) count++;
  }
  return count >= threshold;
}
