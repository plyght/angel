import { readFileSync, existsSync } from "fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { homedir } from "os";
import { join } from "path";

export interface ChannelConfig {
  enabled?: boolean;
  allowed_users?: string[];
}

export interface iMessageConfig extends ChannelConfig {
  service?: string;
}

export interface DiscordConfig extends ChannelConfig {
  token?: string;
  bot_username?: string;
}

export interface SlackConfig extends ChannelConfig {
  bot_token?: string;
  app_token?: string;
}

export interface SignalConfig extends ChannelConfig {
  account?: string;
  signal_cli_path?: string;
  allowed_numbers?: string[];
}

export interface MemoryConfig {
  reflector_enabled: boolean;
  reflector_interval_ms: number;
  embedding_enabled: boolean;
  token_budget: number;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AngelConfig {
  openai_api_key: string;
  anthropic_api_key?: string;
  model: string;
  max_tokens: number;
  max_tool_iterations: number;
  max_history_messages: number;
  compaction_threshold: number;
  compaction_keep_recent: number;
  working_dir: string;
  working_dir_isolation: "none" | "per_chat";
  data_dir: string;
  soul_md_path?: string;
  timezone: string;
  channels: {
    imessage?: iMessageConfig;
    discord?: DiscordConfig;
    slack?: SlackConfig;
    signal?: SignalConfig;
  };
  memory: MemoryConfig;
  hooks_dir?: string;
  plugins_dir?: string;
  skills_dir?: string;
  mcp_servers?: Record<string, McpServerConfig>;
  sandbox?: { mode: "none" | "subprocess" };
  safe_word?: string;
}

const DEFAULT_DATA_DIR = join(homedir(), ".angel");

export const DEFAULTS: AngelConfig = {
  openai_api_key: "",
  model: "gpt-5.4",
  max_tokens: 8192,
  max_tool_iterations: 50,
  max_history_messages: 50,
  compaction_threshold: 40,
  compaction_keep_recent: 20,
  working_dir: join(DEFAULT_DATA_DIR, "working_dir"),
  working_dir_isolation: "per_chat",
  data_dir: DEFAULT_DATA_DIR,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  channels: {},
  memory: {
    reflector_enabled: true,
    reflector_interval_ms: 15 * 60 * 1000,
    embedding_enabled: false,
    token_budget: 1500,
  },
};

export function configPath(): string {
  return process.env.ANGEL_CONFIG || join(DEFAULT_DATA_DIR, "config");
}

export function configExists(): boolean {
  return existsSync(configPath());
}

export function loadConfig(): AngelConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { ...DEFAULTS };
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) || {};
  return resolveEnvVars(deepMerge(DEFAULTS, parsed)) as AngelConfig;
}

export function saveConfig(config: Partial<AngelConfig>): void {
  const path = configPath();
  const dir = join(path, "..");
  if (!existsSync(dir)) {
    require("fs").mkdirSync(dir, { recursive: true });
  }
  const yaml = stringifyYaml(config);
  require("fs").writeFileSync(path, yaml, "utf-8");
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

export function resolveEnvVars(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || "");
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === "object") {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return obj;
}
