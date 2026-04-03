import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { Tool, ToolContext, ToolResult } from "./registry";

interface AgentDef {
  command: string;
  buildArgs: (
    prompt: string,
    opts: { workingDir: string; model?: string },
  ) => string[];
  detect: () => Promise<string | null>;
  installHint: string;
  supportsStreaming?: boolean;
}

const AGENTS: Record<string, AgentDef> = {
  claude: {
    command: "claude",
    buildArgs: (prompt, opts) => {
      const args = [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--max-turns",
        "50",
        "--dangerously-skip-permissions",
      ];
      if (opts.model) args.push("--model", opts.model);
      args.push(prompt);
      return args;
    },
    detect: () => which("claude"),
    installHint: "Install: bun add -g @anthropic-ai/claude-code",
    supportsStreaming: true,
  },
  rose: {
    command: "rose",
    buildArgs: (prompt, opts) => {
      const args = [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--max-turns",
        "50",
        "--dangerously-skip-permissions",
      ];
      if (opts.model) args.push("--model", opts.model);
      args.push(prompt);
      return args;
    },
    detect: () => which("rose"),
    installHint: "",
    supportsStreaming: true,
  },
  codex: {
    command: "codex",
    buildArgs: (prompt, opts) => {
      const args = ["--approval-mode", "full-auto", "-q"];
      if (opts.model) args.push("--model", opts.model);
      args.push(prompt);
      return args;
    },
    detect: () => which("codex"),
    installHint: "Install: bun add -g @openai/codex",
  },
  aider: {
    command: "aider",
    buildArgs: (prompt, opts) => {
      const args = [
        "--yes",
        "--no-auto-commits",
        "--no-pretty",
        "--message",
        prompt,
      ];
      if (opts.model) args.push("--model", opts.model);
      return args;
    },
    detect: () => which("aider"),
    installHint: "Install: pip install aider-chat",
  },
  goose: {
    command: "goose",
    buildArgs: (prompt) => ["run", "--text", prompt],
    detect: () => which("goose"),
    installHint: "Install: brew install block/goose/goose",
  },
  amp: {
    command: "amp",
    buildArgs: (prompt, opts) => {
      const args = ["--non-interactive"];
      if (opts.model) args.push("--model", opts.model);
      args.push(prompt);
      return args;
    },
    detect: () => which("amp"),
    installHint: "Install: npm install -g @anthropic/amp",
  },
};

