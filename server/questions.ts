import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

const questionSchema = z.object({
  question: z.string().trim().min(1).max(10000),
  header: z.string().max(100).optional(),
  multiSelect: z.boolean().optional(),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(2000),
        description: z.string().max(10000).optional(),
      }),
    )
    .max(30)
    .optional(),
});
export const pendingQuestionSchema = z.object({
  toolUseId: z.string().min(1).max(200),
  questions: z.array(questionSchema).min(1).max(4),
});
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;

export function normalizeQuestions(
  input: unknown,
  toolUseId: string,
): PendingQuestion | null {
  try {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    const questions = data?.questions;
    if (!Array.isArray(questions)) return null;
    const parsed = pendingQuestionSchema.safeParse({
      toolUseId,
      questions: questions.map((q) => ({
        question: q.question ?? q.title,
        header: q.header,
        multiSelect: q.multiSelect,
        options: Array.isArray(q.options)
          ? q.options.map((option: unknown) =>
              typeof option === "string" ? { label: option } : option,
            )
          : undefined,
      })),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function questionsFromCodexEvent(event: Record<string, unknown>) {
  const item = (
    event.type === "response_item" ? event.payload : event.item || event
  ) as Record<string, unknown> | undefined;
  if (!item || !["function_call", "mcp_tool_call"].includes(String(item.type)))
    return null;
  const name = String(item.name || item.tool || "");
  if (!/(?:^|__|\.)(?:request_user_input(?:_async)?|ask_user)$/.test(name))
    return null;
  return normalizeQuestions(
    item.arguments ?? item.input,
    String(item.call_id || item.id || ""),
  );
}

// Native user-input calls are present in the rollout but can be omitted from
// `codex exec --json`. Read only the current thread, and only this run's events.
export function watchCodexQuestions(opts: {
  startedAt: number;
  onQuestion: (question: PendingQuestion) => void;
  home?: string;
  onPatch?: (event: Record<string, unknown>) => void;
}) {
  const root = path.join(
    opts.home || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    "sessions",
  );
  let threadId = "",
    file = "",
    offset = 0,
    buffer = "",
    closed = false;
  let decoder = new StringDecoder("utf8");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const seen = new Set<string>();
  const scan = async () => {
    if (!threadId) return;
    if (!file) {
      const entries = await fs
        .readdir(root, { recursive: true })
        .catch(() => [] as string[]);
      const name = entries.find((entry) =>
        path.basename(entry).endsWith(`-${threadId}.jsonl`),
      );
      if (!name) return;
      file = path.join(root, name);
    }
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (stat.size < offset) {
        offset = 0;
        buffer = "";
        decoder = new StringDecoder("utf8");
      }
      const chunk = Buffer.alloc(64 * 1024);
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, stat.size - offset),
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
        buffer += decoder.write(chunk.subarray(0, bytesRead));
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (!(Date.parse(event.timestamp) >= opts.startedAt)) continue;
            if (
              event.type === "event_msg" &&
              event.payload?.type === "patch_apply_end"
            ) {
              const key = `patch:${event.payload.call_id}`;
              if (event.payload.call_id && !seen.has(key)) {
                seen.add(key);
                opts.onPatch?.(event.payload);
              }
            }
            const question = questionsFromCodexEvent(event);
            if (question && !seen.has(question.toolUseId)) {
              seen.add(question.toolUseId);
              opts.onQuestion(question);
            }
          } catch {
            /* Incomplete or unrelated rollout records are ignored. */
          }
        }
      }
    } finally {
      await handle.close();
    }
  };
  const tick = () => {
    inFlight = scan().catch(() => {});
    void inFlight.finally(() => {
      if (!closed) timer = setTimeout(tick, 150);
    });
  };
  tick();
  return {
    setThreadId(value: string) {
      if (/^[a-f0-9-]{36}$/i.test(value) && value !== threadId) {
        threadId = value;
        file = "";
        offset = 0;
        buffer = "";
        decoder = new StringDecoder("utf8");
      }
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      await inFlight;
      await scan().catch(() => {});
    },
  };
}
