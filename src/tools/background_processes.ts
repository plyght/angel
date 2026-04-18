import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { Tool, ToolContext, ToolResult } from "./registry";

export interface BackgroundProcess {
  id: number;
  command: string;
  args: string[];
  cwd: string;
  status: "running" | "stopped" | "failed";
  startedAt: Date;
  stoppedAt?: Date;
  process: ReturnType<typeof Bun.spawn> | null;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  chatId: number;
  channel: string;
  externalChatId: string;
  name?: string;
  // Circular buffer for recent output (keeps memory bounded)
  outputBuffer: string[];
  maxOutputLines: number;
}

const runningProcesses: Map<number, BackgroundProcess> = new Map();
let nextId = 1;

// Notifier for when processes exit
let notifyFn:
  | ((proc: BackgroundProcess, message: string) => Promise<void>)
  | null = null;

export function setBackgroundProcessNotifier(
  fn: (proc: BackgroundProcess, message: string) => Promise<void>,
) {
  notifyFn = fn;
}

async function notify(proc: BackgroundProcess, message: string) {
  if (notifyFn) {
    try {
      await notifyFn(proc, message);
    } catch {}
  }
}

// Blocked patterns for safety (reuse from bash.ts philosophy)
const BLOCKED_PATTERNS: [RegExp, string][] = [
  [/rm\s+(-rf?|--recursive)\s+[/~]/, "recursive rm on root/home"],
  [/rm\s+(-rf?|--recursive)\s+\.\.\/?/, "recursive rm on parent directory"],
  [/>\s*\/dev\/sd/, "write to block device"],
  [/mkfs\./, "format filesystem"],
  [/dd\s+if=/, "raw disk write"],
  [/chmod\s+(-R\s+)?[0-7]*777\s+[/~]/, "chmod 777 on root/home"],
  [/:\(\)\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/>\s*\/etc\//, "overwrite system config"],
];

function isCommandBlocked(command: string): string | null {
  for (const [pattern, reason] of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}

// Secret scrubbing for output
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /xoxb-[a-zA-Z0-9-]+/g,
  /xapp-[a-zA-Z0-9-]+/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed;
}

export const spawnBackgroundProcessTool: Tool = {
  name: "spawn_background_process",
  description: `Start a long-running background process like a dev server, file watcher, or build tool. The process runs in the background and you can check its status or output later. Use this for processes that need to keep running (servers, watchers) rather than one-shot commands. The user is notified when the process exits.`,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The command to run (e.g., 'npm', 'python', 'node', 'cargo')",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description:
          "Arguments to pass to the command (e.g., ['run', 'dev'] for 'npm run dev')",
      },
      working_dir: {
        type: "string",
        description:
          "Directory to run the process in (defaults to current working dir)",
      },
      name: {
        type: "string",
        description:
          "Optional friendly name for this process (e.g., 'frontend-dev-server')",
      },
      env: {
        type: "object",
        description:
          "Optional additional environment variables to set (merged with current env)",
      },
    },
    required: ["command"],
  },
  risk: "high",

  async execute(
    input: {
      command: string;
      args?: string[];
      working_dir?: string;
      name?: string;
      env?: Record<string, string>;
    },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const fullCommand = [input.command, ...(input.args || [])].join(" ");
    const blocked = isCommandBlocked(fullCommand);
    if (blocked) {
      return { output: `Blocked: ${blocked}`, isError: true };
    }

    let cwd = input.working_dir || ctx.workingDir;
    if (cwd.startsWith("~")) cwd = cwd.replace("~", process.env.HOME || "");

    const chatRow = ctx.db
      ?.query("SELECT external_chat_id FROM chats WHERE id = ?")
      .get(ctx.chatId) as any;
    const externalChatId = chatRow?.external_chat_id || "";

    const id = nextId++;
    const entry: BackgroundProcess = {
      id,
      command: input.command,
      args: input.args || [],
      cwd,
      status: "running",
      startedAt: new Date(),
      process: null,
      stdout: "",
      stderr: "",
      chatId: ctx.chatId,
      channel: ctx.channel,
      externalChatId,
      name: input.name,
      outputBuffer: [],
      maxOutputLines: 1000, // Keep last 1000 lines in memory
    };
    runningProcesses.set(id, entry);

    try {
      const proc = Bun.spawn([input.command, ...(input.args || [])], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: process.env.HOME || "",
          TERM: "dumb",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          ...(input.env || {}),
        },
      });
      entry.process = proc;

      // Collect stdout with bounded buffer
      (async () => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            entry.stdout += text;
            // Add to circular buffer
            const lines = text.split("\n");
            for (const line of lines) {
              if (line) {
                entry.outputBuffer.push(scrubSecrets(line));
                if (entry.outputBuffer.length > entry.maxOutputLines) {
                  entry.outputBuffer.shift();
                }
              }
            }
          }
        } catch {}
      })();

      // Collect stderr
      (async () => {
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            entry.stderr += text;
            // Also add stderr to output buffer (prefixed)
            const lines = text.split("\n");
            for (const line of lines) {
              if (line) {
                entry.outputBuffer.push(`[stderr] ${scrubSecrets(line)}`);
                if (entry.outputBuffer.length > entry.maxOutputLines) {
                  entry.outputBuffer.shift();
                }
              }
            }
          }
        } catch {}
      })();

      // Monitor for exit
      (async () => {
        try {
          await proc.exited;
          entry.exitCode = proc.exitCode;
          entry.stoppedAt = new Date();
          const duration = formatDuration(
            entry.stoppedAt.getTime() - entry.startedAt.getTime(),
          );

          if (proc.exitCode === 0) {
            entry.status = "stopped";
            const displayName = entry.name || `${entry.command} (${entry.id})`;
            notify(
              entry,
              `Process "${displayName}" exited cleanly after ${duration}.`,
            );
          } else {
            entry.status = "failed";
            const displayName = entry.name || `${entry.command} (${entry.id})`;
            const recentOutput = entry.outputBuffer.slice(-10).join("\n");
            notify(
              entry,
              `Process "${displayName}" exited with code ${proc.exitCode} after ${duration}.\n\nRecent output:\n${recentOutput || "(no output)"}`,
            );
          }
        } catch (err: any) {
          entry.status = "failed";
          entry.stoppedAt = new Date();
          const displayName = entry.name || `${entry.command} (${entry.id})`;
          notify(entry, `Process "${displayName}" crashed: ${err.message}`);
        }
      })();
    } catch (err: any) {
      entry.status = "failed";
      entry.stoppedAt = new Date();
      runningProcesses.set(id, entry);
      return {
        output: `Failed to spawn process: ${err.message}`,
        isError: true,
      };
    }

    const displayName = input.name ? `"${input.name}"` : `#${id}`;
    return {
      output: `Started background process ${displayName} (id: ${id})\nCommand: ${fullCommand}\nWorking dir: ${cwd}\n\nUse background_process_output to check its output, or stop_background_process to terminate it.`,
      metadata: { processId: id },
    };
  },
};

