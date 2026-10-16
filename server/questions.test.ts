import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeQuestions,
  questionsFromCodexEvent,
  watchCodexQuestions,
  type PendingQuestion,
} from "./questions.js";

test("native async questions keep their titles and string options", () => {
  const question = questionsFromCodexEvent({
    type: "response_item",
    payload: {
      type: "function_call",
      name: "request_user_input_async",
      call_id: "ask-1",
      arguments: JSON.stringify({
        questions: [
          {
            title: "只修改推荐算法，还是所有分类？",
            options: [
              "只修改 recsys/index.md",
              "修改所有分类，非单篇论文文章保留原日期",
            ],
          },
        ],
      }),
    },
  });
  assert.equal(question?.toolUseId, "ask-1");
  assert.equal(
    question?.questions[0].question,
    "只修改推荐算法，还是所有分类？",
  );
  assert.deepEqual(
    question?.questions[0].options?.map((option) => option.label),
    ["只修改 recsys/index.md", "修改所有分类，非单篇论文文章保留原日期"],
  );
});

test("sync and MCP questions preserve descriptions and multiple selections", () => {
  const input = {
    questions: [
      {
        question: "范围？",
        header: "范围",
        multiSelect: true,
        options: [{ label: "A", description: "保留日期" }],
      },
    ],
  };
  assert.deepEqual(
    questionsFromCodexEvent({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        id: "ask-2",
        tool: "ask_user",
        arguments: input,
      },
    }),
    { toolUseId: "ask-2", ...input },
  );
  assert.equal(
    questionsFromCodexEvent({
      type: "function_call",
      call_id: "ask-3",
      name: "functions.request_user_input",
      arguments: JSON.stringify(input),
    })?.questions[0].header,
    "范围",
  );
  assert.equal(
    normalizeQuestions({ questions: [{ title: "说明？" }] }, "freeform")
      ?.questions[0].options,
    undefined,
  );
});

test("malformed or unrelated calls never become questions", () => {
  assert.equal(normalizeQuestions({ questions: [] }, "empty"), null);
  assert.equal(
    normalizeQuestions({ questions: [{ title: "" }] }, "empty-title"),
    null,
  );
  assert.equal(
    questionsFromCodexEvent({
      type: "function_call",
      call_id: "bad",
      name: "request_user_input_async",
      arguments: "{",
    }),
    null,
  );
  assert.equal(
    questionsFromCodexEvent({
      type: "function_call",
      call_id: "other",
      name: "Bash",
      arguments: '{"questions":[{"title":"?"}]}',
    }),
    null,
  );
});

test("rollout bridge ignores historical calls, handles split UTF8 and deduplicates", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cloudink-ask-"));
  const startedAt = Date.now(),
    thread = "01234567-1234-1234-1234-012345678901";
  const dir = path.join(home, "sessions", "2026", "10", "16");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-date-${thread}.jsonl`);
  const record = (id: string, time: number) =>
    JSON.stringify({
      timestamp: new Date(time).toISOString(),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input_async",
        call_id: id,
        arguments: JSON.stringify({
          questions: [{ title: "选择范围", options: ["推荐", "全部"] }],
        }),
      },
    }) + "\n";
  fs.writeFileSync(file, record("historical", startedAt - 1000));
  const received: PendingQuestion[] = [];
  const watcher = watchCodexQuestions({
    home,
    startedAt,
    onQuestion: (question) => received.push(question),
  });
  try {
    watcher.setThreadId(thread);
    const line = Buffer.from(record("current", startedAt));
    const split = line.indexOf(Buffer.from("选")) + 1;
    fs.appendFileSync(file, line.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received.length, 0);
    fs.appendFileSync(file, line.subarray(split));
    fs.appendFileSync(file, line);
    await watcher.close();
    assert.deepEqual(
      received.map((q) => q.toolUseId),
      ["current"],
    );
    assert.equal(received[0].questions[0].question, "选择范围");
  } finally {
    await watcher.close();
    fs.rmSync(home, { recursive: true });
  }
});
