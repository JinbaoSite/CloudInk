import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { recordUserInterruption } from "./interruption.js";

test("user interruptions are persistent, idempotent per run, and follow partial replies", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT)",
    );
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
      "answer-1",
      "session-1",
      "assistant",
      "partial answer",
      "2026-10-16T09:00:00Z",
    );
    const input = {
      sessionId: "session-1",
      runId: "run-1",
      interruptedAt: "2026-10-16T09:00:01Z",
      assistantMessageId: "answer-1",
    };
    const first = recordUserInterruption(db, input);
    recordUserInterruption(db, input);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) n FROM messages WHERE role='interruption'")
          .get() as { n: number }
      ).n,
      1,
    );
    const rows = db
      .prepare("SELECT * FROM messages ORDER BY rowid")
      .all() as Array<{ role: string; content: string }>;
    assert.deepEqual(
      rows.map((row) => row.role),
      ["assistant", "interruption"],
    );
    assert.equal(JSON.parse(rows[1].content).assistantMessageId, "answer-1");
    assert.equal(first.created_at, input.interruptedAt);
    recordUserInterruption(db, { ...input, runId: "run-2" });
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) n FROM messages WHERE role='interruption'")
          .get() as { n: number }
      ).n,
      2,
    );
  } finally {
    db.close();
  }
});
