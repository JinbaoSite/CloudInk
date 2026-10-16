import type Database from "better-sqlite3";

export function recordUserInterruption(
  db: Database.Database,
  input: {
    sessionId: string;
    runId: string;
    interruptedAt: string;
    assistantMessageId?: string;
  },
) {
  const message = {
    id: `interruption-${input.runId}`,
    role: "interruption" as const,
    content: JSON.stringify({
      reason: "user",
      runId: input.runId,
      assistantMessageId: input.assistantMessageId,
    }),
    created_at: input.interruptedAt,
  };
  db.prepare(
    "INSERT OR IGNORE INTO messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)",
  ).run(
    message.id,
    input.sessionId,
    message.role,
    message.content,
    message.created_at,
  );
  return message;
}