async function which(cmd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    if (!out) return null;
    const check = Bun.spawn([out, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await check.exited;
    if (check.exitCode !== 0) return null;
    return out;
  } catch {
    return null;
  }
}

export interface RunningAgent {
  id: number;
  agent: string;
  prompt: string;
  cwd: string;
  status: "running" | "completed" | "failed";
  startedAt: Date;
  finishedAt?: Date;
  process: any;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  chatId: number;
  channel: string;
  externalChatId: string;
  // Progress tracking for streaming agents
  currentTool?: string;
  toolsUsed: string[];
  turnCount: number;
  sessionId?: string;
  lastActivity?: string;
  totalCostUsd?: number;
}

const runningAgents: Map<number, RunningAgent> = new Map();
let nextId = 1;

let notifyFn: ((agent: RunningAgent, message: string) => Promise<void>) | null =
  null;
let progressFn:
  | ((agent: RunningAgent, message: string) => Promise<void>)
  | null = null;

export function setCodingAgentNotifier(
  fn: (agent: RunningAgent, message: string) => Promise<void>,
) {
  notifyFn = fn;
}

export function setCodingAgentProgressNotifier(
  fn: (agent: RunningAgent, message: string) => Promise<void>,
) {
  progressFn = fn;
}

async function notify(agent: RunningAgent, message: string) {
  if (notifyFn) {
    try {
      await notifyFn(agent, message);
    } catch {}
  }
}

async function notifyProgress(agent: RunningAgent, message: string) {
  if (progressFn) {
    try {
      await progressFn(agent, message);
    } catch {}
  }
}

export const spawnCodingAgentTool: Tool = {
  name: "spawn_coding_agent",
  description: `Spawn an external coding agent (claude, rose, codex, aider, goose, amp) to work on a task in the background. The user is automatically notified when it finishes.`,
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: Object.keys(AGENTS),
        description: "Which coding agent to use",
      },
      prompt: {
        type: "string",
        description: "Task instruction for the coding agent",
      },
      working_dir: {
        type: "string",
        description:
          "Directory to run the agent in (defaults to current working dir)",
      },
      model: {
        type: "string",
        description: "Model override for the agent (optional, agent-specific)",
      },
    },
    required: ["agent", "prompt"],
  },
  risk: "high",

  async execute(
    input: {
      agent: string;
      prompt: string;
      working_dir?: string;
      model?: string;
    },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const def = AGENTS[input.agent];
    if (!def) {
      return {
        output: `Unknown agent: ${input.agent}. Available: ${Object.keys(AGENTS).join(", ")}`,
        isError: true,
      };
    }

    const resolvedPath = await def.detect();
    if (!resolvedPath) {
      return {
        output: `${input.agent} is not installed.\n${def.installHint}`,
        isError: true,
      };
    }

    let cwd = input.working_dir || ctx.workingDir;
    if (cwd.startsWith("~")) cwd = cwd.replace("~", process.env.HOME || "");
    const args = def.buildArgs(input.prompt, {
      workingDir: cwd,
      model: input.model,
    });

    const chatRow = ctx.db
      ?.query("SELECT external_chat_id FROM chats WHERE id = ?")
      .get(ctx.chatId) as any;
    const externalChatId = chatRow?.external_chat_id || "";

    const id = nextId++;
    const entry: RunningAgent = {
      id,
      agent: input.agent,
      prompt: input.prompt,
      cwd,
      status: "running",
      startedAt: new Date(),
      process: null,
      stdout: "",
      stderr: "",
      chatId: ctx.chatId,
      channel: ctx.channel,
      externalChatId,
      toolsUsed: [],
      turnCount: 0,
    };
    runningAgents.set(id, entry);

    try {
      const proc = Bun.spawn([resolvedPath, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
      });
      entry.process = proc;

      // Process stdout - for streaming agents, parse NDJSON for progress
      if (def.supportsStreaming) {
        (async () => {
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let lastProgressTime = 0;
          const PROGRESS_THROTTLE_MS = 5000; // Don't send progress more than every 5s

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              entry.stdout = buffer;

              // Process complete NDJSON lines
              const lines = buffer.split("\n");
              buffer = lines.pop() || ""; // Keep incomplete line in buffer

              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const event = JSON.parse(line);
                  processStreamEvent(entry, event);

                  // Send progress notification if enough time has passed
                  const now = Date.now();
                  if (
                    entry.currentTool &&
                    now - lastProgressTime > PROGRESS_THROTTLE_MS
                  ) {
                    lastProgressTime = now;
                    const elapsed = formatDuration(
                      now - entry.startedAt.getTime(),
                    );
                    const toolList =
                      entry.toolsUsed.length > 0
                        ? `Tools: ${[...new Set(entry.toolsUsed)].slice(-5).join(", ")}`
                        : "";
                    notifyProgress(
                      entry,
                      `[${elapsed}] Using ${entry.currentTool}... (turn ${entry.turnCount})${toolList ? "\n" + toolList : ""}`,
                    );
                  }
                } catch {
                  // Not valid JSON, ignore
                }
              }
            }
            // Process any remaining buffer
            if (buffer.trim()) {
              entry.stdout = entry.stdout.endsWith("\n")
                ? entry.stdout + buffer
                : entry.stdout;
            }
          } catch {}
        })();
      } else {
        // Non-streaming agents - just collect stdout
        (async () => {
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              entry.stdout += decoder.decode(value, { stream: true });
            }
          } catch {}
        })();
      }

      (async () => {
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            entry.stderr += decoder.decode(value, { stream: true });
          }
        } catch {}
      })();

      (async () => {
        try {
          await proc.exited;
          entry.exitCode = proc.exitCode;
          entry.finishedAt = new Date();
          entry.currentTool = undefined;
          const duration = formatDuration(
            entry.finishedAt.getTime() - entry.startedAt.getTime(),
          );

          if (proc.exitCode === 0) {
            entry.status = "completed";
            const summary = extractSummary(entry, entry.stdout.trim());
            notify(
              entry,
              `Done — ${entry.agent} finished in ${duration}.\n\n${summary || "No output."}`,
            );
          } else {
            entry.status = "failed";
            const errOutput = extractSummary(
              entry,
              (entry.stderr || entry.stdout).trim(),
            );
            notify(
              entry,
              `${entry.agent} failed (exit ${proc.exitCode}, ${duration}).\n\n${errOutput || "No output."}`,
            );
          }
        } catch (err: any) {
          entry.status = "failed";
          entry.finishedAt = new Date();
          notify(entry, `${entry.agent} crashed: ${err.message}`);
        }
      })();
    } catch (err: any) {
      entry.status = "failed";
      entry.finishedAt = new Date();
      runningAgents.set(id, entry);
      return {
        output: `Failed to spawn ${input.agent}: ${err.message}`,
        isError: true,
      };
    }

    return {
      output: `Spawned ${input.agent} #${id} in background. User will be notified on completion.`,
    };
  },
};

