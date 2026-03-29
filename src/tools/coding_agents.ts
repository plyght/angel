import type { Tool, ToolContext, ToolResult } from "./registry";

interface AgentDef {
  command: string;
  buildArgs: (prompt: string, opts: { workingDir: string; model?: string }) => string[];
  detect: () => Promise<string | null>;
  installHint: string;
}

const AGENTS: Record<string, AgentDef> = {
  claude: {
    command: "claude",
    buildArgs: (prompt, opts) => {
      const args = ["-p", "--output-format", "json", "--max-turns", "50", "--dangerously-skip-permissions"];
      if (opts.model) args.push("--model", opts.model);
      args.push(prompt);
      return args;
    },
    detect: () => which("claude"),
    installHint: "Install: bun add -g @anthropic-ai/claude-code",
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
      const args = ["--yes", "--no-auto-commits", "--no-pretty", "--message", prompt];
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
    return out || null;
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
}

const runningAgents: Map<number, RunningAgent> = new Map();
let nextId = 1;

let notifyFn: ((agent: RunningAgent, message: string) => Promise<void>) | null = null;

export function setCodingAgentNotifier(fn: (agent: RunningAgent, message: string) => Promise<void>) {
  notifyFn = fn;
}

async function notify(agent: RunningAgent, message: string) {
  if (notifyFn) {
    try { await notifyFn(agent, message); } catch {}
  }
}

export const spawnCodingAgentTool: Tool = {
  name: "spawn_coding_agent",
  description: `Spawn an external coding agent (claude, codex, aider, goose, amp) to work on a task in the background. The user is automatically notified when it finishes.`,
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
        description: "Directory to run the agent in (defaults to current working dir)",
      },
      model: {
        type: "string",
        description: "Model override for the agent (optional, agent-specific)",
      },
    },
    required: ["agent", "prompt"],
  },
  risk: "high",

  async execute(input: { agent: string; prompt: string; working_dir?: string; model?: string }, ctx: ToolContext): Promise<ToolResult> {
    const def = AGENTS[input.agent];
    if (!def) {
      return { output: `Unknown agent: ${input.agent}. Available: ${Object.keys(AGENTS).join(", ")}`, isError: true };
    }

    const path = await def.detect();
    if (!path) {
      return {
        output: `${input.agent} is not installed.\n${def.installHint}`,
        isError: true,
      };
    }

    const cwd = input.working_dir || ctx.workingDir;
    const args = def.buildArgs(input.prompt, { workingDir: cwd, model: input.model });

    const chatRow = ctx.db?.query("SELECT external_chat_id FROM chats WHERE id = ?").get(ctx.chatId) as any;
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
    };
    runningAgents.set(id, entry);

    try {
      const proc = Bun.spawn([def.command, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
      });
      entry.process = proc;

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
          const duration = formatDuration(entry.finishedAt.getTime() - entry.startedAt.getTime());

          if (proc.exitCode === 0) {
            entry.status = "completed";
            const summary = extractSummary(entry.agent, entry.stdout.trim());
            notify(entry, `Done — ${entry.agent} finished in ${duration}.\n\n${summary || "No output."}`);
          } else {
            entry.status = "failed";
            const errOutput = extractSummary(entry.agent, (entry.stderr || entry.stdout).trim());
            notify(entry, `${entry.agent} failed (exit ${proc.exitCode}, ${duration}).\n\n${errOutput || "No output."}`);
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
      return { output: `Failed to spawn ${input.agent}: ${err.message}`, isError: true };
    }

    return {
      output: `Spawned ${input.agent} #${id} in background. User will be notified on completion.`,
    };
  },
};

export const codingAgentStatusTool: Tool = {
  name: "coding_agent_status",
  description: "Check status and recent output of running or completed coding agents.",
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
      if (!entry) return { output: `No agent found with id #${input.id}`, isError: true };
      return { output: formatAgentStatus(entry, tailLen) };
    }

    if (runningAgents.size === 0) return { output: "No coding agents have been spawned." };

    const sorted = [...runningAgents.values()].sort((a, b) => b.id - a.id);
    return {
      output: sorted.map((e) => formatAgentStatus(e, tailLen)).join("\n\n---\n\n"),
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
    if (!entry) return { output: `No agent found with id #${input.id}`, isError: true };
    if (entry.status !== "running") return { output: `Agent #${input.id} is already ${entry.status}` };

    try {
      entry.process?.kill();
      entry.status = "failed";
      entry.finishedAt = new Date();
      return { output: `Agent #${input.id} (${entry.agent}) killed.` };
    } catch (err: any) {
      return { output: `Failed to kill agent #${input.id}: ${err.message}`, isError: true };
    }
  },
};

export const listCodingAgentsTool: Tool = {
  name: "list_coding_agents",
  description: "List available external coding agents and whether they are installed.",
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
  const elapsed = formatDuration((entry.finishedAt || new Date()).getTime() - entry.startedAt.getTime());
  const lines = [
    `#${entry.id} [${entry.status.toUpperCase()}] ${entry.agent}`,
    `Prompt: ${entry.prompt.slice(0, 200)}`,
    `Dir: ${entry.cwd}`,
    `Duration: ${elapsed}`,
  ];

  if (entry.exitCode !== undefined && entry.exitCode !== null) {
    lines.push(`Exit code: ${entry.exitCode}`);
  }

  const output = entry.stdout.trim();
  if (output) {
    const tail = output.length > tailLen ? "...\n" + output.slice(-tailLen) : output;
    lines.push(`\nOutput:\n${tail}`);
  }

  const errors = entry.stderr.trim();
  if (errors) {
    const tail = errors.length > tailLen ? "...\n" + errors.slice(-tailLen) : errors;
    lines.push(`\nStderr:\n${tail}`);
  }

  return lines.join("\n");
}

function extractSummary(agent: string, raw: string): string {
  if (!raw) return "";

  if (agent === "claude") {
    try {
      const json = JSON.parse(raw);
      const meta: string[] = [];
      if (json.is_error) meta.push("[error]");
      if (json.total_cost_usd) meta.push(`Cost: $${json.total_cost_usd.toFixed(4)}`);
      if (json.num_turns) meta.push(`${json.num_turns} turns`);
      if (json.duration_ms) meta.push(formatDuration(json.duration_ms));
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

export const codingAgentTools = [spawnCodingAgentTool, codingAgentStatusTool, killCodingAgentTool];
