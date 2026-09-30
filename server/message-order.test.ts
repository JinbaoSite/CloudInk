import assert from "node:assert/strict";
import test from "node:test";
import { restoreNarrationOrder } from "../src/message-order.js";

const activity = (kind: string, created_at: string, name: string) => ({
  role: "activity",
  content: JSON.stringify({ kind, label: name }),
  created_at,
  name,
});

test("keeps interleaved Codex narration and web searches chronological", () => {
  const messages = [
    activity("narration", "2026-09-30T07:27:54.010Z", "narration 1"),
    activity("tool", "2026-09-30T07:27:54.010Z", "search 1"),
    activity("narration", "2026-09-30T07:28:06.701Z", "narration 2"),
    activity("tool", "2026-09-30T07:28:06.701Z", "search 2"),
    activity("tool", "2026-09-30T07:28:16.694Z", "search 3"),
  ];

  assert.deepEqual(
    restoreNarrationOrder(messages).map((message) => message.name),
    ["narration 1", "search 1", "narration 2", "search 2", "search 3"],
  );
});

test("moves a legacy Claude narration only across tools in its event batch", () => {
  const messages = [
    activity("tool", "2026-09-30T07:27:54.010Z", "older search"),
    activity("tool", "2026-09-30T07:28:06.701Z", "batched tool"),
    activity("narration", "2026-09-30T07:28:06.701Z", "batched narration"),
  ];

  assert.deepEqual(
    restoreNarrationOrder(messages).map((message) => message.name),
    ["older search", "batched narration", "batched tool"],
  );
});
