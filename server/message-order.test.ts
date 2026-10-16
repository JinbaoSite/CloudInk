import assert from "node:assert/strict";
import test from "node:test";
import {
  findActivityInCurrentTurn,
  preserveMessageOrder,
} from "../src/message-order.js";

const activity = (kind: string, created_at: string, name: string) => ({
  role: "activity",
  content: JSON.stringify({ kind, label: name }),
  created_at,
  name,
});

test("does not match a reused tool id from an earlier turn", () => {
  const messages = [
    {
      role: "activity",
      content: JSON.stringify({ kind: "tool", toolUseId: "item-1" }),
    },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "next request" },
  ];
  assert.equal(findActivityInCurrentTurn(messages, "item-1"), -1);
  messages.push({
    role: "activity",
    content: JSON.stringify({ kind: "tool", toolUseId: "item-1" }),
  });
  assert.equal(findActivityInCurrentTurn(messages, "item-1"), 3);
});

test("keeps interleaved narration and tools in their stored order", () => {
  const messages = [
    activity("narration", "2026-09-30T07:27:54.010Z", "narration 1"),
    activity("tool", "2026-09-30T07:27:54.010Z", "search 1"),
    activity("narration", "2026-09-30T07:28:06.701Z", "narration 2"),
    activity("tool", "2026-09-30T07:28:06.701Z", "search 2"),
    activity("tool", "2026-09-30T07:28:16.694Z", "search 3"),
  ];

  assert.deepEqual(
    preserveMessageOrder(messages).map((message) => message.name),
    ["narration 1", "search 1", "narration 2", "search 2", "search 3"],
  );
});

test("does not reorder messages that share a timestamp", () => {
  const messages = [
    activity("tool", "2026-09-30T07:27:54.010Z", "older search"),
    activity("tool", "2026-09-30T07:28:06.701Z", "batched tool"),
    activity("narration", "2026-09-30T07:28:06.701Z", "batched narration"),
  ];

  assert.deepEqual(
    preserveMessageOrder(messages).map((message) => message.name),
    ["older search", "batched tool", "batched narration"],
  );
});
