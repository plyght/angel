import type { Tool, ToolContext, ToolResult } from "./registry";

const BLOCKED_HARD: [RegExp, string][] = [
  [/rm\s+(-rf?|--recursive)\s+[/~]/, "recursive rm on root/home"],
  [/rm\s+(-rf?|--recursive)\s+\.\.\/?/, "recursive rm on parent directory"],
  [/>\s*\/dev\/sd/, "write to block device"],
  [/mkfs\./, "format filesystem"],
  [/dd\s+if=/, "raw disk write"],
  [/chmod\s+(-R\s+)?[0-7]*777\s+[/~]/, "chmod 777 on root/home"],
  [/chown\s+-R\s+.*\s+[/~]/, "recursive chown on root/home"],
  [/:\(\)\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/>\s*\/etc\//, "overwrite system config"],
  [/>\s*\/System\//, "overwrite macOS system files"],
  [/launchctl\s+unload/, "unload system services"],
  [
    /systemctl\s+(stop|disable|mask)\s+(sshd|firewalld|ufw)/,
    "disable security services",
  ],
  [/iptables\s+-F/, "flush firewall rules"],
  [/pfctl\s+-d/, "disable macOS firewall"],
  [/sudo\s+visudo/, "edit sudoers"],
  [/passwd/, "change passwords"],
  [/security\s+(delete|remove)-keychain/, "delete keychain"],
  [/security\s+dump-keychain/, "dump keychain"],
  [
    /security\s+find-(generic|internet)-password\s.*-w/,
    "extract keychain passwords",
  ],
  [/cat\s+.*angel\.config/, "read angel config"],
  [/cat\s+.*\/\.env/, "read env file"],
  [/cat\s+.*id_rsa/, "read SSH private key"],
  [/cat\s+.*\.pem/, "read private key"],
  [/cat\s+.*credentials/, "read credentials file"],
  [/printenv|env\s*$|env\s*\|/, "dump all environment variables"],
  [/set\s*$|set\s*\|/, "dump shell variables"],
  [/export\s+-p\s*\|/, "dump exported variables"],
  [
    /curl\s+.*(-d|--data|--data-binary|--upload-file)\s/,
    "curl with outbound data",
  ],
  [/curl\s+.*-X\s*(POST|PUT|PATCH)\s/, "curl with write method"],
  [/wget\s+.*--post/, "wget with POST data"],
  [/nc\s+-/, "netcat"],
  [/ncat\s/, "ncat"],
  [/socat\s/, "socat"],
  [/ssh\s+.*@/, "SSH to remote host"],
  [/scp\s/, "SCP file transfer"],
  [/rsync\s+.*:/, "rsync to remote"],
  [/git\s+push/, "git push"],
  [/git\s+remote\s+add/, "add git remote"],
  [/base64\s+.*\|\s*(curl|wget|nc)/, "encode and exfiltrate"],
  [/\|\s*(curl|wget|nc|ssh)/, "pipe to network tool"],
  [/open\s+.*https?:/, "open URL in browser"],
  [/osascript/, "run AppleScript"],
  [
    /pkill\s+-9\s+(Finder|loginwindow|SystemUIServer|WindowServer)/,
    "kill critical macOS processes",
  ],
  [/kill\s+-9\s+1\b/, "kill init/launchd"],
  [/diskutil\s+(erase|partition|unmount)/, "disk operations"],
  [/hdiutil\s+(eject|detach)/, "disk image operations"],
  [/dscl\s/, "directory service changes"],
  [/defaults\s+write\s+.*LoginwindowText/, "modify login screen"],
  [/crontab\s+-r/, "remove all cron jobs"],
  [/xattr\s+-cr\s+\//, "strip quarantine from root"],
  [/spctl\s+--master-disable/, "disable Gatekeeper"],
];

const BLOCKED_SECRETS_IN_OUTPUT = [
  /sk-[a-zA-Z0-9]{20,}/,
  /xoxb-[a-zA-Z0-9-]+/,
  /xapp-[a-zA-Z0-9-]+/,
  /ghp_[a-zA-Z0-9]{36}/,
  /gho_[a-zA-Z0-9]{36}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function scrubSecrets(output: string): string {
  let scrubbed = output;
  for (const pattern of BLOCKED_SECRETS_IN_OUTPUT) {
    scrubbed = scrubbed.replace(new RegExp(pattern.source, "g"), "[REDACTED]");
  }
  return scrubbed;
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command. Returns stdout and stderr. Use for system operations, running scripts, git commands, etc. Some dangerous commands are blocked for safety. Secrets in output are automatically redacted.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout_ms: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000, max: 300000)",
      },
    },
    required: ["command"],
  },
  risk: "high",

  async execute(
    input: { command: string; timeout_ms?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const timeout = Math.min(input.timeout_ms || 30000, 300000);

    for (const [pattern, reason] of BLOCKED_HARD) {
      if (pattern.test(input.command)) {
        return { output: `Blocked: ${reason}`, isError: true };
      }
    }

    try {
      const proc = Bun.spawn(["bash", "-c", input.command], {
        cwd: ctx.workingDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: process.env.HOME || "" },
      });

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
        metadata: { exitCode },
      };
    } catch (err: any) {
      return { output: `Execution error: ${err.message}`, isError: true };
    }
  },
};
