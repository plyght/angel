import type { Tool, ToolContext, ToolResult } from "./registry";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve, relative } from "path";
import { Glob } from "bun";

const BLOCKED_PATHS = [".ssh", ".aws", ".gnupg", "credentials", ".env", "angel.config", ".angel/angel.config"];

function isPathBlocked(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return BLOCKED_PATHS.some((p) => normalized.includes(p));
}

function resolvePath(ctx: ToolContext, filePath: string): string {
  if (filePath.startsWith("/")) return filePath;
  return join(ctx.workingDir, filePath);
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Returns the file content as text.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to working directory)" },
      offset: { type: "number", description: "Line number to start reading from (1-based)" },
      limit: { type: "number", description: "Number of lines to read" },
    },
    required: ["path"],
  },
  risk: "low",

  async execute(input: { path: string; offset?: number; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
    const fullPath = resolvePath(ctx, input.path);
    if (isPathBlocked(fullPath)) return { output: "Access denied: sensitive path", isError: true };
    if (!existsSync(fullPath)) return { output: `File not found: ${input.path}`, isError: true };

    try {
      let content = readFileSync(fullPath, "utf-8");
      if (input.offset || input.limit) {
        const lines = content.split("\n");
        const start = (input.offset || 1) - 1;
        const end = input.limit ? start + input.limit : lines.length;
        content = lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join("\n");
      }
      return { output: content.slice(0, 100000) };
    } catch (err: any) {
      return { output: `Read error: ${err.message}`, isError: true };
    }
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file. Creates the file and parent directories if they don't exist.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  risk: "medium",

  async execute(input: { path: string; content: string }, ctx: ToolContext): Promise<ToolResult> {
    const fullPath = resolvePath(ctx, input.path);
    if (isPathBlocked(fullPath)) return { output: "Access denied: sensitive path", isError: true };

    try {
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, input.content, "utf-8");
      return { output: `Written ${input.content.length} bytes to ${input.path}` };
    } catch (err: any) {
      return { output: `Write error: ${err.message}`, isError: true };
    }
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description: "Edit a file by replacing an exact string match with new content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Exact string to find and replace" },
      new_string: { type: "string", description: "Replacement string" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default: false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  risk: "medium",

  async execute(input: { path: string; old_string: string; new_string: string; replace_all?: boolean }, ctx: ToolContext): Promise<ToolResult> {
    const fullPath = resolvePath(ctx, input.path);
    if (isPathBlocked(fullPath)) return { output: "Access denied: sensitive path", isError: true };
    if (!existsSync(fullPath)) return { output: `File not found: ${input.path}`, isError: true };

    try {
      let content = readFileSync(fullPath, "utf-8");
      if (!content.includes(input.old_string)) {
        return { output: "old_string not found in file", isError: true };
      }

      if (input.replace_all) {
        content = content.split(input.old_string).join(input.new_string);
      } else {
        content = content.replace(input.old_string, input.new_string);
      }

      writeFileSync(fullPath, content, "utf-8");
      return { output: `Edited ${input.path}` };
    } catch (err: any) {
      return { output: `Edit error: ${err.message}`, isError: true };
    }
  },
};

export const globTool: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern. Returns matching file paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts', 'src/**/*.js')" },
      path: { type: "string", description: "Directory to search in (default: working directory)" },
    },
    required: ["pattern"],
  },
  risk: "low",

  async execute(input: { pattern: string; path?: string }, ctx: ToolContext): Promise<ToolResult> {
    const searchDir = input.path ? resolvePath(ctx, input.path) : ctx.workingDir;
    try {
      const glob = new Glob(input.pattern);
      const matches: string[] = [];
      for await (const file of glob.scan({ cwd: searchDir, absolute: false })) {
        matches.push(file);
        if (matches.length >= 500) break;
      }
      return { output: matches.length > 0 ? matches.join("\n") : "No matches found" };
    } catch (err: any) {
      return { output: `Glob error: ${err.message}`, isError: true };
    }
  },
};

export const grepTool: Tool = {
  name: "grep",
  description: "Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "File or directory to search" },
      glob: { type: "string", description: "Glob to filter files (e.g., '*.ts')" },
      max_results: { type: "number", description: "Maximum results (default: 50)" },
    },
    required: ["pattern"],
  },
  risk: "low",

  async execute(input: { pattern: string; path?: string; glob?: string; max_results?: number }, ctx: ToolContext): Promise<ToolResult> {
    const searchPath = input.path ? resolvePath(ctx, input.path) : ctx.workingDir;
    const maxResults = input.max_results || 50;

    try {
      const args = ["rg", "--no-heading", "--line-number", "--max-count", String(maxResults)];
      if (input.glob) args.push("--glob", input.glob);
      args.push(input.pattern, searchPath);

      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      return { output: stdout || stderr || "No matches found" };
    } catch {
      try {
        const regex = new RegExp(input.pattern, "g");
        const results: string[] = [];

        function searchFile(filePath: string) {
          if (results.length >= maxResults) return;
          try {
            const content = readFileSync(filePath, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(`${relative(ctx.workingDir, filePath)}:${i + 1}:${lines[i]}`);
                regex.lastIndex = 0;
                if (results.length >= maxResults) return;
              }
            }
          } catch {}
        }

        function walkDir(dir: string) {
          if (results.length >= maxResults) return;
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            try {
              const stat = statSync(full);
              if (stat.isDirectory() && !entry.startsWith(".") && entry !== "node_modules") {
                walkDir(full);
              } else if (stat.isFile()) {
                searchFile(full);
              }
            } catch {}
          }
        }

        const stat = statSync(searchPath);
        if (stat.isFile()) searchFile(searchPath);
        else walkDir(searchPath);

        return { output: results.length > 0 ? results.join("\n") : "No matches found" };
      } catch (err: any) {
        return { output: `Grep error: ${err.message}`, isError: true };
      }
    }
  },
};

export const fileTools = [readFileTool, writeFileTool, editFileTool, globTool, grepTool];
