import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import xxhash from "xxhash-wasm";
import type { AngelConfig } from "./config";

let _openaiClient: OpenAI | null = null;
let _anthropicClient: Anthropic | null = null;
let _isOAuthClient = false;

const CCH_SEED = 0x6E52736AC806831En;
const CCH_MASK = 0xFFFFFn;
const CCH_PLACEHOLDER = "cch=00000";
const FINGERPRINT_SALT = "59cf53e54c78";
const CC_VERSION = "2.1.87";

let _hasherPromise: ReturnType<typeof xxhash> | null = null;
function getHasher() {
  if (!_hasherPromise) _hasherPromise = xxhash();
  return _hasherPromise;
}

async function computeCch(body: string): Promise<string> {
  const hasher = await getHasher();
  const hash = hasher.h64Raw(new TextEncoder().encode(body), CCH_SEED);
  return (hash & CCH_MASK).toString(16).padStart(5, "0");
}

function computeFingerprint(firstUserMessage: string): string {
  const indices = [4, 7, 20];
  const chars = indices.map(i => firstUserMessage[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${CC_VERSION}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-");
}

function getOpenAIClient(config: AngelConfig): OpenAI {
  if (_openaiClient) return _openaiClient;
  _openaiClient = new OpenAI({ apiKey: config.openai_api_key });
  return _openaiClient;
}

function getAnthropicClient(config: AngelConfig): Anthropic {
  if (_anthropicClient) return _anthropicClient;

  if (config.anthropic_api_key) {
    _isOAuthClient = false;
    _anthropicClient = new Anthropic({ apiKey: config.anthropic_api_key });
    return _anthropicClient;
  }

  const oauthToken = loadRoseOAuthToken();
  if (oauthToken) {
    _isOAuthClient = true;
    const cchFetch = (async (input: any, init: any) => {
      const url = input instanceof Request ? input.url : String(input);
      let body = init?.body;

      try {
        if (
          url.includes("/v1/messages") &&
          typeof body === "string" &&
          body.includes(CCH_PLACEHOLDER)
        ) {
          const cch = await computeCch(body);
          body = body.replace(CCH_PLACEHOLDER, `cch=${cch}`);
        }
      } catch {}

      return globalThis.fetch(input, { ...init, body });
    }) as any;

    _anthropicClient = new Anthropic({
      apiKey: null,
      authToken: oauthToken,
      defaultHeaders: {
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
        "User-Agent": `rose-cli/${CC_VERSION} (external, cli)`,
        "x-app": "cli",
      },
      fetch: cchFetch,
    });
    return _anthropicClient;
  }

  throw new Error(
    "No Anthropic credentials found. Set anthropic_api_key in config, or log in via rose (rose auth login)."
  );
}

function loadRoseOAuthToken(): string | null {
  try {
    const result = Bun.spawnSync(
      ["security", "find-generic-password", "-s", "Rose-credentials", "-w"],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (result.exitCode !== 0) return null;
    const raw = result.stdout.toString().trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    const oauth = data?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
      const refreshed = refreshRoseOAuthToken(oauth.refreshToken, oauth.scopes);
      if (refreshed) return refreshed;
      return null;
    }
    return oauth.accessToken;
  } catch {
    return null;
  }
}

function refreshRoseOAuthToken(refreshToken: string, scopes: string[]): string | null {
  if (!refreshToken) return null;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      scope: scopes.join(" "),
    });

    const resp = Bun.spawnSync(
      ["curl", "-s", "-X", "POST", "https://platform.claude.com/v1/oauth/token",
       "-H", "Content-Type: application/x-www-form-urlencoded",
       "-d", body.toString()],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (resp.exitCode !== 0) return null;
    const json = JSON.parse(resp.stdout.toString().trim());
    if (!json.access_token) return null;

    const newData = {
      claudeAiOauth: {
        accessToken: json.access_token,
        refreshToken: json.refresh_token || refreshToken,
        expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : null,
        scopes,
      },
    };
    Bun.spawnSync(
      ["security", "add-generic-password", "-U", "-s", "Rose-credentials",
       "-a", process.env.USER || "angel", "-w", JSON.stringify(newData)],
      { stdout: "pipe", stderr: "pipe" }
    );

    _anthropicClient = null;
    return json.access_token;
  } catch {
    return null;
  }
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface LlmResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function chatComplete(
  config: AngelConfig,
  messages: LlmMessage[],
  tools: LlmTool[],
  opts?: {
    model?: string;
    maxTokens?: number;
    onTextDelta?: (delta: string) => void;
  }
): Promise<LlmResponse> {
  const model = opts?.model || config.model;

  if (isClaudeModel(model)) {
    return claudeChatComplete(config, model, messages, tools, opts);
  }

  const client = getOpenAIClient(config);
  const maxTokens = opts?.maxTokens || config.max_tokens;

  if (opts?.onTextDelta) {
    return streamChatComplete(client, model, messages, tools, maxTokens, opts.onTextDelta);
  }

  const response = await client.chat.completions.create({
    model,
    messages: messages as any,
    tools: tools.length > 0 ? tools as any : undefined,
    max_completion_tokens: maxTokens,
  } as any);

  const choice = response.choices[0];

  return {
    text: choice.message.content || "",
    toolCalls: (choice.message.tool_calls || []).map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
    finishReason: choice.finish_reason || "stop",
    usage: {
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0,
    },
  };
}

function extractFirstUserText(messages: LlmMessage[]): string {
  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") return msg.content;
  }
  return "";
}

