<div align="center">
    <img src="asssets/weeping_angel.png" width="120" />
    <h3>Angel</h3>
    <p>Autonomous AI agent with multi-channel support, persistent memory, and an extensible tool system</p>
    <br/>
    <br/>
</div>

A self-directed assistant that connects to your communication platforms and gets things done. Angel receives messages from Discord, Slack, iMessage, and Signal, reasons through tasks using LLM-powered tool loops, and maintains long-term memory across conversations.

## Features

- **Multi-Channel**: Connects to Discord, Slack, iMessage, and Signal simultaneously
- **Tool System**: Built-in tools for shell execution, file operations, web search, browser automation, and more
- **Persistent Memory**: SQLite-backed memory with automatic reflection, duplicate detection, and scoped recall
- **Scheduled Tasks**: Cron-based task scheduling with timezone support, retry logic, and dead-letter handling
- **Subagents**: Spawn isolated child agents for parallel task execution
- **MCP Integration**: Dynamically load tools from Model Context Protocol servers
- **Extensible**: Hooks, plugins, skills, and custom tool registration
- **Security**: Command guardrails, secret scrubbing, SSRF protection, and credential access blocking

## Install

```bash
git clone https://github.com/plyght/angel.git
cd angel
bun install
```

## Setup

```bash
bun run setup
```

The setup wizard walks through API key configuration, channel setup, and initial preferences. Configuration is stored at `~/.angel/angel.config.yaml`.

## Usage

```bash
bun run start

bun run dev    # file watching (development)

bun run doctor # diagnostics
```

Channel adapters connect automatically based on your configuration. Talk to Angel through any enabled channel.

Built-in chat commands: `/help`, `/model`, `/memory`, `/usage`, `/clear`, `/version`

## Channels

### Discord

1. Create a bot at [discord.com/developers](https://discord.com/developers/applications)
2. Enable the Message Content intent
3. Generate a bot token and add it to your config

```yaml
channels:
  discord:
    enabled: true
    token: "your-bot-token"
```

### Slack

Setting up Slack is straightforward:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app **from scratch**
2. Go to **OAuth & Permissions** and add these bot token scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`
3. Go to **Socket Mode** and enable it — this generates your `app_token` (`xapp-...`)
4. Go to **Event Subscriptions**, enable events, and subscribe to `message.im` and `app_mention`
5. Install the app to your workspace — this gives you the `bot_token` (`xoxb-...`)

```yaml
channels:
  slack:
    enabled: true
    bot_token: "xoxb-..."
    app_token: "xapp-..."
```

That's it. No public URL, no ngrok, no webhook server — Socket Mode handles everything over a WebSocket.

### Signal

Signal requires `signal-cli` and a phone number. Here's a cheap way to get one:

1. Create a [Google Voice](https://voice.google.com) account and get a free number
2. Install `signal-cli` ([github.com/AsamK/signal-cli](https://github.com/AsamK/signal-cli))
3. Register your Google Voice number with Signal using `signal-cli`:
   ```bash
   signal-cli -a +1YOURGVOICENUMBER register
   ```
   The verification code arrives as a text in Google Voice. Complete with:
   ```bash
   signal-cli -a +1YOURGVOICENUMBER verify CODE
   ```
4. Add to your config:

```yaml
channels:
  signal:
    enabled: true
    account: "+1YOURGVOICENUMBER"
```

Now anyone can text that number on Signal and talk to Angel. Works from anywhere — Signal's servers relay messages, so your Mac just needs to be on and running Angel.

### iMessage

```yaml
channels:
  imessage:
    enabled: true
```

Requires macOS. Uses the local Messages database directly.

## Configuration

Angel uses YAML configuration at `~/.angel/angel.config.yaml`:

```yaml
openai_api_key: "${OPENAI_API_KEY}"
model: "gpt-4.1"
max_tokens: 8192
max_tool_iterations: 50
timezone: "America/New_York"

channels:
  discord:
    enabled: true
    token: "${DISCORD_TOKEN}"
  slack:
    enabled: true
    bot_token: "${SLACK_BOT_TOKEN}"
    app_token: "${SLACK_APP_TOKEN}"
  signal:
    enabled: true
    account: "+1234567890"

memory:
  reflector_enabled: true
  reflector_interval_ms: 900000

working_dir_isolation: "per_chat"
data_dir: "~/.angel"
```

Values wrapped in `${VAR}` are resolved from environment variables.

## Architecture

- `agent.ts`: Core message processing and tool execution loop
- `llm.ts`: OpenAI integration with streaming support
- `db.ts`: SQLite database layer (WAL mode, migrations)
- `memory.ts`: Memory storage, reflection, and retrieval
- `scheduler.ts`: Cron-based task scheduling engine
- `channels/`: Channel adapters (discord, slack, imessage, signal)
- `tools/`: Tool implementations (bash, files, web, browser, subagent, etc.)

## Security

Angel includes several layers of protection to prevent the LLM from being tricked into harmful actions:

- **Command guardrails**: 46 blocked patterns covering destructive operations, credential theft, data exfiltration, privilege escalation, and system tampering
- **Secret scrubbing**: API keys, tokens, and private keys in command output are automatically redacted before the LLM sees them
- **File access control**: Sensitive paths (`.ssh`, `.aws`, `.env`, angel config) are blocked from the file tools
- **SSRF protection**: `web_fetch` blocks requests to private/internal IP ranges
- **No credential leaks**: Config API redacts all tokens and secrets

## Development

```bash
bun run dev
```

Requires Bun 1.0+. Key dependencies: openai, discord.js, @slack/bolt, cron-parser, yaml.

## License

MIT License
