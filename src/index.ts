#!/usr/bin/env bun
import type { Database as BunDatabase } from "bun:sqlite";
import * as p from "@clack/prompts";
import color from "picocolors";
import {
  type ChannelConfig,
  configExists,
  configPath,
  loadConfig,
} from "./config";

function getAllowedUsers(
  db: BunDatabase,
  channel: string,
  configList?: string[],
): Set<string> | null {
  const dbRows = db
    .query("SELECT user_id FROM allowed_users WHERE channel = ?")
    .all(channel) as { user_id: string }[];

  const combined = new Set<string>();
  if (configList) for (const u of configList) combined.add(u);
  for (const row of dbRows) combined.add(row.user_id);

  return combined.size > 0 ? combined : null;
}

import { INTERRUPTED, processMessage } from "./agent";
import { DiscordChannel } from "./channels/discord";
import { iMessageChannel } from "./channels/imessage";
import { SignalChannel } from "./channels/signal";
import { SlackChannel } from "./channels/slack";
import { ChannelRegistry, splitResponse } from "./channels/types";
import { handleCommand } from "./commands";
import { getDb, storeMessage, upsertChat } from "./db";
import { runDoctor } from "./doctor";
import { initMcpServers, shutdownMcpServers } from "./mcp";
import { handleExplicitMemory, scheduleReflector } from "./memory";
import { loadPlugins } from "./plugins";
import { startScheduler } from "./scheduler";
import { runSetup } from "./setup";
import { discoverSkills } from "./skills";
import {
  backgroundProcessTools,
  killAllBackgroundProcesses,
  persistBackgroundProcesses,
  restoreBackgroundProcesses,
  setBackgroundProcessDataDir,
  setBackgroundProcessNotifier,
} from "./tools/background_processes";
import { bashTool } from "./tools/bash";
import { browserTool } from "./tools/browser";
import {
  codingAgentTools,
  killAllCodingAgents,
  persistRunningAgents,
  restoreRunningAgents,
  setCodingAgentDataDir,
  setCodingAgentNotifier,
  setCodingAgentProgressNotifier,
} from "./tools/coding_agents";
import { confirmationTools } from "./tools/confirmation";
import { emitMessageTool } from "./tools/emit_message";
import { fileTools } from "./tools/files";
import { memoryTools } from "./tools/memory";
import { miscTools } from "./tools/misc";
import { ToolRegistry } from "./tools/registry";
import { remoteTools } from "./tools/remote";
import { scheduleTools } from "./tools/schedule";
import { sendMessageTool, setSendMessageDeps } from "./tools/send_message";
import { subagentTools } from "./tools/subagent";
import { webTools } from "./tools/web";