export const backgroundProcessOutputTool: Tool = {
  name: "background_process_output",
  description:
    "Get recent output from a running or completed background process. Returns the last N lines from the output buffer.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "Process ID to check",
      },
      lines: {
        type: "number",
        description: "Number of recent lines to return (default: 50, max: 500)",
      },
      include_stderr: {
        type: "boolean",
        description:
          "Whether to include stderr in output (default: true, stderr lines are prefixed with [stderr])",
      },
    },
    required: ["id"],
  },
  risk: "low",

  async execute(input: {
    id: number;
    lines?: number;
    include_stderr?: boolean;
  }): Promise<ToolResult> {
    const entry = runningProcesses.get(input.id);
    if (!entry) {
      return {
        output: `No process found with id #${input.id}`,
        isError: true,
      };
    }

    const numLines = Math.min(input.lines || 50, 500);
    const includeStderr = input.include_stderr !== false;

    let outputLines = entry.outputBuffer;
    if (!includeStderr) {
      outputLines = outputLines.filter((l) => !l.startsWith("[stderr]"));
    }

    const recent = outputLines.slice(-numLines);
    const status = formatProcessStatus(entry);

    return {
      output: `${status}\n\n--- Recent output (${recent.length} lines) ---\n${recent.join("\n") || "(no output yet)"}`,
    };
  },
};

