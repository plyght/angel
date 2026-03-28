import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { configExists, configPath, loadConfig } from "./config";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];

  checks.push({
    name: "Bun version",
    status: "ok",
    message: Bun.version,
  });

  if (configExists()) {
    checks.push({ name: "Config file", status: "ok", message: configPath() });
    const config = loadConfig();

    if (config.openai_api_key) {
      checks.push({ name: "OpenAI API key", status: "ok", message: "Set (***)" });

      try {
        const resp = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${config.openai_api_key}` },
        });
        checks.push({
          name: "OpenAI API",
          status: resp.ok ? "ok" : "fail",
          message: resp.ok ? "Connected" : `HTTP ${resp.status}`,
        });
      } catch (err: any) {
        checks.push({ name: "OpenAI API", status: "fail", message: err.message });
      }
    } else {
      checks.push({ name: "OpenAI API key", status: "fail", message: "Not set" });
    }

    if (config.channels.discord?.enabled) {
      checks.push({
        name: "Discord",
        status: config.channels.discord.token ? "ok" : "warn",
        message: config.channels.discord.token ? "Token set" : "No token",
      });
    }

    if (config.channels.slack?.enabled) {
      checks.push({
        name: "Slack",
        status: config.channels.slack.bot_token ? "ok" : "warn",
        message: config.channels.slack.bot_token ? "Tokens set" : "Missing tokens",
      });
    }

    if (config.channels.imessage?.enabled) {
      const msgDb = join(homedir(), "Library", "Messages", "chat.db");
      checks.push({
        name: "iMessage",
        status: existsSync(msgDb) ? "ok" : "warn",
        message: existsSync(msgDb) ? "Messages DB accessible" : "Messages DB not found (need Full Disk Access)",
      });
    }

    if (config.channels.signal?.enabled) {
      try {
        const proc = Bun.spawn(["which", "signal-cli"], { stdout: "pipe" });
        const path = await new Response(proc.stdout).text();
        checks.push({
          name: "Signal CLI",
          status: path.trim() ? "ok" : "warn",
          message: path.trim() || "signal-cli not found in PATH",
        });
      } catch {
        checks.push({ name: "Signal CLI", status: "warn", message: "signal-cli not found" });
      }
    }
  } else {
    checks.push({ name: "Config file", status: "warn", message: `Not found. Run 'angel setup' first.` });
  }

  try {
    const proc = Bun.spawn(["which", "rg"], { stdout: "pipe" });
    const path = await new Response(proc.stdout).text();
    checks.push({
      name: "ripgrep (rg)",
      status: path.trim() ? "ok" : "warn",
      message: path.trim() ? "Available" : "Not found (grep tool will use fallback)",
    });
  } catch {
    checks.push({ name: "ripgrep (rg)", status: "warn", message: "Not found" });
  }

  console.log("\n  Angel Doctor\n  ============\n");
  for (const check of checks) {
    const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗";
    const color = check.status === "ok" ? "\x1b[32m" : check.status === "warn" ? "\x1b[33m" : "\x1b[31m";
    console.log(`  ${color}${icon}\x1b[0m ${check.name}: ${check.message}`);
  }
  console.log("");
}
