<div align="center">
    <img src="asssets/weeping_angel.png" width="120" />
    <h3>Angel</h3>
    <p>Autonomous AI agent with multi-channel support, persistent memory, and an extensible tool system</p>
    <br/>
    <br/>
</div>

A self-directed assistant that connects to your communication platforms and gets things done. Angel receives messages from Web, Discord, Slack, iMessage, and Signal, reasons through tasks using LLM-powered tool loops, and maintains long-term memory across conversations.

## Features

- **Multi-Channel**: Connects to Web UI, Discord, Slack, iMessage, and Signal simultaneously
- **Tool System**: Built-in tools for shell execution, file operations, web search, browser automation, and more
- **Persistent Memory**: SQLite-backed memory with automatic reflection, duplicate detection, and scoped recall
- **Scheduled Tasks**: Cron-based task scheduling with timezone support, retry logic, and dead-letter handling
- **Subagents**: Spawn isolated child agents for parallel task execution
- **MCP Integration**: Dynamically load tools from Model Context Protocol servers
- **Extensible**: Hooks, plugins, skills, and custom tool registration
- **Streaming UI**: Real-time WebSocket interface with tool execution visibility

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
# Start the agent
bun run start

# Start with file watching (development)
bun run dev

# Run diagnostics
bun run doctor
```

Once running, the web interface is available at `http://localhost:3000`. Channel adapters (Discord, Slack, etc.) connect automatically based on your configuration.

Built-in chat commands: `/help`, `/model`, `/memory`, `/usage`, `/clear`, `/version`

## Configuration

Angel uses YAML configuration at `~/.angel/angel.config.yaml`:

```yaml
openai_api_key: "${OPENAI_API_KEY}"
model: "gpt-4.1"
max_tokens: 8192
max_tool_iterations: 50
timezone: "America/New_York"

channels:
  web:
    enabled: true
    port: 3000
    host: "127.0.0.1"
  discord:
    enabled: false
    bot_token: ""
  slack:
    enabled: false
    bot_token: ""
    app_token: ""

memory:
  reflector_enabled: true
  reflector_interval_ms: 900000

working_dir_isolation: "per_chat"
data_dir: "~/.angel"
```

## Architecture

- `agent.ts`: Core message processing and tool execution loop
- `llm.ts`: OpenAI integration with streaming support
- `db.ts`: SQLite database layer (WAL mode, migrations)
- `memory.ts`: Memory storage, reflection, and retrieval
- `scheduler.ts`: Cron-based task scheduling engine
- `channels/`: Channel adapters (web, discord, slack, imessage, signal)
- `tools/`: Tool implementations (bash, files, web, browser, subagent, etc.)
- `web/`: HTTP + WebSocket server, API routes, agent-to-agent protocol
- `ui/`: Web client interface

## Development

```bash
bun run dev
```

Requires Bun 1.0+. Key dependencies: openai, discord.js, @slack/bolt, cron-parser, yaml.

## License

MIT License
