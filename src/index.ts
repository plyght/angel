#!/usr/bin/env bun
import * as p from "@clack/prompts";
import color from "picocolors";
import { loadConfig, configExists, configPath } from "./config";
import { getDb, upsertChat } from "./db";
import { processMessage } from "./agent";
import { ToolRegistry } from "./tools/registry";
import { ChannelRegistry, splitMessage } from "./channels/types";
import { bashTool } from "./tools/bash";
import { fileTools } from "./tools/files";
import { webTools } from "./tools/web";
import { miscTools } from "./tools/misc";
import { memoryTools } from "./tools/memory";
import { scheduleTools } from "./tools/schedule";
import { subagentTools } from "./tools/subagent";
import { sendMessageTool, setSendMessageDeps } from "./tools/send_message";
import { browserTool } from "./tools/browser";
import { codingAgentTools, setCodingAgentNotifier } from "./tools/coding_agents";
import { handleCommand } from "./commands";
import { handleExplicitMemory, scheduleReflector } from "./memory";
import { startScheduler } from "./scheduler";
import { initMcpServers, shutdownMcpServers } from "./mcp";
import { discoverSkills } from "./skills";
import { loadPlugins } from "./plugins";
import { runDoctor } from "./doctor";
import { runSetup } from "./setup";
import { iMessageChannel } from "./channels/imessage";
import { DiscordChannel } from "./channels/discord";
import { SlackChannel } from "./channels/slack";
import { SignalChannel } from "./channels/signal";

const VERSION = "0.1.0";
const args = process.argv.slice(2);
const command = args[0] || "start";

function printHelp() {
  console.log(`
  ${color.bgCyan(color.black(" angel "))} ${color.dim(`v${VERSION}`)}

  ${color.bold("Usage:")} angel <command>

  ${color.bold("Commands:")}
    ${color.cyan("start")}       Start the agent ${color.dim("(default)")}
    ${color.cyan("setup")}       Interactive setup wizard
    ${color.cyan("doctor")}      Run diagnostics and health checks
    ${color.cyan("config")}      Show current configuration
    ${color.cyan("config path")} Show config file path
    ${color.cyan("config edit")} Open config in $EDITOR
    ${color.cyan("agents")}      Show installed coding agents
    ${color.cyan("reset")}       Reset onboarding and profile data
    ${color.cyan("version")}     Show version
    ${color.cyan("help")}        Show this help

  ${color.bold("Examples:")}
    ${color.dim("$")} angel              ${color.dim("# starts the agent")}
    ${color.dim("$")} angel setup        ${color.dim("# run setup wizard")}
    ${color.dim("$")} angel doctor       ${color.dim("# check everything works")}
`);
}

