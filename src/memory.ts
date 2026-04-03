import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { AngelConfig } from "./config";
import { archiveMemory, getMemories, insertMemory } from "./db";
import { chatComplete, type LlmMessage } from "./llm";

export function buildMemoryContext(
  db: Database,
  chatId: number,
  config: AngelConfig,
): string {
  const parts: string[] = [];

  const agentsMdPaths = [
    join(config.data_dir, "AGENTS.md"),
    join(config.data_dir, "runtime", "groups", "AGENTS.md"),
  ];
  for (const p of agentsMdPaths) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8").trim();
      if (content) parts.push(`[File Memory]\n${content}`);
      break;
    }
  }

  const memories = getMemories(db, chatId, 20);
  if (memories.length > 0) {
    const formatted = memories
      .map(
        (m: any) =>
          `- [${m.category}] ${m.content} (confidence: ${m.confidence})`,
      )
      .join("\n");
    parts.push(`[Structured Memories]\n${formatted}`);
  }

  return parts.join("\n\n");
}

export function handleExplicitMemory(
  text: string,
  db: Database,
  chatId: number,
): string | null {
  const lower = text.toLowerCase().trim();
  if (
    !lower.startsWith("remember:") &&
    !lower.startsWith("/memory:") &&
    !lower.startsWith("remember ")
  ) {
    return null;
  }

  const fact = text.replace(/^(remember:|\/memory:|remember)\s*/i, "").trim();
  if (fact.length < 5) return "Memory too short to save.";

  const existing = getMemories(db, chatId, 50);
  for (const m of existing) {
    if (jaccardSimilarity(m.content, fact) > 0.6) {
      archiveMemory(db, m.id);
    }
  }

  insertMemory(db, chatId, fact, "general", "user");
  return `Remembered: "${fact}"`;
}

export async function runMemoryReflector(
  db: Database,
  chatId: number,
  config: AngelConfig,
  recentMessages: string[],
): Promise<void> {
  if (!config.memory.reflector_enabled) return;
  if (recentMessages.length < 3) return;

  const conversation = recentMessages.slice(-10).join("\n");

  const prompt: LlmMessage[] = [
    {
      role: "system",
      content: `Extract durable facts from this conversation as a JSON array of objects with {content, category}.
Categories: "profile" (user info), "knowledge" (facts/preferences), "event" (things that happened).
Only extract facts worth remembering long-term. Return [] if nothing notable.
Output only valid JSON array, nothing else.`,
    },
    { role: "user", content: conversation },
  ];

  try {
    const response = await chatComplete(config, prompt, [], { maxTokens: 512 });
    const facts = JSON.parse(response.text);
    if (!Array.isArray(facts)) return;

    const existing = getMemories(db, chatId, 100);
    let inserted = 0;
    let skipped = 0;

    for (const fact of facts) {
      if (!fact.content || fact.content.length < 5) continue;

      const isDuplicate = existing.some(
        (m: any) => jaccardSimilarity(m.content, fact.content) > 0.55,
      );
      if (isDuplicate) {
        skipped++;
        continue;
      }

      insertMemory(
        db,
        chatId,
        fact.content,
        fact.category || "general",
        "reflector",
      );
      inserted++;
    }

    db.run(
      `INSERT INTO memory_reflector_runs (chat_id, started_at, finished_at, extracted_count, inserted_count, skipped_count)
       VALUES (?, datetime('now'), datetime('now'), ?, ?, ?)`,
      [chatId, facts.length, inserted, skipped],
    );
  } catch (err: any) {
    console.error(`[angel] Memory reflector error: ${err.message}`);
  }
}

export function writeAgentsMd(
  config: AngelConfig,
  content: string,
  chatId?: number,
  channel?: string,
): void {
  let path: string;
  if (chatId && channel) {
    path = join(
      config.data_dir,
      "runtime",
      "groups",
      channel,
      String(chatId),
      "AGENTS.md",
    );
  } else {
    path = join(config.data_dir, "AGENTS.md");
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const reflectorTimers: Map<number, number> = new Map();

export function scheduleReflector(
  db: Database,
  chatId: number,
  config: AngelConfig,
  messages: string[],
) {
  const lastRun = reflectorTimers.get(chatId) || 0;
  const now = Date.now();
  if (now - lastRun < config.memory.reflector_interval_ms) return;

  reflectorTimers.set(chatId, now);
  runMemoryReflector(db, chatId, config, messages).catch(() => {});
}
