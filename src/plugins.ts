import type { AngelConfig } from "./config";
import type { Tool, ToolContext, ToolResult } from "./tools/registry";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  tools?: Array<{
    name: string;
    description: string;
    parameters: any;
    command: string;
  }>;
  commands?: Array<{
    name: string;
    description: string;
    command: string;
  }>;
}

export function loadPlugins(config: AngelConfig): Tool[] {
  const pluginsDir = config.plugins_dir || join(config.data_dir, "plugins");
  if (!existsSync(pluginsDir)) return [];

  const tools: Tool[] = [];

  for (const entry of readdirSync(pluginsDir)) {
    const manifestPath = join(pluginsDir, entry, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

      for (const toolDef of manifest.tools || []) {
        tools.push({
          name: `plugin_${manifest.name}_${toolDef.name}`,
          description: `[Plugin:${manifest.name}] ${toolDef.description}`,
          parameters: toolDef.parameters || { type: "object", properties: {} },
          risk: "medium",

          async execute(input: any, ctx: ToolContext): Promise<ToolResult> {
            try {
              const proc = Bun.spawn(["bash", "-c", toolDef.command], {
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
                cwd: ctx.workingDir,
              });

              const writer = proc.stdin.getWriter();
              await writer.write(new TextEncoder().encode(JSON.stringify(input)));
              await writer.close();

              const stdout = await new Response(proc.stdout).text();
              const exitCode = await proc.exited;

              return { output: stdout || `(exit: ${exitCode})`, isError: exitCode !== 0 };
            } catch (err: any) {
              return { output: `Plugin error: ${err.message}`, isError: true };
            }
          },
        });
      }

      console.log(`[angel] Plugin loaded: ${manifest.name} (${manifest.tools?.length || 0} tools)`);
    } catch (err: any) {
      console.error(`[angel] Plugin ${entry} failed: ${err.message}`);
    }
  }

  return tools;
}
