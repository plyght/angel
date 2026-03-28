import OpenAI from "openai";
import type { AngelConfig } from "./config";

let _client: OpenAI | null = null;

export function getClient(config: AngelConfig): OpenAI {
  if (_client) return _client;
  _client = new OpenAI({ apiKey: config.openai_api_key });
  return _client;
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
  const client = getClient(config);
  const model = opts?.model || config.model;
  const maxTokens = opts?.maxTokens || config.max_tokens;
  const start = Date.now();

  if (opts?.onTextDelta) {
    return streamChatComplete(client, model, messages, tools, maxTokens, opts.onTextDelta, start);
  }

  const response = await client.chat.completions.create({
    model,
    messages: messages as any,
    tools: tools.length > 0 ? tools as any : undefined,
    max_completion_tokens: maxTokens,
  } as any);

  const choice = response.choices[0];
  const duration = Date.now() - start;

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

async function streamChatComplete(
  client: OpenAI,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[],
  maxTokens: number,
  onTextDelta: (delta: string) => void,
  start: number
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
  const client = getClient(config);
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
