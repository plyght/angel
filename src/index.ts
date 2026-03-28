import { loadConfig, configExists } from "./config";
import { getDb, upsertChat } from "./db";
import { processMessage } from "./agent";
import { ToolRegistry } from "./tools/registry";
import { ChannelRegistry, splitMessage } from "./channels/types";
import { WebChannel } from "./channels/web";
import { bashTool } from "./tools/bash";
import { fileTools } from "./tools/files";
import { webTools } from "./tools/web";
import { miscTools } from "./tools/misc";
import { memoryTools } from "./tools/memory";
import { scheduleTools } from "./tools/schedule";
import { subagentTools } from "./tools/subagent";
import { sendMessageTool, setSendMessageDeps } from "./tools/send_message";
import { browserTool } from "./tools/browser";
import { handleCommand } from "./commands";
import { handleExplicitMemory, scheduleReflector } from "./memory";
import { startScheduler } from "./scheduler";
import { startWebServer } from "./web/server";
import { startAcpServer } from "./web/acp";
import { initMcpServers, shutdownMcpServers } from "./mcp";
import { discoverSkills } from "./skills";
import { loadPlugins } from "./plugins";
import { runDoctor } from "./doctor";
import { runSetup } from "./setup";
import { iMessageChannel } from "./channels/imessage";
import { DiscordChannel } from "./channels/discord";
import { SlackChannel } from "./channels/slack";
import { SignalChannel } from "./channels/signal";

const command = process.argv[2] || "start";

switch (command) {
  case "setup":
    await runSetup();
    break;

  case "doctor":
    await runDoctor();
    break;

  case "version":
    console.log("Angel v0.1.0");
    break;

  case "acp":
    await bootAcp();
    break;

  case "start":
  default:
    await boot();
    break;
}

async function boot() {
  if (!configExists()) {
    console.log("[angel] No config found. Running setup...\n");
    await runSetup();
    return;
  }

  const config = loadConfig();
  if (!config.openai_api_key) {
    console.error("[angel] Error: openai_api_key not set in config. Run 'angel setup'.");
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

  const mcpTools = await initMcpServers(config);
  registry.registerMany(mcpTools);

  const skillTools = discoverSkills(config);
  registry.registerMany(skillTools);

  const pluginTools = loadPlugins(config);
  registry.registerMany(pluginTools);

  setSendMessageDeps(channels, db);

  const webChannel = new WebChannel();
  channels.register(webChannel);

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
    channels.register(new SignalChannel(config.channels.signal.account, config.channels.signal.signal_cli_path));
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
        onTextDelta: channelName === "web" ? (delta) => (webChannel as WebChannel).sendTextDelta(msg.externalChatId, delta) : undefined,
        onToolStart: channelName === "web" ? (name, input) => (webChannel as WebChannel).sendToolEvent(msg.externalChatId, "tool_start", { name }) : undefined,
        onToolResult: channelName === "web" ? (name, result) => (webChannel as WebChannel).sendToolEvent(msg.externalChatId, "tool_result", { name, result: result.slice(0, 200) }) : undefined,
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

  startWebServer(db, config, registry, channels, webChannel);

  startScheduler(db, config, registry, channels);

  console.log(`[angel] Started with ${registry.count()} tools, ${channels.all().length} channels`);

  process.on("SIGINT", async () => {
    console.log("\n[angel] Shutting down...");
    await channels.stopAll();
    await shutdownMcpServers();
    process.exit(0);
  });
}

async function bootAcp() {
  const config = loadConfig();
  const db = getDb(config.data_dir);
  const registry = new ToolRegistry();

  registry.register(bashTool);
  registry.registerMany(fileTools);
  registry.registerMany(webTools);
  registry.registerMany(miscTools);
  registry.registerMany(memoryTools);

  await startAcpServer(db, config, registry);
}
