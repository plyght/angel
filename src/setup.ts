import * as p from "@clack/prompts";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import color from "picocolors";
import {
  type AngelConfig,
  configExists,
  configPath,
  DEFAULTS,
  loadConfig,
  saveConfig,
} from "./config";

async function checkSignalCli(
  cliPath = "signal-cli",
): Promise<{ installed: boolean; path: string; version: string }> {
  try {
    const which = Bun.spawn(["which", cliPath], { stdout: "pipe" });
    const whichPath = (await new Response(which.stdout).text()).trim();
    if (!whichPath) return { installed: false, path: "", version: "" };

    const ver = Bun.spawn([cliPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const version = (await new Response(ver.stdout).text()).trim();
    return { installed: true, path: whichPath, version };
  } catch {
    return { installed: false, path: "", version: "" };
  }
}

async function checkSignalAccount(cliPath = "signal-cli"): Promise<string[]> {
  try {
    const proc = Bun.spawn([cliPath, "listAccounts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = (await new Response(proc.stdout).text()).trim();
    if (!output) return [];
    return output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function runSetup(): Promise<void> {
  p.intro(color.bgCyan(color.black(" angel setup ")));

  const existing = configExists() ? loadConfig() : null;

  const openaiKey = await p.text({
    message: "OpenAI API key",
    placeholder: "sk-...",
    initialValue: existing?.openai_api_key || "",
    validate: (v) => {
      if (!v?.trim()) return "API key is required";
    },
  });
  if (p.isCancel(openaiKey)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const model = await p.text({
    message: "Default model",
    initialValue: existing?.model || DEFAULTS.model,
  });
  if (p.isCancel(model)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const maxTokens = await p.text({
    message: "Max output tokens per response",
    initialValue: String(existing?.max_tokens || DEFAULTS.max_tokens),
    validate: (v) => {
      if (!v || Number.isNaN(Number(v)) || Number(v) < 1)
        return "Must be a positive number";
    },
  });
  if (p.isCancel(maxTokens)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const timezone = await p.text({
    message: "Timezone (IANA)",
    initialValue: existing?.timezone || DEFAULTS.timezone,
  });
  if (p.isCancel(timezone)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const workingDirIsolation = await p.select({
    message: "Working directory isolation",
    initialValue:
      existing?.working_dir_isolation || DEFAULTS.working_dir_isolation,
    options: [
      {
        value: "per_chat",
        label: "Per chat",
        hint: "each chat gets its own working directory",
      },
      { value: "none", label: "None", hint: "shared working directory" },
    ],
  });
  if (p.isCancel(workingDirIsolation)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const selectedChannels = await p.multiselect({
    message: "Which channels do you want to enable?",
    options: [
      { value: "discord", label: "Discord", hint: "requires bot token" },
      { value: "slack", label: "Slack", hint: "requires bot + app tokens" },
      {
        value: "imessage",
        label: "iMessage",
        hint: "macOS + imsg CLI",
      },
      { value: "signal", label: "Signal", hint: "requires signal-cli" },
    ],
    required: false,
  });
  if (p.isCancel(selectedChannels)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const channels: AngelConfig["channels"] = {};

  if (selectedChannels.includes("discord")) {
    const token = await p.text({
      message: "Discord bot token",
      placeholder: "paste your bot token",
      initialValue: existing?.channels?.discord?.token || "",
      validate: (v) => {
        if (!v?.trim()) return "Token is required for Discord";
      },
    });
    if (p.isCancel(token)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const botUsername = await p.text({
      message: "Discord bot username (for mention detection)",
      initialValue: existing?.channels?.discord?.bot_username || "angel",
    });
    if (p.isCancel(botUsername)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    channels.discord = {
      enabled: true,
      token: token as string,
      bot_username: botUsername as string,
    };
  }

  if (selectedChannels.includes("slack")) {
    const botToken = await p.text({
      message: "Slack bot token",
      placeholder: "xoxb-...",
      initialValue: existing?.channels?.slack?.bot_token || "",
      validate: (v) => {
        if (!v?.trim()) return "Bot token is required for Slack";
      },
    });
    if (p.isCancel(botToken)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const appToken = await p.text({
      message: "Slack app token (for Socket Mode)",
      placeholder: "xapp-...",
      initialValue: existing?.channels?.slack?.app_token || "",
      validate: (v) => {
        if (!v?.trim()) return "App token is required for Slack Socket Mode";
      },
    });
    if (p.isCancel(appToken)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    channels.slack = {
      enabled: true,
      bot_token: botToken as string,
      app_token: appToken as string,
    };
  }

  if (selectedChannels.includes("imessage")) {
    const defaultIMsgPath = existing?.channels?.imessage?.imsg_path || "imsg";
    try {
      const proc = Bun.spawn(["which", defaultIMsgPath], { stdout: "pipe" });
      const path = (await new Response(proc.stdout).text()).trim();
      if (path) {
        p.log.success(`imsg found at ${path}`);
      } else {
        p.log.warn(
          "imsg not found in PATH. Install from https://github.com/steipete/imsg or provide a custom path.",
        );
      }
    } catch {
      p.log.warn(
        "Could not verify imsg in PATH. Ensure it is installed and executable.",
      );
    }

    const imsgPath = await p.text({
      message: "imsg binary path",
      initialValue: defaultIMsgPath,
      placeholder: "imsg",
      validate: (v) => {
        if (!v?.trim()) return "Path is required";
      },
    });
    if (p.isCancel(imsgPath)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const service = await p.select({
      message: "Preferred send service",
      initialValue: (
        existing?.channels?.imessage?.service || "auto"
      ).toLowerCase(),
      options: [
        { value: "auto", label: "Auto" },
        { value: "imessage", label: "iMessage" },
        { value: "sms", label: "SMS" },
      ],
    });
    if (p.isCancel(service)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const region = await p.text({
      message: "Phone normalization region",
      initialValue: existing?.channels?.imessage?.region || "US",
      placeholder: "US",
      validate: (v) => {
        if (!v?.trim()) return "Region is required";
      },
    });
    if (p.isCancel(region)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const allowedHandles = await p.text({
      message: "Allowed iMessage handles (comma-separated, optional)",
      initialValue:
        existing?.channels?.imessage?.allowed_handles?.join(",") || "",
      placeholder: "+14155551212,+14155552345",
    });
    if (p.isCancel(allowedHandles)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const parsedAllowedHandles = String(allowedHandles)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    channels.imessage = {
      enabled: true,
      imsg_path: imsgPath as string,
      service: service as string,
      region: region as string,
      allowed_handles: parsedAllowedHandles,
    };
  }

  if (selectedChannels.includes("signal")) {
    const signalInfo = await checkSignalCli();

    if (!signalInfo.installed) {
      p.log.warn("signal-cli is not installed.");

      const installChoice = await p.select({
        message: "How would you like to proceed?",
        options: [
          {
            value: "brew",
            label: "Install via Homebrew",
            hint: "brew install signal-cli",
          },
          {
            value: "manual",
            label: "I'll install it myself",
            hint: "https://github.com/AsamK/signal-cli",
          },
          {
            value: "path",
            label: "Specify custom path",
            hint: "if installed elsewhere",
          },
          { value: "skip", label: "Skip Signal for now" },
        ],
      });
      if (p.isCancel(installChoice)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      if (installChoice === "brew") {
        const s = p.spinner();
        s.start("Installing signal-cli via Homebrew...");
        try {
          const proc = Bun.spawn(["brew", "install", "signal-cli"], {
            stdout: "pipe",
            stderr: "pipe",
          });
          await proc.exited;
          const exitCode = proc.exitCode;
          if (exitCode === 0) {
            s.stop("signal-cli installed successfully.");
          } else {
            const stderr = await new Response(proc.stderr).text();
            s.stop("Installation failed.");
            p.log.error(stderr.trim() || "brew install failed");
          }
        } catch (err: any) {
          s.stop("Installation failed.");
          p.log.error(err.message);
        }
      } else if (installChoice === "path") {
        const customPath = await p.text({
          message: "Path to signal-cli binary",
          placeholder: "/usr/local/bin/signal-cli",
          validate: (v) => {
            if (!v?.trim()) return "Path is required";
            if (!existsSync(v!.trim())) return "File not found at that path";
          },
        });
        if (p.isCancel(customPath)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        const recheck = await checkSignalCli(customPath as string);
        if (recheck.installed) {
          p.log.success(`Found signal-cli ${recheck.version} at ${customPath}`);
        }
      } else if (installChoice === "skip") {
        p.log.info("Skipping Signal setup.");
      }

      if (installChoice === "skip") {
        // don't configure signal
      } else {
        await configureSignalAccount(
          channels,
          existing,
          installChoice === "path" ? undefined : undefined,
        );
      }
    } else {
      p.log.success(
        `signal-cli ${signalInfo.version} found at ${signalInfo.path}`,
      );
      await configureSignalAccount(channels, existing);
    }
  }

  const memReflector = await p.confirm({
    message:
      "Enable memory reflector? (auto-synthesizes insights from conversations)",
    initialValue:
      existing?.memory?.reflector_enabled ?? DEFAULTS.memory.reflector_enabled,
  });
  if (p.isCancel(memReflector)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const config: Partial<AngelConfig> = {
    ...DEFAULTS,
    openai_api_key: openaiKey as string,
    model: model as string,
    max_tokens: Number(maxTokens),
    timezone: timezone as string,
    working_dir_isolation: workingDirIsolation as "none" | "per_chat",
    channels,
    memory: {
      ...DEFAULTS.memory,
      reflector_enabled: memReflector as boolean,
    },
  };

  const dir = dirname(configPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  saveConfig(config);

  p.outro(
    `Config saved to ${configPath()}. Run ${color.cyan("bun run start")} to launch Angel.`,
  );
}

async function configureSignalAccount(
  channels: AngelConfig["channels"],
  existing: AngelConfig | null,
  customCliPath?: string,
) {
  const cliPath = customCliPath || "signal-cli";
  const accounts = await checkSignalAccount(cliPath);

  let account: string | symbol;
  if (accounts.length > 0) {
    p.log.info(`Found ${accounts.length} registered account(s).`);
    const choice = await p.select({
      message: "Select a Signal account",
      options: [
        ...accounts.map((a) => ({ value: a, label: a })),
        { value: "__new__", label: "Register a new account" },
        { value: "__manual__", label: "Enter phone number manually" },
      ],
    });
    if (p.isCancel(choice)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (choice === "__new__") {
      p.log.info("To register a new account, run:");
      p.log.message(`  ${cliPath} -a +1XXXXXXXXXX register --voice`);
      p.log.message(`  ${cliPath} -a +1XXXXXXXXXX verify CODE`);

      account = await p.text({
        message: "Phone number for the new account",
        placeholder: "+1234567890",
        validate: (v) => {
          if (!v?.startsWith("+")) return "Must start with +";
        },
      });
    } else if (choice === "__manual__") {
      account = await p.text({
        message: "Signal phone number",
        placeholder: "+1234567890",
        initialValue: existing?.channels?.signal?.account || "",
        validate: (v) => {
          if (!v?.startsWith("+")) return "Must start with +";
        },
      });
    } else {
      account = choice;
    }
  } else {
    p.log.info("No registered accounts found. You'll need to register one.");
    p.log.message(`  ${cliPath} -a +1XXXXXXXXXX register --voice`);
    p.log.message(`  ${cliPath} -a +1XXXXXXXXXX verify CODE`);

    account = await p.text({
      message: "Signal phone number",
      placeholder: "+1234567890",
      initialValue: existing?.channels?.signal?.account || "",
      validate: (v) => {
        if (!v?.startsWith("+")) return "Must start with +";
      },
    });
  }
  if (p.isCancel(account)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  channels.signal = {
    enabled: true,
    account: account as string,
    ...(customCliPath ? { signal_cli_path: customCliPath } : {}),
  };
}
