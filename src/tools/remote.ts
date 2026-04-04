import type { Tool, ToolContext, ToolResult } from "./registry";
import { loadConfig } from "../config";

function getRemoteConfig() {
  const cfg = loadConfig();
  return {
    host: cfg.remote?.tailscale_host,
    bin: cfg.remote?.tailscale_bin || "tailscale",
  };
}

const BLOCKED_REMOTE: [RegExp, string][] = [
  [/rm\s+(-rf?|--recursive)\s+[/~]/, "recursive rm on root/home"],
  [/mkfs\./, "format filesystem"],
  [/dd\s+if=/, "raw disk write"],
  [/chmod\s+(-R\s+)?[0-7]*777\s+[/~]/, "chmod 777 on root/home"],
  [/:\(\)\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/>\s*\/etc\//, "overwrite system config"],
  [/>\s*\/System\//, "overwrite macOS system files"],
  [/security\s+(delete|remove)-keychain/, "delete keychain"],
  [/security\s+dump-keychain/, "dump keychain"],
  [
    /security\s+find-(generic|internet)-password\s.*-w/,
    "extract keychain passwords",
  ],
  [/cat\s+.*\.env/, "read env file"],
  [/cat\s+.*id_rsa/, "read SSH private key"],
  [/cat\s+.*\.pem/, "read private key"],
  [/cat\s+.*credentials/, "read credentials file"],
  [/diskutil\s+(erase|partition|unmount)/, "disk operations"],
  [/spctl\s+--master-disable/, "disable Gatekeeper"],
  [/pfctl\s+-d/, "disable macOS firewall"],
  [/passwd/, "change passwords"],
  [/sudo\s+visudo/, "edit sudoers"],
];

const BLOCKED_SECRETS_IN_OUTPUT = [
  /sk-[a-zA-Z0-9]{20,}/,
  /xoxb-[a-zA-Z0-9-]+/,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function scrubSecrets(output: string): string {
  let scrubbed = output;
  for (const pattern of BLOCKED_SECRETS_IN_OUTPUT) {
    scrubbed = scrubbed.replace(new RegExp(pattern.source, "g"), "[REDACTED]");
  }
  return scrubbed;
}

export const remoteStatusTool: Tool = {
  name: "remote_status",
  description:
    "Check if the configured remote machine is online on the Tailscale network. Always call this before attempting remote_exec. Returns online/offline status and latency. Requires remote.tailscale_host to be configured.",
  parameters: {
    type: "object",
    properties: {},
  },
  risk: "low",

  async execute(_input: any, _ctx: ToolContext): Promise<ToolResult> {
    const { host, bin } = getRemoteConfig();

    if (!host) {
      return {
        output:
          "Remote host not configured. Set remote.tailscale_host in your config file.",
        isError: true,
      };
    }

    try {
      const proc = Bun.spawn(
        [bin, "ping", "--timeout=3s", "-c", "1", host],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const timer = setTimeout(() => proc.kill(), 5000);

      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      clearTimeout(timer);
      const exitCode = await proc.exited;

      if (exitCode === 0 && stdout.includes("pong")) {
        const latencyMatch = stdout.match(/in\s+([\d.]+)ms/);
        const latency = latencyMatch ? latencyMatch[1] + "ms" : "unknown";
        return { output: `online — ${host} responded in ${latency}` };
      }

      return {
        output: `offline — ${host} is not reachable on the tailnet`,
        metadata: { online: false },
      };
    } catch (err: any) {
      return {
        output: `offline — tailscale ping failed: ${err.message}`,
        isError: true,
      };
    }
  },
};

export const remoteExecTool: Tool = {
  name: "remote_exec",
  description:
    "Execute a command on the configured remote machine via Tailscale SSH. The machine must be online — check with remote_status first. Use this when asked to do something on the remote machine: run commands, read files, check system state, etc. Some dangerous commands are blocked. Requires remote.tailscale_host to be configured.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute on the remote machine",
      },
      timeout_ms: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000, max: 120000)",
      },
    },
    required: ["command"],
  },
  risk: "high",

  async execute(
    input: { command: string; timeout_ms?: number },
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const { host, bin } = getRemoteConfig();

    if (!host) {
      return {
        output:
          "Remote host not configured. Set remote.tailscale_host in your config file.",
        isError: true,
      };
    }

    const timeout = Math.min(input.timeout_ms || 30000, 120000);

    for (const [pattern, reason] of BLOCKED_REMOTE) {
      if (pattern.test(input.command)) {
        return { output: `Blocked: ${reason}`, isError: true };
      }
    }

    try {
      const proc = Bun.spawn(
        [bin, "ssh", host, "--", input.command],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const timer = setTimeout(() => proc.kill(), timeout);

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      clearTimeout(timer);
      const exitCode = await proc.exited;

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += (output ? "\n" : "") + `stderr: ${stderr}`;
      if (!output) output = `(exit code: ${exitCode})`;

      output = scrubSecrets(output);

      return {
        output: output.slice(0, 50000),
        isError: exitCode !== 0,
        metadata: { exitCode, host },
      };
    } catch (err: any) {
      return {
        output: `Remote execution error: ${err.message}`,
        isError: true,
      };
    }
  },
};

export const remoteTools = [remoteStatusTool, remoteExecTool];
