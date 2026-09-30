import assert from "node:assert/strict";
import test from "node:test";
import {
  activitiesFromCodexEvent,
  codexSandboxConfig,
  codexThreadIdFromEvent,
  createCodexAnswerTracker,
  metricsForCodexTurn,
  metricsFromCodexEvent,
  textFromCodexEvent,
} from "./codex.js";

test("keeps resumed write-capable Codex turns writable in the user workspace", () => {
  assert.deepEqual(codexSandboxConfig("auto", "/srv/workspaces/alice"), {
    mode: "workspace-write",
    args: [
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'sandbox_workspace_write.writable_roots=["/srv/workspaces/alice"]',
    ],
  });
  assert.deepEqual(codexSandboxConfig("plan", "/srv/workspaces/alice"), {
    mode: "read-only",
    args: ["-c", 'sandbox_mode="read-only"'],
  });
});

test("extracts Codex thread id and final agent message", () => {
  assert.equal(
    codexThreadIdFromEvent({ type: "thread.started", thread_id: "thread-1" }),
    "thread-1",
  );
  assert.equal(
    textFromCodexEvent({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: "完成" },
    }),
    "完成",
  );
});

test("moves an agent message before a following tool into narration", () => {
  const tracker = createCodexAnswerTracker();
  assert.equal(tracker.append("我先确认官方实现。"), "我先确认官方实现。");
  assert.deepEqual(tracker.beforeTool(), {
    answer: "",
    narration: "我先确认官方实现。",
  });
  assert.equal(tracker.answer(), "");

  tracker.append("这是最终方案。");
  tracker.completeTurn();
  assert.equal(tracker.answer(), "这是最终方案。");
  assert.equal(tracker.beforeTool(), null);
});

test("maps Codex command execution to a mergeable activity", () => {
  const started = activitiesFromCodexEvent({
    type: "item.started",
    item: {
      id: "item-1",
      type: "command_execution",
      command: "npm test",
    },
  });
  const completed = activitiesFromCodexEvent({
    type: "item.completed",
    item: {
      id: "item-1",
      type: "command_execution",
      command: "npm test",
      aggregated_output: "ok\n",
      exit_code: 0,
    },
  });
  assert.equal(started[0]?.kind, "tool");
  assert.equal(started[0]?.toolUseId, "item-1");
  assert.equal(completed[0]?.kind, "tool_result");
  assert.equal(completed[0]?.detail, "ok\n");
  assert.equal(completed[0]?.isError, false);
});

test("normalizes Codex token usage", () => {
  assert.deepEqual(
    metricsFromCodexEvent(
      {
        type: "turn.completed",
        usage: {
          input_tokens: 120,
          cached_input_tokens: 80,
          output_tokens: 24,
        },
      },
      1500,
    ),
    {
      durationMs: 1500,
      inputTokens: 120,
      outputTokens: 24,
      cacheReadTokens: 80,
      cacheCreationTokens: 0,
    },
  );
});

test("converts cumulative Codex usage to usage for the current turn", () => {
  assert.deepEqual(
    metricsForCodexTurn(
      {
        durationMs: 2_000,
        inputTokens: 180,
        outputTokens: 35,
        cacheReadTokens: 140,
        cacheCreationTokens: 8,
      },
      {
        durationMs: 1_000,
        inputTokens: 120,
        outputTokens: 24,
        cacheReadTokens: 80,
        cacheCreationTokens: 3,
      },
    ),
    {
      durationMs: 2_000,
      inputTokens: 60,
      outputTokens: 11,
      cacheReadTokens: 60,
      cacheCreationTokens: 5,
      usageScope: "turn",
      cumulativeInputTokens: 180,
      cumulativeOutputTokens: 35,
      cumulativeCacheReadTokens: 140,
      cumulativeCacheCreationTokens: 8,
    },
  );
});
