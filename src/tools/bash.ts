import type { Tool, ToolContext, ToolResult } from "./registry";

export const bashTool: Tool = {
  name: "bash",
  description: "Execute a shell command. Returns stdout and stderr. Use for system operations, running scripts, git commands, etc.",
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

  async execute(input: { command: string; timeout_ms?: number }, ctx: ToolContext): Promise<ToolResult> {
    const timeout = Math.min(input.timeout_ms || 30000, 300000);

    const blockedPatterns = [
      /rm\s+(-rf?|--recursive)\s+[\/~]/,
      />\s*\/dev\/sd/,
      /mkfs\./,
      /dd\s+if=/,
    ];

    for (const pattern of blockedPatterns) {
      if (pattern.test(input.command)) {
        return { output: `Blocked: dangerous command pattern detected`, isError: true };
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
