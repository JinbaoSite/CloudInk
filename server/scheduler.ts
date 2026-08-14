import crypto from "node:crypto";
import { db } from "./db.js";
import { tokenFor } from "./auth.js";

type ScheduledTask = {
  id: string;
  user_id: string;
  username: string;
  name: string;
  prompt: string;
  cron_expression: string;
  timezone: string;
  model: string | null;
  permission_mode: "auto" | "plan" | "manual" | "acceptEdits";
  overlap_policy: "skip" | "queue";
  next_run_at: string | null;
};

const activeScheduledRuns = new Set<string>();
let wakeScheduler = () => {};
const MAX_SCHEDULED_CONCURRENCY = Math.max(
  1,
  Number(process.env.SCHEDULED_TASK_CONCURRENCY || 2),
);

export function validateTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function nextRunAt(
  cronExpression: string,
  timezone: string,
  after: Date = new Date(),
) {
  if (!validateTimezone(timezone)) throw new Error("时区无效");
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("需要使用 5 段 Cron 表达式");
  const specs = [
    parseCronField(fields[0], 0, 59),
    parseCronField(fields[1], 0, 23),
    parseCronField(fields[2], 1, 31),
    parseCronField(fields[3], 1, 12),
    parseCronField(fields[4], 0, 7, true),
  ];
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const candidate = new Date(after);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let checked = 0; checked < 527_040; checked += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(candidate)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const dayOfWeek = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day),
    ).getUTCDay();
    const dayMatches = specs[2].wildcard || specs[2].values.has(parts.day);
    const weekdayMatches = specs[4].wildcard || specs[4].values.has(dayOfWeek);
    const calendarDayMatches =
      specs[2].wildcard || specs[4].wildcard
        ? dayMatches && weekdayMatches
        : dayMatches || weekdayMatches;
    if (
      specs[0].values.has(parts.minute) &&
      specs[1].values.has(parts.hour) &&
      calendarDayMatches &&
      specs[3].values.has(parts.month)
    )
      return candidate.toISOString();
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error("未来一年内没有可执行时间");
}

function parseCronField(
  source: string,
  min: number,
  max: number,
  normalizeSunday = false,
) {
  const values = new Set<number>();
  const add = (value: number) => {
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`Cron 字段超出范围：${source}`);
    values.add(normalizeSunday && value === 7 ? 0 : value);
  };
  for (const segment of source.split(",")) {
    const [rangePart, stepPart] = segment.split("/");
    const step = stepPart == null ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0)
      throw new Error(`Cron 步长无效：${source}`);
    let start = min;
    let end = max;
    if (rangePart !== "*") {
      const bounds = rangePart.split("-").map(Number);
      start = bounds[0];
      end = bounds.length === 1 ? bounds[0] : bounds[1];
      if (bounds.length > 2 || bounds.some((value) => !Number.isInteger(value)))
        throw new Error(`Cron 字段无效：${source}`);
    }
    if (start > end) throw new Error(`Cron 范围无效：${source}`);
    for (let value = start; value <= end; value += step) add(value);
  }
  if (!values.size) throw new Error(`Cron 字段无效：${source}`);
  return { values, wildcard: source === "*" };
}

function taskById(taskId: string) {
  return db
    .prepare(
      `SELECT t.*,u.username FROM scheduled_tasks t
       JOIN users u ON u.id=t.user_id WHERE t.id=?`,
    )
    .get(taskId) as ScheduledTask | undefined;
}

function createSessionForRun(task: ScheduledTask, scheduledFor: string) {
  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const localTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: task.timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(scheduledFor));
  db.prepare(
    `INSERT INTO sessions(id,user_id,title,claude_session_id,created_at,updated_at,favorite)
     VALUES(?,?,?,?,?,?,0)`,
  ).run(
    sessionId,
    task.user_id,
    `定时 · ${task.name} · ${localTime}`,
    crypto.randomUUID(),
    now,
    now,
  );
  return sessionId;
}

export function enqueueScheduledTask(
  taskId: string,
  scheduledFor = new Date().toISOString(),
) {
  const task = taskById(taskId);
  if (!task) throw new Error("定时任务不存在");
  const liveRun = db
    .prepare(
      "SELECT 1 FROM scheduled_task_runs WHERE task_id=? AND status IN ('queued','running') LIMIT 1",
    )
    .get(task.id);
  if (liveRun && task.overlap_policy === "skip")
    throw new Error("上一次执行尚未完成，本次未加入队列");
  const runId = crypto.randomUUID();
  const sessionId = createSessionForRun(task, scheduledFor);
  try {
    db.prepare(
      `INSERT INTO scheduled_task_runs(id,task_id,session_id,scheduled_for,status,created_at)
       VALUES(?,?,?,?, 'queued', ?)`,
    ).run(runId, task.id, sessionId, scheduledFor, new Date().toISOString());
  } catch (error) {
    db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
    throw error;
  }
  return { id: runId, sessionId };
}

