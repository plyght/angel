import { saveConfig, configPath, type AngelConfig, DEFAULTS } from "./config";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export async function runSetup(): Promise<void> {
  console.log("\n  Angel Setup Wizard\n  ==================\n");

  const config: Partial<AngelConfig> = { ...DEFAULTS };

  const apiKey = await prompt("  OpenAI API key: ");
  if (!apiKey) {
    console.log("  API key is required. Aborting.");
    process.exit(1);
  }
  config.openai_api_key = apiKey;

  const model = await prompt("  Model (default: gpt-4.1): ");
  if (model) config.model = model;

  console.log("\n  Channels (press Enter to skip):\n");

  const discordToken = await prompt("  Discord bot token: ");
  if (discordToken) {
    config.channels = {
      ...config.channels,
      discord: { enabled: true, token: discordToken },
    };
  }

  const slackBotToken = await prompt("  Slack bot token (xoxb-...): ");
  if (slackBotToken) {
    const slackAppToken = await prompt("  Slack app token (xapp-...): ");
    config.channels = {
      ...config.channels,
      slack: { enabled: true, bot_token: slackBotToken, app_token: slackAppToken || "" },
    };
  }

  const enableImessage = await prompt("  Enable iMessage? (y/N): ");
  if (enableImessage?.toLowerCase() === "y") {
    config.channels = {
      ...config.channels,
      imessage: { enabled: true },
    };
  }

  const signalAccount = await prompt("  Signal account phone number (+1234...): ");
  if (signalAccount) {
    config.channels = {
      ...config.channels,
      signal: { enabled: true, account: signalAccount },
    };
  }

  const dir = dirname(configPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  saveConfig(config);
  console.log(`\n  ✓ Config saved to ${configPath()}`);
  console.log("  Run 'bun run src/index.ts start' to launch Angel.\n");
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let input = "";

    const onData = (data: Buffer) => {
      const str = data.toString();
      if (str.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        input += str.split("\n")[0];
        resolve(input.trim());
      } else {
        input += str;
      }
    };

    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
