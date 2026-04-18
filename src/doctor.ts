import * as p from "@clack/prompts";
import color from "picocolors";
import { configExists, configPath, loadConfig } from "./config";

export async function runDoctor(): Promise<void> {
  p.intro(color.bgCyan(color.black(" angel doctor ")));

  p.log.info(`Bun ${Bun.version}`);

  if (!configExists()) {
    p.log.warn(`Config not found. Run ${color.cyan("bun run setup")} first.`);
    p.outro("Done.");
    return;
  }

  p.log.success(`Config: ${configPath()}`);
  const config = loadConfig();

  if (config.openai_api_key) {
    p.log.success("OpenAI API key: set");
    const s = p.spinner();
    s.start("Testing OpenAI API...");
    try {
      const resp = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${config.openai_api_key}` },
      });
      if (resp.ok) {
        s.stop("OpenAI API: connected");
      } else {
        s.stop(color.red(`OpenAI API: HTTP ${resp.status}`));
      }
    } catch (err: any) {
      s.stop(color.red(`OpenAI API: ${err.message}`));
    }
  } else {
    p.log.error("OpenAI API key: not set");
  }

  if (config.channels.discord?.enabled) {
    if (config.channels.discord.token) {
      p.log.success("Discord: token set");
    } else {
      p.log.warn("Discord: enabled but no token");
    }
  }

  if (config.channels.slack?.enabled) {
    if (config.channels.slack.bot_token) {
      p.log.success("Slack: tokens set");
    } else {
      p.log.warn("Slack: enabled but missing tokens");
    }
  }

  if (config.channels.imessage?.enabled) {
    const imsgPath = config.channels.imessage.imsg_path || "imsg";
    try {
      const which = Bun.spawn(["which", imsgPath], { stdout: "pipe" });
      const path = (await new Response(which.stdout).text()).trim();
      if (!path) {
        p.log.warn(`iMessage: imsg not found (${imsgPath})`);
      } else {
        const ver = Bun.spawn([imsgPath, "--help"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        await ver.exited;
        p.log.success(`iMessage: imsg available at ${path}`);
        const allowedCount =
          config.channels.imessage.allowed_handles?.length ?? 0;
        if (allowedCount > 0) {
          p.log.info(`iMessage allowlist: ${allowedCount} handle(s)`);
        } else {
          p.log.warn(
            "iMessage allowlist: not configured (all senders allowed)",
          );
        }
      }
    } catch {
      p.log.warn(`iMessage: unable to execute imsg (${imsgPath})`);
    }
  }

  if (config.channels.signal?.enabled) {
    const cliPath = config.channels.signal.signal_cli_path || "signal-cli";
    try {
      const proc = Bun.spawn(["which", cliPath], { stdout: "pipe" });
      const path = (await new Response(proc.stdout).text()).trim();
      if (path) {
        const ver = Bun.spawn([cliPath, "--version"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const version = (await new Response(ver.stdout).text()).trim();
        p.log.success(`Signal CLI: ${version || "found"} at ${path}`);

        try {
          const acc = Bun.spawn([cliPath, "listAccounts"], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const accounts = (await new Response(acc.stdout).text()).trim();
          if (accounts) {
            const count = accounts.split("\n").filter(Boolean).length;
            p.log.info(`Signal accounts: ${count} registered`);
          } else {
            p.log.warn("Signal: no registered accounts");
          }
        } catch {}
      } else {
        p.log.warn(`Signal CLI: ${cliPath} not found in PATH`);
      }
    } catch {
      p.log.warn(`Signal CLI: ${cliPath} not found`);
    }
  }

  try {
    const proc = Bun.spawn(["which", "rg"], { stdout: "pipe" });
    const path = (await new Response(proc.stdout).text()).trim();
    if (path) {
      p.log.success("ripgrep: available");
    } else {
      p.log.warn("ripgrep: not found (grep tool will use fallback)");
    }
  } catch {
    p.log.warn("ripgrep: not found");
  }

  p.outro("Done.");
}
