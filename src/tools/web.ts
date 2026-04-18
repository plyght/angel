import type { Tool, ToolResult } from "./registry";

const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost[:/]/i,
  /^https?:\/\/127\.\d+\.\d+\.\d+/i,
  /^https?:\/\/0\.0\.0\.0/i,
  /^https?:\/\/\[::1\]/i,
  /^https?:\/\/10\.\d+\.\d+\.\d+/i,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/i,
  /^https?:\/\/192\.168\.\d+\.\d+/i,
  /^https?:\/\/169\.254\.\d+\.\d+/i,
  /^https?:\/\/\[?fe80:/i,
  /^https?:\/\/\[?fd[0-9a-f]{2}:/i,
];

function isPrivateUrl(url: string): boolean {
  return PRIVATE_IP_PATTERNS.some((p) => p.test(url));
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web for information. Returns relevant search results with snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: {
        type: "number",
        description: "Maximum results (default: 5)",
      },
    },
    required: ["query"],
  },
  risk: "low",

  async execute(input: {
    query: string;
    max_results?: number;
  }): Promise<ToolResult> {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Angel/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      const html = await resp.text();

      const results: string[] = [];
      const resultRegex =
        /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRegex =
        /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

      const max = input.max_results || 5;
      let i = 0;
      for (
        let match = resultRegex.exec(html);
        match !== null && i < max;
        match = resultRegex.exec(html)
      ) {
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        const href = match[1];
        const snippetMatch = snippetRegex.exec(html);
        const snippet = snippetMatch
          ? snippetMatch[1].replace(/<[^>]+>/g, "").trim()
          : "";
        results.push(`[${i + 1}] ${title}\n    ${href}\n    ${snippet}`);
        i++;
      }

      return {
        output: results.length > 0 ? results.join("\n\n") : "No results found",
      };
    } catch (err: any) {
      return { output: `Search error: ${err.message}`, isError: true };
    }
  },
};

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch a web page and return its text content (HTML stripped).",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      max_length: {
        type: "number",
        description: "Max characters to return (default: 20000)",
      },
    },
    required: ["url"],
  },
  risk: "low",

  async execute(input: {
    url: string;
    max_length?: number;
  }): Promise<ToolResult> {
    const maxLen = input.max_length || 20000;
    try {
      if (isPrivateUrl(input.url)) {
        return {
          output: "Access denied: private/internal addresses are blocked",
          isError: true,
        };
      }
      const resp = await fetch(input.url, {
        headers: { "User-Agent": "Angel/1.0" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        return {
          output: `HTTP ${resp.status}: ${resp.statusText}`,
          isError: true,
        };
      }

      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await resp.json();
        return { output: JSON.stringify(json, null, 2).slice(0, maxLen) };
      }

      const html = await resp.text();
      const text = stripHtml(html);
      return { output: text.slice(0, maxLen) };
    } catch (err: any) {
      return { output: `Fetch error: ${err.message}`, isError: true };
    }
  },
};

function stripHtml(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

export const webTools = [webSearchTool, webFetchTool];