export const codingAgentStatusTool: Tool = {
  name: "coding_agent_status",
  description:
    "Check status and recent output of running or completed coding agents.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "Specific agent job ID to check (omit for all)",
      },
      tail: {
        type: "number",
        description: "Number of chars of recent output to show (default: 2000)",
      },
    },
  },
  risk: "low",

  async execute(input: { id?: number; tail?: number }): Promise<ToolResult> {
    const tailLen = input.tail || 2000;

    if (input.id) {
      const entry = runningAgents.get(input.id);
      if (!entry)
        return { output: `No agent found with id #${input.id}`, isError: true };
      return { output: formatAgentStatus(entry, tailLen) };
    }

    if (runningAgents.size === 0)
      return { output: "No coding agents have been spawned." };

    const sorted = [...runningAgents.values()].sort((a, b) => b.id - a.id);
    return {
      output: sorted
        .map((e) => formatAgentStatus(e, tailLen))
        .join("\n\n---\n\n"),
    };
  },
};

export const killCodingAgentTool: Tool = {
  name: "kill_coding_agent",
  description: "Kill a running coding agent by its job ID.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "number", description: "Agent job ID to kill" },
    },
    required: ["id"],
  },
  risk: "medium",

  async execute(input: { id: number }): Promise<ToolResult> {
    const entry = runningAgents.get(input.id);
    if (!entry)
      return { output: `No agent found with id #${input.id}`, isError: true };
    if (entry.status !== "running")
      return { output: `Agent #${input.id} is already ${entry.status}` };

    try {
      entry.process?.kill();
      entry.status = "failed";
      entry.finishedAt = new Date();
      return { output: `Agent #${input.id} (${entry.agent}) killed.` };
    } catch (err: any) {
      return {
        output: `Failed to kill agent #${input.id}: ${err.message}`,
        isError: true,
      };
    }
  },
};

export const listCodingAgentsTool: Tool = {
  name: "list_coding_agents",
  description:
    "List available external coding agents and whether they are installed.",
  parameters: { type: "object", properties: {} },
  risk: "low",

  async execute(): Promise<ToolResult> {
    const results: string[] = [];
    for (const [name, def] of Object.entries(AGENTS)) {
      const path = await def.detect();
      if (path) {
        results.push(`${name}: installed (${path})`);
      } else {
        results.push(`${name}: not installed — ${def.installHint}`);
      }
    }
    return { output: results.join("\n") };
  },
};

function formatAgentStatus(entry: RunningAgent, tailLen: number): string {
  const elapsed = formatDuration(
    (entry.finishedAt || new Date()).getTime() - entry.startedAt.getTime(),
  );
  const lines = [
    `#${entry.id} [${entry.status.toUpperCase()}] ${entry.agent}`,
    `Prompt: ${entry.prompt.slice(0, 200)}`,
    `Dir: ${entry.cwd}`,
    `Duration: ${elapsed}`,
  ];

  // Show progress info for running agents
  if (entry.status === "running") {
    if (entry.currentTool) {
      lines.push(`Current: Using ${entry.currentTool}`);
    } else if (entry.lastActivity) {
      lines.push(`Activity: ${entry.lastActivity}`);
    }
    if (entry.turnCount > 0) {
      lines.push(`Turns: ${entry.turnCount}`);
    }
    const uniqueTools = [...new Set(entry.toolsUsed)];
    if (uniqueTools.length > 0) {
      lines.push(
        `Tools used: ${uniqueTools.slice(-10).join(", ")}${uniqueTools.length > 10 ? "..." : ""}`,
      );
    }
  }

  if (entry.exitCode !== undefined && entry.exitCode !== null) {
    lines.push(`Exit code: ${entry.exitCode}`);
  }

  // Show metadata for completed agents
  if (entry.status !== "running") {
    if (entry.totalCostUsd) {
      lines.push(`Cost: $${entry.totalCostUsd.toFixed(4)}`);
    }
    if (entry.turnCount > 0) {
      lines.push(`Turns: ${entry.turnCount}`);
    }
    if (entry.sessionId) {
      lines.push(`Session: ${entry.sessionId.slice(0, 8)}...`);
    }
    const uniqueTools = [...new Set(entry.toolsUsed)];
    if (uniqueTools.length > 0) {
      lines.push(`Tools used: ${uniqueTools.join(", ")}`);
    }
  }

  const output = entry.stdout.trim();
  if (output) {
    const tail =
      output.length > tailLen ? "...\n" + output.slice(-tailLen) : output;
    lines.push(`\nOutput:\n${tail}`);
  }

  const errors = entry.stderr.trim();
  if (errors) {
    const tail =
      errors.length > tailLen ? "...\n" + errors.slice(-tailLen) : errors;
    lines.push(`\nStderr:\n${tail}`);
  }

  return lines.join("\n");
}

