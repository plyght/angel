import type { Tool, ToolResult } from "./registry";

export const browserTool: Tool = {
  name: "browser",
  description:
    "Open a URL in a headless browser and return the page content. Useful for JavaScript-rendered pages.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to open" },
      action: {
        type: "string",
        enum: ["get_content", "screenshot", "click", "type"],
        description: "Action to perform (default: get_content)",
      },
      selector: {
        type: "string",
        description: "CSS selector for click/type actions",
      },
      text: { type: "string", description: "Text to type" },
    },
    required: ["url"],
  },
  risk: "medium",

  async execute(input: {
    url: string;
    action?: string;
    selector?: string;
    text?: string;
  }): Promise<ToolResult> {
    try {
      const proc = Bun.spawn(
        [
          "npx",
          "-y",
          "playwright",
          "evaluate",
          "--browser",
          "chromium",
          `
          const page = await context.newPage();
          await page.goto('${input.url.replace(/'/g, "\\'")}', { waitUntil: 'networkidle', timeout: 15000 });
          const content = await page.evaluate(() => document.body.innerText);
          console.log(content.slice(0, 30000));
        `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0 || !stdout.trim()) {
        const resp = await fetch(input.url, {
          headers: { "User-Agent": "Angel/1.0" },
        });
        const html = await resp.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { output: text.slice(0, 30000) };
      }

      return { output: stdout.slice(0, 30000) };
    } catch (err: any) {
      try {
        const resp = await fetch(input.url, {
          headers: { "User-Agent": "Angel/1.0" },
        });
        const html = await resp.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { output: text.slice(0, 30000) };
      } catch (_e: any) {
        return { output: `Browser error: ${err.message}`, isError: true };
      }
    }
  },
};
