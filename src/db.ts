import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

let _db: Database | null = null;

export function getDb(dataDir: string): Database {
  if (_db) return _db;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  _db = new Database(join(dataDir, "angel.db"));
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS db_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const version = db.query("SELECT value FROM db_meta WHERE key = 'schema_version'").get() as { value: string } | null;
  const current = version ? parseInt(version.value) : 0;

  const migrations = [
    migrationV1,
    migrationV2,
  ];

  for (let i = current; i < migrations.length; i++) {
    migrations[i](db);
    db.run("INSERT OR REPLACE INTO db_meta (key, value) VALUES ('schema_version', ?)", [String(i + 1)]);
  }
}

function migrationV1(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL DEFAULT 'private',
      title TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(channel, external_chat_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      role TEXT NOT NULL DEFAULT 'user',
      sender_name TEXT,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_call_id TEXT,
      is_from_bot INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp);

    CREATE TABLE IF NOT EXISTS sessions (
      chat_id INTEGER PRIMARY KEY REFERENCES chats(id),
      messages_json TEXT,
      model_override TEXT,
      compaction_summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      confidence REAL DEFAULT 0.8,
      source TEXT DEFAULT 'user',
      is_archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id);
    CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(is_archived, updated_at);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER REFERENCES chats(id),
      name TEXT,
      prompt TEXT NOT NULL,
      cron_expr TEXT,
      next_run_at TEXT,
      status TEXT DEFAULT 'active',
      timezone TEXT DEFAULT 'UTC',
      max_retries INTEGER DEFAULT 3,
      retry_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status, next_run_at);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER REFERENCES scheduled_tasks(id),
      chat_id INTEGER,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      success INTEGER,
      result_summary TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduled_task_dlq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      chat_id INTEGER,
      failed_at TEXT DEFAULT (datetime('now')),
      error_text TEXT,
      original_prompt TEXT,
      retry_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS llm_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      duration_ms INTEGER,
      context TEXT DEFAULT 'agent_loop',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_created ON llm_usage_logs(created_at);

    CREATE TABLE IF NOT EXISTS subagent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      parent_run_id INTEGER,
      name TEXT,
      prompt TEXT,
      status TEXT DEFAULT 'running',
      result TEXT,
      depth INTEGER DEFAULT 0,
      max_iterations INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_reflector_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      started_at TEXT,
      finished_at TEXT,
      extracted_count INTEGER DEFAULT 0,
      inserted_count INTEGER DEFAULT 0,
      skipped_count INTEGER DEFAULT 0,
      error_text TEXT
    );

    CREATE TABLE IF NOT EXISTS hooks (
      name TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      command TEXT NOT NULL,
      timeout_ms INTEGER DEFAULT 5000,
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS plugins (
      name TEXT PRIMARY KEY,
      manifest_path TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      loaded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin_chat_id INTEGER NOT NULL,
      dm_chat_id INTEGER,
      channel TEXT NOT NULL,
      dm_id TEXT NOT NULL,
      action_description TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_confirmations(status, dm_id);

    CREATE TABLE IF NOT EXISTS allowed_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT DEFAULT 'config',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(channel, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_allowed_channel ON allowed_users(channel);
  `);
}

function migrationV2(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS allowed_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT DEFAULT 'config',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(channel, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_allowed_channel ON allowed_users(channel);

    CREATE TABLE IF NOT EXISTS pending_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin_chat_id INTEGER NOT NULL,
      dm_chat_id INTEGER,
      channel TEXT NOT NULL,
      dm_id TEXT NOT NULL,
      action_description TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_confirmations(status, dm_id);
  `);
}

export function upsertChat(db: Database, channel: string, externalChatId: string, chatType?: string, title?: string): number {
  db.run(
    `INSERT INTO chats (channel, external_chat_id, chat_type, title)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel, external_chat_id) DO UPDATE SET title = COALESCE(excluded.title, title)`,
    [channel, externalChatId, chatType || "private", title || null]
  );
  const row = db.query("SELECT id FROM chats WHERE channel = ? AND external_chat_id = ?").get(channel, externalChatId) as { id: number };
  return row.id;
}

export function storeMessage(
  db: Database,
  chatId: number,
  role: string,
  content: string,
  opts?: { senderName?: string; isFromBot?: boolean; toolCalls?: string; toolCallId?: string }
): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO messages (id, chat_id, role, content, sender_name, is_from_bot, tool_calls, tool_call_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, chatId, role, content, opts?.senderName || null, opts?.isFromBot ? 1 : 0, opts?.toolCalls || null, opts?.toolCallId || null]
  );
  return id;
}

