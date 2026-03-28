import type { Database } from "bun:sqlite";
import type { AngelConfig } from "./config";
import type { ToolRegistry } from "./tools/registry";
import type { ChannelRegistry } from "./channels/types";
import { getScheduledTasksDue, updateTaskNextRun, updateTaskStatus, insertTaskDlq, logUsage } from "./db";
import { processMessage } from "./agent";
import { splitMessage } from "./channels/types";
import { CronExpressionParser } from "cron-parser";

const TICK_INTERVAL = 60_000;

export function startScheduler(
  db: Database,
  config: AngelConfig,
  registry: ToolRegistry,
  channels: ChannelRegistry
) {
  console.log("[angel] Scheduler started (60s tick)");

  setInterval(async () => {
    try {
      await tick(db, config, registry, channels);
    } catch (err: any) {
      console.error(`[angel] Scheduler tick error: ${err.message}`);
    }
  }, TICK_INTERVAL);
}

async function tick(
  db: Database,
  config: AngelConfig,
  registry: ToolRegistry,
  channels: ChannelRegistry
) {
  const dueTasks = getScheduledTasksDue(db);
  if (dueTasks.length === 0) return;

  for (const task of dueTasks) {
    try {
      const chatRow = db.query("SELECT * FROM chats WHERE id = ?").get(task.chat_id) as any;
      if (!chatRow) {
        updateTaskStatus(db, task.id, "failed");
        continue;
      }

      const start = Date.now();
      const result = await processMessage(task.prompt, {
        chatId: task.chat_id,
        channel: chatRow.channel,
        db,
        config,
        registry,
      });
      const durationMs = Date.now() - start;

      db.run(
        `INSERT INTO task_run_logs (task_id, chat_id, started_at, finished_at, duration_ms, success, result_summary)
         VALUES (?, ?, datetime('now', '-' || ? || ' seconds'), datetime('now'), ?, 1, ?)`,
        [task.id, task.chat_id, Math.floor(durationMs / 1000), durationMs, result.slice(0, 500)]
      );

      const adapter = channels.get(chatRow.channel);
      if (adapter && result) {
        const chunks = splitMessage(result, adapter.maxMessageLength || 4000);
        for (const chunk of chunks) {
          await adapter.sendText(chatRow.external_chat_id, chunk);
          if (chunks.length > 1) await sleep(500);
        }
      }

      if (task.cron_expr) {
        const next = getNextCronRun(task.cron_expr, task.timezone);
        updateTaskNextRun(db, task.id, next);
      } else {
        updateTaskStatus(db, task.id, "completed");
      }
    } catch (err: any) {
      console.error(`[angel] Task ${task.id} failed: ${err.message}`);
      const retryCount = (task.retry_count || 0) + 1;

      if (retryCount >= (task.max_retries || 3)) {
        updateTaskStatus(db, task.id, "failed");
        insertTaskDlq(db, task.id, task.chat_id, err.message, task.prompt, retryCount);
      } else {
        db.run("UPDATE scheduled_tasks SET retry_count = ? WHERE id = ?", [retryCount, task.id]);
        const backoffMinutes = Math.pow(2, retryCount);
        const nextRetry = new Date(Date.now() + backoffMinutes * 60_000).toISOString();
        updateTaskNextRun(db, task.id, nextRetry);
      }
    }
  }
}

export function getNextCronRun(cronExpr: string, timezone = "UTC"): string {
  const expr = CronExpressionParser.parse(cronExpr, { tz: timezone });
  const next = expr.next();
  return next.toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