export const listBackgroundProcessesTool: Tool = {
  name: "list_background_processes",
  description:
    "List all background processes (running and recently stopped) in this chat or all chats.",
  parameters: {
    type: "object",
    properties: {
      all_chats: {
        type: "boolean",
        description:
          "If true, show processes from all chats. Default: only current chat.",
      },
      include_stopped: {
        type: "boolean",
        description:
          "If true, include stopped/failed processes. Default: true.",
      },
    },
  },
  risk: "low",

  async execute(
    input: { all_chats?: boolean; include_stopped?: boolean },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const includeStopped = input.include_stopped !== false;

    let processes = [...runningProcesses.values()];

    // Filter by chat unless all_chats requested
    if (!input.all_chats) {
      processes = processes.filter((p) => p.chatId === ctx.chatId);
    }

    // Filter out stopped if requested
    if (!includeStopped) {
      processes = processes.filter((p) => p.status === "running");
    }

    // Sort by ID (most recent first)
    processes.sort((a, b) => b.id - a.id);

    if (processes.length === 0) {
      return {
        output: "No background processes found.",
      };
    }

    const summaries = processes.map((p) => {
      const displayName = p.name ? `"${p.name}"` : `#${p.id}`;
      const cmd = [p.command, ...p.args].join(" ").slice(0, 60);
      const duration = formatDuration(
        (p.stoppedAt || new Date()).getTime() - p.startedAt.getTime(),
      );
      const statusIcon =
        p.status === "running" ? "🟢" : p.status === "stopped" ? "⚪" : "🔴";
      return `${statusIcon} ${displayName} (id: ${p.id}) [${p.status}] - ${cmd} (${duration})`;
    });

    return {
      output: `Background processes:\n\n${summaries.join("\n")}`,
    };
  },
};

export const stopBackgroundProcessTool: Tool = {
  name: "stop_background_process",
  description:
    "Stop a running background process by sending it SIGTERM (graceful) or SIGKILL (force).",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "Process ID to stop",
      },
      force: {
        type: "boolean",
        description:
          "If true, use SIGKILL instead of SIGTERM. Default: false (graceful shutdown).",
      },
    },
    required: ["id"],
  },
  risk: "medium",

  async execute(input: { id: number; force?: boolean }): Promise<ToolResult> {
    const entry = runningProcesses.get(input.id);
    if (!entry) {
      return {
        output: `No process found with id #${input.id}`,
        isError: true,
      };
    }

    if (entry.status !== "running") {
      return {
        output: `Process #${input.id} is already ${entry.status}`,
      };
    }

    try {
      const signal = input.force ? "SIGKILL" : "SIGTERM";
      entry.process?.kill(signal as any);

      // Give it a moment to terminate
      await new Promise((r) => setTimeout(r, 100));

      const displayName = entry.name ? `"${entry.name}"` : `#${input.id}`;
      return {
        output: `Sent ${signal} to process ${displayName}. It should terminate shortly.`,
      };
    } catch (err: any) {
      return {
        output: `Failed to stop process #${input.id}: ${err.message}`,
        isError: true,
      };
    }
  },
};

export const sendProcessInputTool: Tool = {
  name: "send_process_input",
  description:
    "Send input (stdin) to a running background process. Useful for interactive processes that accept commands.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "Process ID to send input to",
      },
      input: {
        type: "string",
        description:
          "Text to send to the process stdin (newline added automatically unless raw=true)",
      },
      raw: {
        type: "boolean",
        description: "If true, don't add newline to input. Default: false.",
      },
    },
    required: ["id", "input"],
  },
  risk: "medium",

  async execute(input: {
    id: number;
    input: string;
    raw?: boolean;
  }): Promise<ToolResult> {
    const entry = runningProcesses.get(input.id);
    if (!entry) {
      return {
        output: `No process found with id #${input.id}`,
        isError: true,
      };
    }

    if (entry.status !== "running") {
      return {
        output: `Process #${input.id} is not running (status: ${entry.status})`,
        isError: true,
      };
    }

    if (!entry.process?.stdin) {
      return {
        output: `Process #${input.id} does not have stdin available`,
        isError: true,
      };
    }

    try {
      const text = input.raw ? input.input : input.input + "\n";
      const writer = entry.process.stdin.getWriter();
      await writer.write(new TextEncoder().encode(text));
      writer.releaseLock();

      return {
        output: `Sent ${text.length} bytes to process #${input.id}`,
      };
    } catch (err: any) {
      return {
        output: `Failed to send input to process #${input.id}: ${err.message}`,
        isError: true,
      };
    }
  },
};

