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
- **36+ Built-in Tools**: Shell execution, file operations, web search, browser automation, coding agents, cross-chat messaging, and more
- **Persistent Memory**: SQLite + file-backed memory with reflection, confidence scoring, duplicate detection, and scoped recall
- **Scheduled Tasks**: Cron-based and one-shot task scheduling with timezone support, retry logic, and dead-letter handling
- **Coding Agents**: Spawn external agents (Claude Code, Codex, Aider, Goose, Amp) for background work
- **Subagents**: Spawn isolated child agents for parallel task execution (max depth 2, max concurrent 4)
- **Confirmations**: Multi-step safe-word verification for dangerous operations via DM
- **Message Compaction**: Automatic conversation summarization when context grows large
- **Onboarding**: Guided new-user flow with profile and preference gathering
- **MCP Integration**: Dynamically load tools from Model Context Protocol servers
- **Hooks, Plugins, Skills**: Event interception, manifest-based plugins, and skill files for extensibility
- **Access Control**: Per-channel user allowlists with runtime management
- **Security**: 46 blocked command patterns, secret scrubbing, file access control, SSRF protection, and safe-word gating

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

### Chat Commands

`/help` · `/new` · `/model [name]` · `/memory` · `/usage` · `/settings` · `/clear` · `/reset` · `/version`

## Tools

### Shell & Files

| Tool | Description |
|------|-------------|
| `bash` | Command execution with 46 blocked patterns and secret scrubbing |
| `read_file` | Read file contents |
| `write_file` | Write file contents |
| `edit_file` | Apply edits to existing files |
| `glob` | File pattern matching |
| `grep` | Regex search across files |

### Web & Browser

| Tool | Description |
|------|-------------|
| `web_search` | DuckDuckGo search |
| `web_fetch` | Fetch page content with SSRF protection |
| `browser` | Playwright-based page rendering with fetch fallback |

### Memory

| Tool | Description |
|------|-------------|
| `read_memory` | Retrieve stored memories |
| `write_memory` | Store memories (database or file-backed via AGENTS.md) |
| `search_memory` | Search with confidence scoring |
| `update_memory` | Modify existing memories |
| `delete_memory` | Soft-delete memories |

### Scheduling

| Tool | Description |
|------|-------------|
| `schedule_task` | Create cron or one-shot scheduled tasks |
| `list_scheduled_tasks` | Filter by status (active, paused, completed, failed) |
| `update_task` | Modify task properties |
| `cancel_task` | Pause or cancel tasks |

### Coding Agents

| Tool | Description |
|------|-------------|
| `spawn_coding_agent` | Run external agents in background (claude, codex, aider, goose, amp) |
| `coding_agent_status` | Check output and status of running agents |
| `kill_coding_agent` | Terminate a running agent |
| `list_coding_agents` | Show installed external agents |

### Confirmations

| Tool | Description |
|------|-------------|
| `request_confirmation` | Create pending confirmation requiring DM safe-word verification |
| `check_pending_confirmations` | List awaiting confirmations |
| `approve_confirmation` | Execute after safe-word match |
| `deny_confirmation` | Cancel a pending confirmation |

### Communication & Utilities

| Tool | Description |
|------|-------------|
| `send_message` | Send messages to other chats/channels proactively |
| `list_chats` | Discover all known chats across channels |
| `read_chat_history` | Read messages from other chats |
| `manage_allowed_users` | Add/remove/list per-channel access controls |
| `spawn_subagent` | Spawn isolated child agents |
| `list_subagents` | List running subagents |
| `todo` | Per-chat todo list management |
| `get_current_time` | Timezone-aware time queries |
| `export_chat` | Export conversation to markdown |
| `calculate` | Math expression evaluation |
| `verify_safe_word` | Test safe word without executing actions |

Additional tools are loaded dynamically from MCP servers, plugins, and skills.

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

No public URL, no ngrok, no webhook server — Socket Mode handles everything over a WebSocket.

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

Anyone can text that number on Signal and talk to Angel. Signal's servers relay messages, so your Mac just needs to be on and running Angel.

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
model: "gpt-5.4"
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

compaction_threshold: 40
working_dir_isolation: "per_chat"
data_dir: "~/.angel"
```

Values wrapped in `${VAR}` are resolved from environment variables.

### Extensibility

- **Hooks**: JSON config files in `~/.angel/hooks/` with event triggers, commands, and timeouts
- **Plugins**: Manifest-based tool and command bundles in `~/.angel/plugins/`
- **Skills**: SKILL.md instruction files in `~/.angel/skills/`
- **MCP Servers**: Config-driven subprocess integration with dynamic tool loading

## Architecture

```
src/
├── index.ts          Entry point
├── agent.ts          Core message processing, tool loop, image support, onboarding
├── llm.ts            OpenAI integration with streaming and message compaction
├── config.ts         YAML config loading with env var resolution
├── db.ts             SQLite layer (WAL mode, migrations)
├── memory.ts         Memory storage, reflection, confidence scoring, file-backed memory
├── scheduler.ts      Cron + one-shot task scheduling engine
├── subagents.ts      Isolated child agent spawning
├── commands.ts       Chat command routing
├── hooks.ts          Event hook system (before_llm interception)
├── plugins.ts        Plugin manifest loading
├── skills.ts         Skill discovery and activation
├── mcp.ts            Model Context Protocol server integration
├── doctor.ts         Connectivity and accessibility diagnostics
├── setup.ts          Interactive setup wizard
├── channels/
│   ├── discord.ts    Discord adapter
│   ├── slack.ts      Slack adapter (Socket Mode)
│   ├── imessage.ts   iMessage adapter (macOS)
│   ├── signal.ts     Signal adapter (signal-cli)
│   └── types.ts      Channel interface definitions
└── tools/
    ├── registry.ts       Tool registration and routing
    ├── bash.ts           Shell execution with guardrails
    ├── files.ts          File read/write/edit/glob/grep
    ├── web.ts            Web search and fetch
    ├── browser.ts        Playwright browser automation
    ├── memory.ts         Memory CRUD tools
    ├── schedule.ts       Scheduling tools
    ├── subagent.ts       Subagent tools
    ├── coding_agents.ts  External coding agent integration
    ├── confirmation.ts   Safe-word confirmation workflow
    ├── send_message.ts   Cross-chat messaging
    └── misc.ts           Utilities (time, todo, export, calculate)
```

## Security

- **Command guardrails**: 46 blocked patterns covering destructive operations, credential theft, data exfiltration, privilege escalation, and system tampering
- **Secret scrubbing**: OpenAI keys, Slack tokens, GitHub tokens, SSH/RSA/EC private keys automatically redacted from command output
- **File access control**: Sensitive paths (`.ssh`, `.aws`, `.gnupg`, `.env`, credentials, angel config) blocked from file tools
- **SSRF protection**: `web_fetch` blocks requests to private/internal IP ranges
- **Safe-word system**: Configurable phrase required for dangerous operations, verified via DM
- **Per-channel access control**: User allowlists managed via config and runtime tools

## Development

```bash
bun run dev
```

Requires Bun 1.0+. Key dependencies: openai, discord.js, @slack/bolt, cron-parser, yaml.

## License

MIT License