/**
 * Process a single NDJSON stream event from Claude/Rose to track progress
 */
function processStreamEvent(entry: RunningAgent, event: any): void {
  const type = event.type;
  const subtype = event.subtype;

  // Track session ID from init or result
  if (type === "system" && subtype === "init" && event.session_id) {
    entry.sessionId = event.session_id;
  }

  // Track tool usage from stream events
  if (type === "stream_event" && event.event) {
    const streamEvent = event.event;

    // Tool start: content_block_start with tool_use type
    if (streamEvent.type === "content_block_start") {
      const contentBlock = streamEvent.content_block;
      if (contentBlock?.type === "tool_use" && contentBlock.name) {
        entry.currentTool = contentBlock.name;
        entry.toolsUsed.push(contentBlock.name);
        entry.lastActivity = `Using ${contentBlock.name}`;
      }
    }

    // Tool end: content_block_stop
    if (streamEvent.type === "content_block_stop" && entry.currentTool) {
      entry.lastActivity = `Finished ${entry.currentTool}`;
      entry.currentTool = undefined;
    }

    // Message complete - increment turn count
    if (streamEvent.type === "message_stop") {
      entry.turnCount++;
    }
  }

  // Assistant message indicates a new response
  if (type === "assistant") {
    entry.lastActivity = "Thinking...";
  }

  // API retry events
  if (type === "system" && subtype === "api_retry") {
    entry.lastActivity = `API retry (attempt ${event.attempt}/${event.max_retries})`;
  }

  // Result message - extract final metadata
  if (type === "result") {
    if (event.session_id) entry.sessionId = event.session_id;
    if (event.total_cost_usd) entry.totalCostUsd = event.total_cost_usd;
    if (event.num_turns) entry.turnCount = event.num_turns;
    entry.lastActivity = event.is_error ? "Failed" : "Completed";
  }
}

/**
 * Extract a human-readable summary from agent output
 * For streaming agents, parses NDJSON to find the result message
 */
function extractSummary(entry: RunningAgent, raw: string): string {
  if (!raw) return "";

  const agentName = entry.agent;

  if (agentName === "claude" || agentName === "rose") {
    // For stream-json output, find the result message in NDJSON
    const lines = raw.split("\n").filter((l) => l.trim());
    let resultEvent: any = null;

    // Parse from end to find result message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === "result") {
          resultEvent = event;
          break;
        }
      } catch {
        // Not valid JSON
      }
    }

    if (resultEvent) {
      const meta: string[] = [];
      if (resultEvent.is_error) meta.push("[error]");
      if (entry.totalCostUsd || resultEvent.total_cost_usd) {
        meta.push(
          `Cost: $${(entry.totalCostUsd || resultEvent.total_cost_usd).toFixed(4)}`,
        );
      }
      const turns = entry.turnCount || resultEvent.num_turns;
      if (turns) meta.push(`${turns} turns`);
      if (resultEvent.duration_ms)
        meta.push(formatDuration(resultEvent.duration_ms));
      if (entry.sessionId || resultEvent.session_id) {
        meta.push(
          `Session: ${(entry.sessionId || resultEvent.session_id).slice(0, 8)}...`,
        );
      }

      // Show tools used if any
      const uniqueTools = [...new Set(entry.toolsUsed)];
      if (uniqueTools.length > 0) {
        meta.push(
          `Tools: ${uniqueTools.slice(0, 8).join(", ")}${uniqueTools.length > 8 ? "..." : ""}`,
        );
      }

      const metaLine = meta.length ? meta.join(" | ") + "\n\n" : "";
      const content = resultEvent.result || "";
      const full = metaLine + content;
      return full.slice(0, 8000) || raw.slice(0, 8000);
    }

    // Fallback: try parsing as single JSON (old format)
    try {
      const json = JSON.parse(raw);
      const meta: string[] = [];
      if (json.is_error) meta.push("[error]");
      if (json.total_cost_usd)
        meta.push(`Cost: $${json.total_cost_usd.toFixed(4)}`);
      if (json.num_turns) meta.push(`${json.num_turns} turns`);
      if (json.duration_ms) meta.push(formatDuration(json.duration_ms));
      if (json.session_id)
        meta.push(`Session: ${json.session_id.slice(0, 8)}...`);
      const metaLine = meta.length ? meta.join(" | ") + "\n\n" : "";
      const content = json.result || "";
      const full = metaLine + content;
      return full.slice(0, 8000) || raw.slice(0, 8000);
    } catch {
      return raw.slice(0, 8000);
    }
  }

  if (raw.length > 2000) {
    return raw.slice(-2000);
  }
  return raw;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