async function claudeChatComplete(
  config: AngelConfig,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[],
  opts?: {
    maxTokens?: number;
    onTextDelta?: (delta: string) => void;
  }
): Promise<LlmResponse> {
  const client = getAnthropicClient(config);
  const maxTokens = opts?.maxTokens || config.max_tokens;

  let systemPrompt = "";
  const anthropicMessages: Array<{ role: "user" | "assistant"; content: any }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content;
    } else if (msg.role === "user") {
      anthropicMessages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const content: any[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let parsedInput: any = {};
          try { parsedInput = JSON.parse(tc.function.arguments); } catch {}
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }
      if (content.length > 0) {
        anthropicMessages.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool") {
      anthropicMessages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: msg.content,
        }],
      });
    }
  }

  const mergedMessages = mergeConsecutiveRoles(anthropicMessages);

  const anthropicTools = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const systemBlocks: any[] = [];

  if (_isOAuthClient) {
    const fingerprint = computeFingerprint(extractFirstUserText(messages));
    const billingHeader = `x-anthropic-billing-header: cc_version=${CC_VERSION}.${fingerprint}; cc_entrypoint=cli; ${CCH_PLACEHOLDER};`;
    systemBlocks.push({ type: "text", text: billingHeader });
  }

  if (systemPrompt) {
    systemBlocks.push({ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } });
  }

  const params: any = {
    model,
    max_tokens: maxTokens,
    messages: mergedMessages,
    betas: ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"],
  };
  if (systemBlocks.length > 0) params.system = systemBlocks;
  if (anthropicTools.length > 0) params.tools = anthropicTools;

  if (opts?.onTextDelta) {
    return streamClaudeChat(client, params, opts.onTextDelta);
  }

  const response = await client.beta.messages.create(params);

  let text = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
  }

  return {
    text,
    toolCalls,
    finishReason: response.stop_reason === "end_turn" ? "stop" : response.stop_reason || "stop",
    usage: {
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    },
  };
}

async function streamClaudeChat(
  client: Anthropic,
  params: any,
  onTextDelta: (delta: string) => void
): Promise<LlmResponse> {
  const stream = client.beta.messages.stream(params);

  let text = "";
  const toolCalls: Map<string, { id: string; name: string; arguments: string }> = new Map();
  let currentToolId = "";

  stream.on("text", (delta) => {
    text += delta;
    onTextDelta(delta);
  });

  stream.on("contentBlock", (block: any) => {
    if (block.type === "tool_use") {
      currentToolId = block.id;
      toolCalls.set(block.id, {
        id: block.id,
        name: block.name,
        arguments: "",
      });
    }
  });

  stream.on("inputJson", (json: string) => {
    if (currentToolId && toolCalls.has(currentToolId)) {
      toolCalls.get(currentToolId)!.arguments += json;
    }
  });

  const finalMessage = await stream.finalMessage();

  return {
    text,
    toolCalls: [...toolCalls.values()],
    finishReason: finalMessage.stop_reason === "end_turn" ? "stop" : finalMessage.stop_reason || "stop",
    usage: {
      inputTokens: finalMessage.usage?.input_tokens || 0,
      outputTokens: finalMessage.usage?.output_tokens || 0,
    },
  };
}

function mergeConsecutiveRoles(
  messages: Array<{ role: "user" | "assistant"; content: any }>
): Array<{ role: "user" | "assistant"; content: any }> {
  const merged: Array<{ role: "user" | "assistant"; content: any }> = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      const lastContent = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
      const msgContent = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
      last.content = [...lastContent, ...msgContent];
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

async function streamChatComplete(
  client: OpenAI,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[],
  maxTokens: number,
  onTextDelta: (delta: string) => void,
): Promise<LlmResponse> {
  const stream = await client.chat.completions.create({
    model,
    messages: messages as any,
    tools: tools.length > 0 ? tools as any : undefined,
    max_completion_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  });

  let text = "";
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
  let finishReason = "stop";
  let usage = { inputTokens: 0, outputTokens: 0 };

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0,
        };
      }
      continue;
    }

    if (delta.content) {
      text += delta.content;
      onTextDelta(delta.content);
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = toolCalls.get(tc.index);
        if (existing) {
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        } else {
          toolCalls.set(tc.index, {
            id: tc.id || "",
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || "",
          });
        }
      }
    }

    if (chunk.choices?.[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason;
    }
  }

  return {
    text,
    toolCalls: [...toolCalls.values()],
    finishReason,
    usage,
  };
}

export async function responsesApiCall(
  config: AngelConfig,
  input: string,
  builtInTools: Array<{ type: string }>,
  opts?: { model?: string }
): Promise<{ output: string; usage: { inputTokens: number; outputTokens: number } }> {
  const client = getOpenAIClient(config);
  const model = opts?.model || config.model;

  const response = await (client as any).responses.create({
    model,
    input,
    tools: builtInTools,
  });

  let output = "";
  for (const item of response.output) {
    if (item.type === "message") {
      for (const c of item.content) {
        if (c.type === "output_text") output += c.text;
      }
    }
  }

  return {
    output,
    usage: {
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    },
  };
}

export function resetClients() {
  _openaiClient = null;
  _anthropicClient = null;
  _isOAuthClient = false;
}