export function getRecentMessages(db: Database, chatId: number, limit: number): any[] {
  return db.query(
    `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`
  ).all(chatId, limit).reverse();
}

export function saveSession(db: Database, chatId: number, messagesJson: string) {
  db.run(
    `INSERT INTO sessions (chat_id, messages_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET messages_json = excluded.messages_json, updated_at = datetime('now')`,
    [chatId, messagesJson]
  );
}

export function loadSession(db: Database, chatId: number): string | null {
  const row = db.query("SELECT messages_json FROM sessions WHERE chat_id = ?").get(chatId) as { messages_json: string } | null;
  return row?.messages_json || null;
}

export function getMemories(db: Database, chatId: number | null, limit = 20): any[] {
  if (chatId !== null) {
    return db.query(
      `SELECT * FROM memories WHERE (chat_id = ? OR chat_id IS NULL) AND is_archived = 0 ORDER BY updated_at DESC LIMIT ?`
    ).all(chatId, limit);
  }
  return db.query(
    `SELECT * FROM memories WHERE chat_id IS NULL AND is_archived = 0 ORDER BY updated_at DESC LIMIT ?`
  ).all(limit);
}

export function insertMemory(db: Database, chatId: number | null, content: string, category = "general", source = "user"): number {
  db.run(
    `INSERT INTO memories (chat_id, content, category, source) VALUES (?, ?, ?, ?)`,
    [chatId, content, category, source]
  );
  const row = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
  return row.id;
}

export function archiveMemory(db: Database, id: number) {
  db.run("UPDATE memories SET is_archived = 1, updated_at = datetime('now') WHERE id = ?", [id]);
}

export function logUsage(db: Database, chatId: number, model: string, inputTokens: number, outputTokens: number, durationMs: number, context = "agent_loop") {
  db.run(
    `INSERT INTO llm_usage_logs (chat_id, model, input_tokens, output_tokens, duration_ms, context)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [chatId, model, inputTokens, outputTokens, durationMs, context]
  );
}

export function getScheduledTasksDue(db: Database): any[] {
  return db.query(
    `SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run_at <= datetime('now')`
  ).all();
}

function toSqliteDatetime(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "").replace(/Z$/, "");
}

export function createScheduledTask(db: Database, chatId: number, name: string, prompt: string, cronExpr: string | null, nextRunAt: string, timezone = "UTC"): number {
  db.run(
    `INSERT INTO scheduled_tasks (chat_id, name, prompt, cron_expr, next_run_at, timezone) VALUES (?, ?, ?, ?, ?, ?)`,
    [chatId, name, prompt, cronExpr, toSqliteDatetime(nextRunAt), timezone]
  );
  return (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
}

export function updateTaskNextRun(db: Database, taskId: number, nextRunAt: string) {
  db.run("UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?", [toSqliteDatetime(nextRunAt), taskId]);
}

export function updateTaskStatus(db: Database, taskId: number, status: string) {
  db.run("UPDATE scheduled_tasks SET status = ? WHERE id = ?", [status, taskId]);
}

export function updateScheduledTask(db: Database, taskId: number, fields: { name?: string; prompt?: string; cron_expr?: string | null; next_run_at?: string; timezone?: string }) {
  const sets: string[] = [];
  const params: any[] = [];
  if (fields.name !== undefined) { sets.push("name = ?"); params.push(fields.name); }
  if (fields.prompt !== undefined) { sets.push("prompt = ?"); params.push(fields.prompt); }
  if (fields.cron_expr !== undefined) { sets.push("cron_expr = ?"); params.push(fields.cron_expr); }
  if (fields.next_run_at !== undefined) { sets.push("next_run_at = ?"); params.push(toSqliteDatetime(fields.next_run_at)); }
  if (fields.timezone !== undefined) { sets.push("timezone = ?"); params.push(fields.timezone); }
  if (sets.length === 0) return;
  params.push(taskId);
  db.run(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = ?`, params);
}

export function insertTaskDlq(db: Database, taskId: number, chatId: number, errorText: string, prompt: string, retryCount: number) {
  db.run(
    `INSERT INTO scheduled_task_dlq (task_id, chat_id, error_text, original_prompt, retry_count) VALUES (?, ?, ?, ?, ?)`,
    [taskId, chatId, errorText, prompt, retryCount]
  );
}

export function getUsageStats(db: Database, days = 30): any[] {
  return db.query(
    `SELECT model, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, COUNT(*) as calls
     FROM llm_usage_logs WHERE created_at >= datetime('now', '-' || ? || ' days')
     GROUP BY model ORDER BY total_input DESC`
  ).all(days);
}
