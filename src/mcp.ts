import type { AngelConfig, McpServerConfig } from "./config";
import type { Tool, ToolContext, ToolResult } from "./tools/registry";

interface McpServer {
  name: string;
  process: any;
  tools: Array<{ name: string; description: string; inputSchema: any }>;
}

const servers: Map<string, McpServer> = new Map();
let requestId = 1;

export async function initMcpServers(config: AngelConfig): Promise<Tool[]> {
  const mcpConfig = config.mcp_servers;
  if (!mcpConfig) return [];

  const allTools: Tool[] = [];

  for (const [name, serverConfig] of Object.entries(mcpConfig)) {
    try {
      const tools = await connectMcpServer(name, serverConfig);
      allTools.push(...tools);
      console.log(`[angel] MCP: ${name} connected (${tools.length} tools)`);
    } catch (err: any) {
      console.error(`[angel] MCP: Failed to connect ${name}: ${err.message}`);
    }
  }

  return allTools;
}

async function connectMcpServer(name: string, config: McpServerConfig): Promise<Tool[]> {
  const proc = Bun.spawn([config.command, ...(config.args || [])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(config.env || {}) },
  });

  const server: McpServer = { name, process: proc, tools: [] };
  servers.set(name, server);

  const initResponse = await sendMcpRequest(proc, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "angel", version: "0.1.0" },
  });

  await sendMcpNotification(proc, "notifications/initialized", {});

  const toolsResponse = await sendMcpRequest(proc, "tools/list", {});
  server.tools = toolsResponse?.tools || [];

  return server.tools.map((t: any) => ({
    name: `mcp_${name}_${t.name}`,
    description: `[MCP:${name}] ${t.description || t.name}`,
    parameters: t.inputSchema || { type: "object", properties: {} },
    risk: "medium" as const,

    async execute(input: any, ctx: ToolContext): Promise<ToolResult> {
      try {
        const result = await sendMcpRequest(proc, "tools/call", {
          name: t.name,
          arguments: input,
        });
        const text = result?.content?.map((c: any) => c.text || JSON.stringify(c)).join("\n") || "No output";
        return { output: text };
      } catch (err: any) {
        return { output: `MCP error: ${err.message}`, isError: true };
      }
    },
  }));
}

async function sendMcpRequest(proc: any, method: string, params: any): Promise<any> {
  const id = requestId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(msg));
  writer.releaseLock();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP timeout")), 30000);

    const reader = proc.stdout.getReader();
    let buffer = "";

    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line);
            if (response.id === id) {
              clearTimeout(timeout);
              reader.releaseLock();
              if (response.error) reject(new Error(response.error.message));
              else resolve(response.result);
              return;
            }
          } catch {}
        }
      }
    })();
  });
}

async function sendMcpNotification(proc: any, method: string, params: any): Promise<void> {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(msg));
  writer.releaseLock();
}

export async function shutdownMcpServers() {
  for (const [, server] of servers) {
    try {
      server.process.kill();
    } catch {}
  }
  servers.clear();
}