function formatProcessStatus(entry: BackgroundProcess): string {
  const displayName = entry.name ? `"${entry.name}"` : `#${entry.id}`;
  const cmd = [entry.command, ...entry.args].join(" ");
  const duration = formatDuration(
    (entry.stoppedAt || new Date()).getTime() - entry.startedAt.getTime(),
  );

  const lines = [
    `Process ${displayName} (id: ${entry.id})`,
    `Status: ${entry.status.toUpperCase()}`,
    `Command: ${cmd}`,
    `Working dir: ${entry.cwd}`,
    `Running for: ${duration}`,
  ];

  if (entry.exitCode !== undefined && entry.exitCode !== null) {
    lines.push(`Exit code: ${entry.exitCode}`);
  }

  if (entry.process?.pid) {
    lines.push(`PID: ${entry.process.pid}`);
  }

  return lines.join("\n");
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

// Kill all running processes (for graceful shutdown)
export function killAllBackgroundProcesses() {
  for (const entry of runningProcesses.values()) {
    if (entry.status === "running") {
      try {
        entry.process?.kill("SIGTERM");
      } catch {}
      entry.status = "stopped";
      entry.stoppedAt = new Date();
    }
  }
}

// Clear all processes from memory (for testing)
export function clearAllBackgroundProcesses() {
  killAllBackgroundProcesses();
  runningProcesses.clear();
}

// Persistence for surviving restarts
interface PersistedProcess {
  id: number;
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  chatId: number;
  channel: string;
  externalChatId: string;
  name?: string;
}

let dataDir: string | null = null;

export function setBackgroundProcessDataDir(dir: string) {
  dataDir = dir;
}

function getProcessesFilePath(): string | null {
  if (!dataDir) return null;
  return join(dataDir, "background_processes.json");
}

export function persistBackgroundProcesses(): number {
  const path = getProcessesFilePath();
  if (!path) return 0;

  const toPersist: PersistedProcess[] = [];
  for (const entry of runningProcesses.values()) {
    if (entry.status === "running" && entry.process?.pid) {
      toPersist.push({
        id: entry.id,
        pid: entry.process.pid,
        command: entry.command,
        args: entry.args,
        cwd: entry.cwd,
        startedAt: entry.startedAt.toISOString(),
        chatId: entry.chatId,
        channel: entry.channel,
        externalChatId: entry.externalChatId,
        name: entry.name,
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

export function restoreBackgroundProcesses(): number {
  const path = getProcessesFilePath();
  if (!path || !existsSync(path)) return 0;

  let persisted: PersistedProcess[];
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
    const entry: BackgroundProcess = {
      id: p.id,
      command: p.command,
      args: p.args,
      cwd: p.cwd,
      status: "running",
      startedAt: new Date(p.startedAt),
      process: null,
      stdout: "(output unavailable - restored after restart)",
      stderr: "",
      chatId: p.chatId,
      channel: p.channel,
      externalChatId: p.externalChatId,
      name: p.name,
      outputBuffer: [
        "(process restored after Angel restart - previous output not available)",
      ],
      maxOutputLines: 1000,
    };

    runningProcesses.set(p.id, entry);
    restored++;

    // Monitor the PID for completion
    monitorPid(p.pid, entry);
  }

  return restored;
}

function monitorPid(pid: number, entry: BackgroundProcess) {
  const check = () => {
    try {
      process.kill(pid, 0);
      // Still running, check again in 5 seconds
      setTimeout(check, 5000);
    } catch {
      // Process exited
      entry.stoppedAt = new Date();
      const duration = formatDuration(
        entry.stoppedAt.getTime() - entry.startedAt.getTime(),
      );

      // We don't know the exit code, assume clean exit if it ran this long
      entry.status = "stopped";
      const displayName = entry.name || `${entry.command} (${entry.id})`;
      notify(
        entry,
        `Process "${displayName}" exited after ${duration}.\n\n(Process was running during restart, output not available)`,
      );
    }
  };

  // Start monitoring
  setTimeout(check, 1000);
}

// Get count of running processes
export function getRunningProcessCount(): number {
  let count = 0;
  for (const entry of runningProcesses.values()) {
    if (entry.status === "running") count++;
  }
  return count;
}

export const backgroundProcessTools = [
  spawnBackgroundProcessTool,
  backgroundProcessOutputTool,
  listBackgroundProcessesTool,
  stopBackgroundProcessTool,
  sendProcessInputTool,
];