export function killAllCodingAgents() {
  for (const entry of runningAgents.values()) {
    if (entry.status === "running") {
      try {
        entry.process?.kill();
      } catch {}
      entry.status = "failed";
      entry.finishedAt = new Date();
    }
  }
}

// Persistence for surviving restarts

interface PersistedAgent {
  id: number;
  pid: number;
  agent: string;
  prompt: string;
  cwd: string;
  startedAt: string;
  chatId: number;
  channel: string;
  externalChatId: string;
}

let dataDir: string | null = null;

export function setCodingAgentDataDir(dir: string) {
  dataDir = dir;
}

function getAgentsFilePath(): string | null {
  if (!dataDir) return null;
  return join(dataDir, "running_agents.json");
}

export function persistRunningAgents(): number {
  const path = getAgentsFilePath();
  if (!path) return 0;

  const toPersist: PersistedAgent[] = [];
  for (const entry of runningAgents.values()) {
    if (entry.status === "running" && entry.process?.pid) {
      toPersist.push({
        id: entry.id,
        pid: entry.process.pid,
        agent: entry.agent,
        prompt: entry.prompt,
        cwd: entry.cwd,
        startedAt: entry.startedAt.toISOString(),
        chatId: entry.chatId,
        channel: entry.channel,
        externalChatId: entry.externalChatId,
      });
    }
  }

  if (toPersist.length > 0) {
    writeFileSync(path, JSON.stringify(toPersist, null, 2));
  } else if (existsSync(path)) {
    unlinkSync(path);
  }

  return toPersist.length;
}

export function restoreRunningAgents(): number {
  const path = getAgentsFilePath();
  if (!path || !existsSync(path)) return 0;

  let persisted: PersistedAgent[];
  try {
    persisted = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return 0;
  }

  // Clean up the file immediately
  try {
    unlinkSync(path);
  } catch {}

  let restored = 0;
  for (const p of persisted) {
    // Check if PID is still running
    try {
      process.kill(p.pid, 0); // Signal 0 just checks if process exists
    } catch {
      // Process not running, skip
      continue;
    }

    // Update nextId to avoid conflicts
    if (p.id >= nextId) nextId = p.id + 1;

    // Create a restored entry (no process handle, but we'll monitor the PID)
    const entry: RunningAgent = {
      id: p.id,
      agent: p.agent,
      prompt: p.prompt,
      cwd: p.cwd,
      status: "running",
      startedAt: new Date(p.startedAt),
      process: null,
      stdout: "(output unavailable - restored after restart)",
      stderr: "",
      chatId: p.chatId,
      channel: p.channel,
      externalChatId: p.externalChatId,
      toolsUsed: [],
      turnCount: 0,
    };

    runningAgents.set(p.id, entry);
    restored++;

    // Monitor the PID for completion
    monitorPid(p.pid, entry);
  }

  return restored;
}

function monitorPid(pid: number, entry: RunningAgent) {
  const check = () => {
    try {
      process.kill(pid, 0);
      // Still running, check again in 5 seconds
      setTimeout(check, 5000);
    } catch {
      // Process exited
      entry.finishedAt = new Date();
      const duration = formatDuration(
        entry.finishedAt.getTime() - entry.startedAt.getTime(),
      );

      // We don't know the exit code, assume success if it ran this long
      entry.status = "completed";
      notify(
        entry,
        `Done — ${entry.agent} #${entry.id} finished in ${duration}.\n\n(Agent was running during restart, output not available)`,
      );
    }
  };

  // Start monitoring
  setTimeout(check, 1000);
}

export const codingAgentTools = [
  spawnCodingAgentTool,
  codingAgentStatusTool,
  killCodingAgentTool,
  listCodingAgentsTool,
];
