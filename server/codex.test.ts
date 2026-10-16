import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import {
  activitiesFromCodexEvent,
  codexSandboxConfig,
  codexThreadIdFromEvent,
  createCodexAnswerTracker,
  metricsForCodexTurn,
  metricsFromCodexEvent,
  runCodex,
  textFromCodexEvent,
} from "./codex.js";

test("new and resumed Codex runs select the Git-writable profile and preserve network settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudink-codex-args-"));
  const executable = path.join(root, "fake-codex.mjs");
  fs.writeFileSync(
    executable,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(root, "config.toml"),
    "[sandbox_workspace_write]\nnetwork_access = true\n[other]\nnetwork_access = false\n",
  );
  const priorHome = process.env.CODEX_HOME;
  const priorCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_HOME = root;
  process.env.CODEX_CLI_PATH = executable;
  try {
    for (const threadId of [undefined, "existing-thread"]) {
      const child = runCodex({
        prompt: "test",
        cwd: root,
        writableRoot: root,
        permissionMode: "auto",
        threadId,
        signal: new AbortController().signal,
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      const [code] = await once(child, "close");
      assert.equal(code, 0);
      const args = JSON.parse(output) as string[];
      assert.ok(args.includes('default_permissions="cloudink_workspace"'));
      assert.ok(
        args.some(
          (arg) =>
            arg.startsWith("permissions.cloudink_workspace=") &&
            arg.includes("network={enabled=true}"),
        ),
      );
      assert.ok(!args.includes("--sandbox"));
      assert.ok(!args.some((arg) => arg.startsWith("sandbox_mode=")));
      assert.equal(args.includes("resume"), Boolean(threadId));
    }
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorHome;
    if (priorCli === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = priorCli;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps resumed write-capable Codex turns writable in the user workspace", () => {
  assert.deepEqual(codexSandboxConfig("auto", "/srv/workspaces/alice"), {
    mode: "workspace-write",
    args: [
      "-c",
      'default_permissions="cloudink_workspace"',
      "-c",
      'permissions.cloudink_workspace={extends=":workspace",filesystem={":workspace_roots"={".git"="write"}},network={enabled=false},workspace_roots={"/srv/workspaces/alice"=true}}',
    ],
  });
  assert.deepEqual(codexSandboxConfig("plan", "/srv/workspaces/alice"), {
    mode: "read-only",
    args: ["-c", 'sandbox_mode="read-only"'],
  });
});

test("Git write access stays scoped to each user and read-only modes remain read-only", () => {
  for (const permissionMode of ["auto", "acceptEdits"] as const) {
    const config = codexSandboxConfig(
      permissionMode,
      "/srv/workspaces/alice",
      true,
    );
    assert.ok(config.args.includes('default_permissions="cloudink_workspace"'));
    const profile = config.args.at(-1)!;
    assert.ok(profile.includes('".git"="write"'));
    assert.ok(profile.includes("network={enabled=true}"));
    assert.ok(
      profile.includes('workspace_roots={"/srv/workspaces/alice"=true}'),
    );
    assert.ok(!profile.includes("/srv/workspaces/bob"));
    assert.ok(!config.args.some((arg) => arg.includes("danger-full-access")));
  }
  for (const permissionMode of ["plan", "manual"] as const) {
    assert.deepEqual(
      codexSandboxConfig(permissionMode, "/srv/workspaces/alice", true),
      {
        mode: "read-only",
        args: ["-c", 'sandbox_mode="read-only"'],
      },
    );
  }
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

test("keeps six progress messages separate across unreported wait and polling tools", () => {
  const tracker = createCodexAnswerTracker();
  const narration: string[] = [];
  const progress = [
    "首批开始",
    "仍在运行",
    "已完成 1/5",
    "已完成 2/5",
    "已完成 4/5",
    "已完成 5/5",
  ];
  const process = (event: Parameters<typeof textFromCodexEvent>[0]) => {
    const pending = tracker.beforeEvent(event);
    if (pending) narration.push(pending.narration);
    const text = textFromCodexEvent(event);
    if (text) tracker.append(text);
    if (event.type === "turn.completed") tracker.completeTurn();
  };
  for (const [index, text] of progress.entries()) {
    process({
      type: "item.completed",
      item: { id: `progress-${index}`, type: "agent_message", text },
    });
    process({
      type: "item.started",
      item: { id: `wait-${index}`, type: "unknown_wait" },
    });
    process({
      type: "item.completed",
      item: { id: `poll-${index}`, type: "unknown_poll" },
    });
  }
  process({
    type: "item.started",
    item: { id: "verify", type: "command_execution", command: "verify" },
  });
  process({
    type: "item.completed",
    item: { id: "final", type: "agent_message", text: "全部确认完成" },
  });
  process({ type: "turn.completed" });
  assert.deepEqual(narration, progress);
  assert.equal(tracker.answer(), "全部确认完成");
});

test("a following final message separates progress without any tool activity", () => {
  const tracker = createCodexAnswerTracker();
  tracker.append("检查中");
  assert.deepEqual(
    tracker.beforeEvent({
      type: "item.completed",
      item: { id: "final", type: "agent_message", text: "完成" },
    }),
    { answer: "", narration: "检查中" },
  );
  tracker.append("完成");
  assert.equal(tracker.beforeEvent({ type: "turn.completed" }), null);
  assert.equal(tracker.completeTurn(), "完成");
});

test("preserves structured Codex file changes for Edit IN", () => {
  const changes = [
    { path: "/workspace/first.ts", kind: "update", diff: "-old\n+new" },
    { path: "/workspace/second.ts", kind: "add" },
  ];
  const [activity] = activitiesFromCodexEvent({
    type: "item.completed",
    item: { id: "edit-1", type: "file_change", changes },
  });
  assert.equal(activity.toolName, "Edit");
  assert.deepEqual(JSON.parse(activity.detail!), { changes });
  assert.equal(activity.detail!.includes("[object Object]"), false);
  const [withPath] = activitiesFromCodexEvent({
    type: "item.completed",
    item: { id: "edit-2", type: "file_change", path: "first.ts", changes },
  });
  assert.deepEqual(JSON.parse(withPath.detail!), { path: "first.ts", changes });
});

test("keeps path-only and empty Codex file changes readable", () => {
  for (const [fields, expected] of [
    [{ path: "/workspace/first.ts" }, "/workspace/first.ts"],
    [{}, "文件已修改"],
  ] as const) {
    const [activity] = activitiesFromCodexEvent({
      type: "item.completed",
      item: { id: "edit", type: "file_change", ...fields },
    });
    assert.equal(activity.detail, expected);
  }
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