function enqueueDueTasks() {
  const now = new Date();
  const due = db
    .prepare(
      `SELECT t.*,u.username FROM scheduled_tasks t
       JOIN users u ON u.id=t.user_id
       WHERE t.enabled=1 AND t.next_run_at IS NOT NULL AND t.next_run_at<=?
       ORDER BY t.next_run_at LIMIT 20`,
    )
    .all(now.toISOString()) as ScheduledTask[];
  for (const task of due) {
    const scheduledFor = task.next_run_at!;
    let next: string;
    try {
      next = nextRunAt(
        task.cron_expression,
        task.timezone,
        new Date(scheduledFor),
      );
    } catch {
      db.prepare(
        "UPDATE scheduled_tasks SET enabled=0,next_run_at=NULL,updated_at=? WHERE id=?",
      ).run(now.toISOString(), task.id);
      continue;
    }
    const running = db
      .prepare(
        "SELECT 1 FROM scheduled_task_runs WHERE task_id=? AND status='running' LIMIT 1",
      )
      .get(task.id);
    try {
      if (running && task.overlap_policy === "skip") {
        db.prepare(
          `INSERT INTO scheduled_task_runs(id,task_id,scheduled_for,status,error,created_at,finished_at)
           VALUES(?,?,?,'skipped','上一次执行尚未完成',?,?)`,
        ).run(
          crypto.randomUUID(),
          task.id,
          scheduledFor,
          now.toISOString(),
          now.toISOString(),
        );
      } else {
        enqueueScheduledTask(task.id, scheduledFor);
      }
    } catch {
      // The unique task/time constraint makes repeated scheduler ticks harmless.
    }
    db.prepare(
      "UPDATE scheduled_tasks SET next_run_at=?,updated_at=? WHERE id=?",
    ).run(next, now.toISOString(), task.id);
  }
}

function parseStreamError(stream: string) {
  let error = "";
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; error?: string };
      if (event.type === "error") error = event.error || "Claude 执行失败";
      if (event.type === "question")
        error = "任务需要用户确认，无法在无人值守模式下继续";
    } catch {}
  }
  return error;
}

async function executeRun(
  run: { id: string; task_id: string; session_id: string },
  port: number,
) {
  const task = taskById(run.task_id);
  if (!task) return;
  activeScheduledRuns.add(run.id);
  const startedAt = new Date().toISOString();
  db.prepare(
    "UPDATE scheduled_task_runs SET status='running',started_at=? WHERE id=? AND status='queued'",
  ).run(startedAt, run.id);
  db.prepare(
    "UPDATE scheduled_tasks SET last_run_at=?,updated_at=? WHERE id=?",
  ).run(startedAt, startedAt, task.id);
  try {
    const token = await tokenFor(task.user_id);
    const response = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${run.session_id}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `session=${token}`,
        },
        body: JSON.stringify({
          content: task.prompt,
          attachments: [],
          mode: task.permission_mode,
          model: task.model || undefined,
        }),
      },
    );
    const stream = await response.text();
    const streamError = parseStreamError(stream);
    if (!response.ok || streamError)
      throw new Error(streamError || `内部请求失败（${response.status}）`);
    const metricsRow = db
      .prepare(
        `SELECT content FROM messages
         WHERE session_id=? AND role='metrics' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(run.session_id) as { content: string } | undefined;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    if (metricsRow) {
      try {
        const metrics = JSON.parse(metricsRow.content) as {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
        };
        inputTokens =
          (metrics.inputTokens || 0) +
          (metrics.cacheReadTokens || 0) +
          (metrics.cacheCreationTokens || 0);
        outputTokens = metrics.outputTokens || 0;
      } catch {}
    }
    const finishedAt = new Date();
    db.prepare(
      `UPDATE scheduled_task_runs SET status='succeeded',finished_at=?,duration_ms=?,
       input_tokens=?,output_tokens=?,error=NULL WHERE id=?`,
    ).run(
      finishedAt.toISOString(),
      finishedAt.getTime() - new Date(startedAt).getTime(),
      inputTokens,
      outputTokens,
      run.id,
    );
  } catch (error) {
    const finishedAt = new Date();
    db.prepare(
      `UPDATE scheduled_task_runs SET status='failed',finished_at=?,duration_ms=?,error=? WHERE id=?`,
    ).run(
      finishedAt.toISOString(),
      finishedAt.getTime() - new Date(startedAt).getTime(),
      (error as Error).message.slice(0, 2000),
      run.id,
    );
  } finally {
    activeScheduledRuns.delete(run.id);
  }
}

function startQueuedRuns(port: number) {
  const capacity = MAX_SCHEDULED_CONCURRENCY - activeScheduledRuns.size;
  if (capacity <= 0) return;
  const runs = db
    .prepare(
      `SELECT r.id,r.task_id,r.session_id FROM scheduled_task_runs r
       JOIN scheduled_tasks t ON t.id=r.task_id
       WHERE r.status='queued' AND r.session_id IS NOT NULL
       ORDER BY r.created_at LIMIT ?`,
    )
    .all(capacity) as Array<{
    id: string;
    task_id: string;
    session_id: string;
  }>;
  for (const run of runs) {
    if (activeScheduledRuns.has(run.id)) continue;
    void executeRun(run, port);
  }
}

export function startTaskScheduler(port: number) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE scheduled_task_runs SET status='interrupted',finished_at=?,
     error='服务重启导致执行中断' WHERE status='running'`,
  ).run(now);
  const tick = () => {
    enqueueDueTasks();
    startQueuedRuns(port);
  };
  wakeScheduler = tick;
  const timer = setInterval(tick, 15_000);
  timer.unref();
  setTimeout(tick, 500).unref();
  return () => clearInterval(timer);
}

export function wakeTaskScheduler() {
  wakeScheduler();
}