switch (command) {
  case "setup":
    await runSetup();
    break;

  case "doctor":
    await runDoctor();
    break;

  case "version":
  case "v":
    console.log(`angel v${VERSION}`);
    break;

  case "help":
  case "h":
    printHelp();
    break;

  case "config": {
    const sub = args[1];
    if (sub === "path") {
      console.log(configPath());
    } else if (sub === "edit") {
      const editor = process.env.EDITOR || "nano";
      const proc = Bun.spawn([editor, configPath()], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      await proc.exited;
    } else {
      if (!configExists()) {
        p.log.warn(`No config found. Run ${color.cyan("angel setup")} first.`);
        break;
      }
      const config = loadConfig();
      const enabledChannels = Object.entries(config.channels)
        .filter(([_, v]: [string, any]) => v?.enabled !== false)
        .map(([k]) => k);
      p.intro(color.bgCyan(color.black(" angel config ")));
      p.log.info(`Model:      ${color.cyan(config.model)}`);
      p.log.info(`Max tokens: ${color.cyan(String(config.max_tokens))}`);
      p.log.info(`Timezone:   ${color.cyan(config.timezone)}`);
      p.log.info(`Channels:   ${enabledChannels.length ? color.cyan(enabledChannels.join(", ")) : color.dim("none")}`);
      p.log.info(`Data dir:   ${color.dim(config.data_dir)}`);
      p.log.info(`Config:     ${color.dim(configPath())}`);
      p.outro("");
    }
    break;
  }

  case "reset": {
    if (!configExists()) {
      p.log.warn("Nothing to reset — no config found.");
      break;
    }
    const confirm = await p.confirm({
      message: "This will clear your onboarding data and profile memories. Continue?",
    });
    if (p.isCancel(confirm) || !confirm) {
      p.cancel("Reset cancelled.");
      break;
    }
    const config = loadConfig();
    const db = getDb(config.data_dir);
    db.run("DELETE FROM db_meta WHERE key IN ('onboarded', 'onboarding_chat')");
    db.run("DELETE FROM memories WHERE category = 'profile'");
    p.log.success("Onboarding and profile data cleared. Next message will restart onboarding.");
    break;
  }

  case "agents": {
    const { listCodingAgentsTool } = await import("./tools/coding_agents");
    p.intro(color.bgCyan(color.black(" angel agents ")));
    const result = await listCodingAgentsTool.execute({}, {} as any);
    for (const line of result.output.split("\n")) {
      const installed = line.includes("installed (");
      if (installed) {
        p.log.success(line);
      } else {
        p.log.warn(line);
      }
    }
    p.outro("Angel can use any installed agent via the spawn_coding_agent tool.");
    break;
  }

  case "start":
    await boot();
    break;

  default:
    console.log(`\n  Unknown command: ${color.red(command)}\n`);
    printHelp();
    process.exit(1);
}

async function boot() {
  if (!configExists()) {
    p.log.warn("No config found. Running setup...");
    await runSetup();
    return;
  }

  p.intro(color.bgCyan(color.black(" angel ")));

  const config = loadConfig();
  if (!config.openai_api_key) {
    p.log.error(`openai_api_key not set. Run ${color.cyan("bun run setup")}.`);
    process.exit(1);
  }

  const db = getDb(config.data_dir);
  const registry = new ToolRegistry();
  const channels = new ChannelRegistry();

  registry.register(bashTool);
  registry.registerMany(fileTools);
  registry.registerMany(webTools);
  registry.registerMany(miscTools);
  registry.registerMany(memoryTools);
  registry.registerMany(scheduleTools);
  registry.registerMany(subagentTools);
  registry.register(sendMessageTool);
  registry.register(browserTool);
  registry.registerMany(codingAgentTools);

  const mcpTools = await initMcpServers(config);
  registry.registerMany(mcpTools);

  const skillTools = discoverSkills(config);
  registry.registerMany(skillTools);

  const pluginTools = loadPlugins(config);
  registry.registerMany(pluginTools);

  setSendMessageDeps(channels, db);

  if (config.channels.imessage?.enabled) {
    channels.register(new iMessageChannel());
  }
  if (config.channels.discord?.enabled && config.channels.discord.token) {
    channels.register(new DiscordChannel(config.channels.discord.token, config.channels.discord.bot_username));
  }
  if (config.channels.slack?.enabled && config.channels.slack.bot_token && config.channels.slack.app_token) {
    channels.register(new SlackChannel(config.channels.slack.bot_token, config.channels.slack.app_token));
  }
  if (config.channels.signal?.enabled && config.channels.signal.account) {
    channels.register(new SignalChannel(config.channels.signal.account, config.channels.signal.signal_cli_path, config.channels.signal.allowed_numbers));
  }

  const messageHandler = async (msg: any) => {
    const chatId = upsertChat(db, msg.externalChatId.includes("@") ? "imessage" : msg.chatType.split("_")[0], msg.externalChatId, msg.chatType, msg.senderName);

    const memoryResult = handleExplicitMemory(msg.text, db, chatId);
    if (memoryResult) {
      const adapter = channels.get(msg.chatType.split("_")[0]);
      if (adapter) await adapter.sendText(msg.externalChatId, memoryResult);
      return;
    }

    const cmdResult = handleCommand(msg.text, chatId, db, config);
    if (cmdResult.handled) {
      const adapter = channels.get(msg.chatType.split("_")[0]);
      if (adapter) await adapter.sendText(msg.externalChatId, cmdResult.text);
      return;
    }

    const onboarded = db.query("SELECT value FROM db_meta WHERE key = 'onboarded'").get() as { value: string } | null;
    if (!onboarded) {
      const msgCount = db.query("SELECT COUNT(*) as count FROM messages WHERE chat_id = ?").get(chatId) as { count: number };
      if (msgCount.count === 0) {
        db.run("INSERT OR REPLACE INTO db_meta (key, value) VALUES ('onboarding_chat', ?)", [String(chatId)]);
      }
      const onboardingChat = db.query("SELECT value FROM db_meta WHERE key = 'onboarding_chat'").get() as { value: string } | null;
      if (onboardingChat && parseInt(onboardingChat.value) === chatId) {
        const memories = db.query("SELECT COUNT(*) as count FROM memories WHERE category = 'profile'").get() as { count: number };
        if (memories.count >= 3) {
          db.run("INSERT OR REPLACE INTO db_meta (key, value) VALUES ('onboarded', '1')");
        }
      }
    }

    const channelName = msg.chatType.split("_")[0];
    const adapter = channels.get(channelName);

    let typingInterval: ReturnType<typeof setInterval> | null = null;
    if (adapter?.sendTyping) {
      adapter.sendTyping(msg.externalChatId);
      typingInterval = setInterval(() => adapter.sendTyping!(msg.externalChatId), 4000);
    }

    try {
      const image = msg.imageBase64 ? { base64: msg.imageBase64, mimeType: msg.imageMimeType || "image/jpeg" } : undefined;
      const onboardedCheck = db.query("SELECT value FROM db_meta WHERE key = 'onboarded'").get() as { value: string } | null;
      const onboardingChatCheck = db.query("SELECT value FROM db_meta WHERE key = 'onboarding_chat'").get() as { value: string } | null;
      const isOnboarding = !onboardedCheck && onboardingChatCheck && parseInt(onboardingChatCheck.value) === chatId;
      const response = await processMessage(msg.text, {
        chatId,
        channel: channelName,
        db,
        config,
        registry,
        isOnboarding: !!isOnboarding,
      }, image);

      if (typingInterval) clearInterval(typingInterval);

      if (adapter && response) {
        const maxLen = adapter.maxMessageLength || 4000;
        const chunks = splitMessage(response, maxLen);
        for (const chunk of chunks) {
          await adapter.sendText(msg.externalChatId, chunk);
        }
      }

      const recentMsgs = [msg.text, response].filter(Boolean);
      scheduleReflector(db, chatId, config, recentMsgs);
    } catch (err: any) {
      if (typingInterval) clearInterval(typingInterval);
      console.error(`[angel] Error processing message: ${err.message}`);
      if (adapter) {
        await adapter.sendText(msg.externalChatId, "Sorry, I encountered an error processing your message.");
      }
    }
  };

  await channels.startAll(messageHandler);

  setCodingAgentNotifier(async (agent, message) => {
    const adapter = channels.get(agent.channel);
    if (adapter && agent.externalChatId) {
      const chatId = upsertChat(db, agent.channel, agent.externalChatId, agent.channel, "system");
      const syntheticInput = `[System: coding agent "${agent.agent}" just finished a task. Here is the raw output — summarize it for me in your own words and let me know what happened.]\n\nOriginal task: ${agent.prompt}\n\n${message}`;
      try {
        const response = await processMessage(syntheticInput, {
          chatId,
          channel: agent.channel,
          db,
          config,
          registry,
          isOnboarding: false,
        });
        if (response) {
          const maxLen = adapter.maxMessageLength || 4000;
          const chunks = splitMessage(response, maxLen);
          for (const chunk of chunks) {
            await adapter.sendText(agent.externalChatId, chunk);
          }
        }
      } catch (err: any) {
        console.error(`[angel] Error processing agent result: ${err.message}`);
        const maxLen = adapter.maxMessageLength || 4000;
        const chunks = splitMessage(message, maxLen);
        for (const chunk of chunks) {
          await adapter.sendText(agent.externalChatId, chunk);
        }
      }
    }
  });

  startScheduler(db, config, registry, channels);

  p.log.success(`Started with ${color.cyan(String(registry.count()))} tools, ${color.cyan(String(channels.all().length))} channels`);
  p.log.info(`Model: ${color.dim(config.model)} | Timezone: ${color.dim(config.timezone)}`);

  process.on("SIGINT", async () => {
    console.log("\n[angel] Shutting down...");
    await channels.stopAll();
    await shutdownMcpServers();
    process.exit(0);
  });
}