const { version: VERSION } = require("../package.json");
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
      const proc = Bun.spawn([editor, configPath()], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
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
      p.log.info(
        `Channels:   ${enabledChannels.length ? color.cyan(enabledChannels.join(", ")) : color.dim("none")}`,
      );
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
      message:
        "This will clear your onboarding data and profile memories. Continue?",
    });
    if (p.isCancel(confirm) || !confirm) {
      p.cancel("Reset cancelled.");
      break;
    }
    const config = loadConfig();
    const db = getDb(config.data_dir);
    db.run("DELETE FROM db_meta WHERE key IN ('onboarded', 'onboarding_chat')");
    db.run("DELETE FROM memories WHERE category = 'profile'");
    p.log.success(
      "Onboarding and profile data cleared. Next message will restart onboarding.",
    );
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
    p.outro(
      "Angel can use any installed agent via the spawn_coding_agent tool.",
    );
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

  // Set up coding agent persistence directory
  setCodingAgentDataDir(config.data_dir);

  // Set up background process persistence directory
  setBackgroundProcessDataDir(config.data_dir);

  registry.register(bashTool);
  registry.registerMany(fileTools);
  registry.registerMany(webTools);
  registry.registerMany(miscTools);
  registry.registerMany(memoryTools);
  registry.registerMany(scheduleTools);
  registry.registerMany(subagentTools);
  registry.register(sendMessageTool);
  registry.register(emitMessageTool);
  registry.register(browserTool);
  registry.registerMany(codingAgentTools);
  registry.registerMany(backgroundProcessTools);
  registry.registerMany(confirmationTools);
  registry.registerMany(remoteTools);

  const mcpTools = await initMcpServers(config);
  registry.registerMany(mcpTools);

  const skillTools = discoverSkills(config);
  registry.registerMany(skillTools);

  const pluginTools = loadPlugins(config);
  registry.registerMany(pluginTools);

  setSendMessageDeps(channels, db);

  if (config.channels.imessage?.enabled) {
    channels.register(
      new iMessageChannel(
        config.channels.imessage.imsg_path,
        config.channels.imessage.service,
        config.channels.imessage.region,
        config.channels.imessage.allowed_handles,
      ),
    );
  }
  if (config.channels.discord?.enabled && config.channels.discord.token) {
    channels.register(
      new DiscordChannel(
        config.channels.discord.token,
        config.channels.discord.bot_username,
      ),
    );
  }
  if (
    config.channels.slack?.enabled &&
    config.channels.slack.bot_token &&
    config.channels.slack.app_token
  ) {
    channels.register(
      new SlackChannel(
        config.channels.slack.bot_token,
        config.channels.slack.app_token,
      ),
    );
  }
  if (config.channels.signal?.enabled && config.channels.signal.account) {
    channels.register(
      new SignalChannel(
        config.channels.signal.account,
        config.channels.signal.signal_cli_path,
        config.channels.signal.allowed_numbers,
      ),
    );
  }

  const activeChats: Map<number, AbortController> = new Map();

  const messageHandler = async (msg: any) => {
    const channelKey = msg.chatType.split("_")[0];
    const channelConfig = (config.channels as any)[channelKey] as
      | ChannelConfig
      | undefined;
    const allowedUsers = getAllowedUsers(
      db,
      channelKey,
      channelConfig?.allowed_users,
    );
    if (allowedUsers && !allowedUsers.has(msg.senderName)) {
      return;
    }

    const chatId = upsertChat(
      db,
      channelKey,
      msg.externalChatId,
      msg.chatType,
      msg.senderName,
    );

    // Handle reactions: log them and store in message history for context,
    // but don't trigger a full LLM response (reactions are informational)
    if (msg.isReaction) {
      console.log(`[angel] Received reaction in chat ${chatId}: ${msg.text}`);
      // Store reaction as a user message for context in future turns
      storeMessage(db, chatId, "user", msg.text, {
        senderName: msg.senderName,
      });
      // Don't process further - reactions don't need a response
      return;
    }

    const existing = activeChats.get(chatId);
    if (existing) {
      existing.abort();
      await new Promise((r) => setTimeout(r, 50));
    }

    const controller = new AbortController();
    activeChats.set(chatId, controller);

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
      if (cmdResult.action === "restart") {
        const persistedAgents = persistRunningAgents();
        const persistedProcesses = persistBackgroundProcesses();
        console.log(
          `[angel] Restart requested. Preserving ${persistedAgents} coding agent(s) and ${persistedProcesses} background process(es)...`,
        );
        await channels.stopAll();
        await shutdownMcpServers();
        process.exit(0);
      }
      return;
    }

    const onboarded = db
      .query("SELECT value FROM db_meta WHERE key = 'onboarded'")
      .get() as { value: string } | null;
    if (!onboarded) {
      const msgCount = db
        .query("SELECT COUNT(*) as count FROM messages WHERE chat_id = ?")
        .get(chatId) as { count: number };
      if (msgCount.count === 0) {
        db.run(
          "INSERT OR REPLACE INTO db_meta (key, value) VALUES ('onboarding_chat', ?)",
          [String(chatId)],
        );
      }
      const onboardingChat = db
        .query("SELECT value FROM db_meta WHERE key = 'onboarding_chat'")
        .get() as { value: string } | null;
      if (onboardingChat && parseInt(onboardingChat.value, 10) === chatId) {
        const memories = db
          .query(
            "SELECT COUNT(*) as count FROM memories WHERE category = 'profile'",
          )
          .get() as { count: number };
        if (memories.count >= 3) {
          db.run(
            "INSERT OR REPLACE INTO db_meta (key, value) VALUES ('onboarded', '1')",
          );
        }
      }
    }

    const channelName = msg.chatType.split("_")[0];
    const adapter = channels.get(channelName);

    let typingInterval: ReturnType<typeof setInterval> | null = null;
    if (adapter?.sendTyping) {
      adapter.sendTyping(msg.externalChatId);
      typingInterval = setInterval(
        () => adapter.sendTyping!(msg.externalChatId),
        4000,
      );
    }

    try {
      const image = msg.imageBase64
        ? {
            base64: msg.imageBase64,
            mimeType: msg.imageMimeType || "image/jpeg",
          }
        : undefined;
      const onboardedCheck = db
        .query("SELECT value FROM db_meta WHERE key = 'onboarded'")
        .get() as { value: string } | null;
      const onboardingChatCheck = db
        .query("SELECT value FROM db_meta WHERE key = 'onboarding_chat'")
        .get() as { value: string } | null;
      const isOnboarding =
        !onboardedCheck &&
        onboardingChatCheck &&
        parseInt(onboardingChatCheck.value, 10) === chatId;
      const userText = msg.isGroupMention
        ? `[${msg.senderName}]: ${msg.text}`
        : msg.text;
      const sendIntermediate = async (text: string) => {
        if (adapter) {
          const maxLen = adapter.maxMessageLength || 4000;
          const chunks = splitResponse(text, maxLen);
          for (const chunk of chunks) {
            await adapter.sendText(msg.externalChatId, chunk);
          }
        }
      };

      const response = await processMessage(
        userText,
        {
          chatId,
          channel: channelName,
          db,
          config,
          registry,
          isOnboarding: !!isOnboarding,
          signal: controller.signal,
          senderName: msg.senderName,
          senderDmId: msg.isGroupMention
            ? msg.senderDmId || msg.senderName
            : undefined,
          sendIntermediate,
        },
        image,
      );

      if (typingInterval) clearInterval(typingInterval);

      if (response === INTERRUPTED) {
        console.log(`[angel] Chat ${chatId} interrupted by new message`);
        return;
      }

      if (adapter && response) {
        const maxLen = adapter.maxMessageLength || 4000;
        const chunks = splitResponse(response, maxLen);
        for (const chunk of chunks) {
          await adapter.sendText(msg.externalChatId, chunk);
        }
      }

      const recentMsgs = [msg.text, response].filter(Boolean);
      scheduleReflector(db, chatId, config, recentMsgs);
    } catch (err: any) {
      if (typingInterval) clearInterval(typingInterval);
      if (controller.signal.aborted) return;
      console.error(`[angel] Error processing message: ${err.message}`);
      if (adapter) {
        await adapter.sendText(
          msg.externalChatId,
          "Sorry, I encountered an error processing your message.",
        );
      }
    } finally {
      if (activeChats.get(chatId) === controller) activeChats.delete(chatId);
    }
  };

  await channels.startAll(messageHandler);

  setCodingAgentNotifier(async (agent, message) => {
    const adapter = channels.get(agent.channel);
    if (adapter && agent.externalChatId) {
      const chatId = upsertChat(
        db,
        agent.channel,
        agent.externalChatId,
        agent.channel,
        "system",
      );
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
        if (typeof response === "string" && response) {
          const maxLen = adapter.maxMessageLength || 4000;
          const chunks = splitResponse(response, maxLen);
          for (const chunk of chunks) {
            await adapter.sendText(agent.externalChatId, chunk);
          }
        }
      } catch (err: any) {
        console.error(`[angel] Error processing agent result: ${err.message}`);
        const maxLen = adapter.maxMessageLength || 4000;
        const chunks = splitResponse(message, maxLen);
        for (const chunk of chunks) {
          await adapter.sendText(agent.externalChatId, chunk);
        }
      }
    }
  });

  // Optional: Send progress updates for long-running coding agents
  setCodingAgentProgressNotifier(async (agent, progressMessage) => {
    const adapter = channels.get(agent.channel);
    if (adapter && agent.externalChatId) {
      try {
        await adapter.sendText(
          agent.externalChatId,
          `[${agent.agent} #${agent.id}] ${progressMessage}`,
        );
      } catch (err: any) {
        console.error(`[angel] Error sending progress: ${err.message}`);
      }
    }
  });

  // Restore any coding agents that were running before restart
  const restoredAgents = restoreRunningAgents();
  if (restoredAgents > 0) {
    p.log.info(
      `Restored ${color.cyan(String(restoredAgents))} coding agent(s) from previous session`,
    );
  }

  // Set up background process notifier
  setBackgroundProcessNotifier(async (proc, message) => {
    const adapter = channels.get(proc.channel);
    if (adapter && proc.externalChatId) {
      try {
        const maxLen = adapter.maxMessageLength || 4000;
        const chunks = splitResponse(message, maxLen);
        for (const chunk of chunks) {
          await adapter.sendText(proc.externalChatId, chunk);
        }
      } catch (err: any) {
        console.error(`[angel] Error notifying process exit: ${err.message}`);
      }
    }
  });

  // Restore any background processes that were running before restart
  const restoredProcesses = restoreBackgroundProcesses();
  if (restoredProcesses > 0) {
    p.log.info(
      `Restored ${color.cyan(String(restoredProcesses))} background process(es) from previous session`,
    );
  }

  startScheduler(db, config, registry, channels);

  p.log.success(
    `Started with ${color.cyan(String(registry.count()))} tools, ${color.cyan(String(channels.all().length))} channels`,
  );
  p.log.info(
    `Model: ${color.dim(config.model)} | Timezone: ${color.dim(config.timezone)}`,
  );

  process.on("SIGINT", async () => {
    console.log("\n[angel] Shutting down...");
    const forceExit = setTimeout(() => {
      console.error("[angel] Graceful shutdown timed out, forcing exit.");
      process.exit(1);
    }, 10_000);
    try {
      killAllCodingAgents();
      killAllBackgroundProcesses();
      await channels.stopAll();
      await shutdownMcpServers();
    } catch (err: any) {
      console.error(`[angel] Shutdown error: ${err.message}`);
    }
    clearTimeout(forceExit);
    process.exit(0);
  });
}
