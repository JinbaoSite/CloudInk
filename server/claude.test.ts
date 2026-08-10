import assert from "node:assert/strict";
import test from "node:test";
import {
  activitiesFromEvent,
  capabilitiesFromEvent,
  completedAssistantTurn,
  messageBoundaryFromEvent,
  questionsFromEvent,
  responseMetricsFromEvent,
  textFromEvent,
  thinkingDeltaFromEvent,
} from "./claude.js";

test("streams thinking deltas without treating subagent text as final output", () => {
  assert.deepEqual(
    thinkingDeltaFromEvent({
      type: "stream_event",
      parent_tool_use_id: "agent-1",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Inspecting files" },
      },
    }),
    { text: "Inspecting files", parentToolUseId: "agent-1" },
  );
  assert.equal(
    textFromEvent({
      type: "stream_event",
      parent_tool_use_id: "agent-1",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Subagent report" },
      },
    }),
    "",
  );
});

test("uses message stop reason to distinguish tool narration from final text", () => {
  assert.deepEqual(
    messageBoundaryFromEvent({
      type: "stream_event",
      event: { type: "message_start" },
    }),
    { type: "start" },
  );
  assert.deepEqual(
    messageBoundaryFromEvent({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      },
    }),
    { type: "stop", reason: "tool_use" },
  );
});

test("renders terminal subagent text as Agent activity", () => {
  assert.deepEqual(
    activitiesFromEvent({
      type: "assistant",
      parent_tool_use_id: "agent-1",
      message: { content: [{ type: "text", text: "## Findings\nDone" }] },
    }),
    [
      {
        kind: "narration",
        label: "Agent",
        detail: "## Findings\nDone",
      },
    ],
  );
});

test("extracts dynamically discovered slash commands and skills", () => {
  assert.deepEqual(
    capabilitiesFromEvent({
      type: "system",
      subtype: "init",
      slash_commands: ["compact", "loop", "dataviz"],
      skills: ["loop", "dataviz"],
    }),
    {
      slashCommands: ["compact", "loop", "dataviz"],
      skills: ["loop", "dataviz"],
    },
  );
});

test("classifies text in a tool-use turn as execution progress", () => {
  const event = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Let me fix that." },
        {
          type: "tool_use",
          id: "edit-1",
          name: "Edit",
          input: { file_path: "a.md" },
        },
      ],
    },
  };
  assert.deepEqual(completedAssistantTurn(event), {
    text: "Let me fix that.",
    hasToolUse: true,
  });
  assert.deepEqual(activitiesFromEvent(event)[0], {
    kind: "thinking",
    label: "Thinking",
    detail: "Let me fix that.",
  });
});

test("keeps text in the terminal assistant turn as the final answer", () => {
  assert.deepEqual(
    completedAssistantTurn({
      type: "assistant",
      message: { content: [{ type: "text", text: "全部交付完成。" }] },
    }),
    { text: "全部交付完成。", hasToolUse: false },
  );
});

test("parses Web UI MCP questions", () => {
  const result = questionsFromEvent({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "mcp__ui__ask_user",
          input: {
            questions: [
              {
                header: "Framework",
                question: "Choose a framework",
                options: [{ label: "React", description: "Use React" }],
              },
            ],
          },
        },
      ],
    },
  });
  assert.deepEqual(result, {
    toolUseId: "tool-1",
    questions: [
      {
        header: "Framework",
        question: "Choose a framework",
        multiSelect: false,
        options: [{ label: "React", description: "Use React" }],
      },
    ],
  });
});

test("parses legacy AskUserQuestion parameter field", () => {
  const result = questionsFromEvent({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "legacy-1",
          name: "AskUserQuestion",
          input: {
            command: "AskUserQuestion",
            'parameter name="questions"': [
              {
                question: "Choose one",
                multiSelect: true,
                options: [{ label: "A" }, { label: "B" }],
              },
            ],
          },
        },
      ],
    },
  });
  assert.deepEqual(result, {
    toolUseId: "legacy-1",
    questions: [
      {
        header: undefined,
        question: "Choose one",
        multiSelect: true,
        options: [
          { label: "A", description: undefined },
          { label: "B", description: undefined },
        ],
      },
    ],
  });
});

test("adds useful context to Read and Bash activity labels", () => {
  const activities = activitiesFromEvent(
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { file_path: "blog.md" },
          },
          {
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: {
              command: "ls -la",
              description: "List working directory contents",
            },
          },
        ],
      },
    },
    "/workspace/jinbao",
  );
  assert.equal(activities[0].label, "Read /workspace/jinbao/blog.md");
  assert.equal(activities[0].toolName, "Read");
  assert.equal(activities[1].label, "Bash List working directory contents");
  assert.equal(activities[1].toolName, "Bash");
});

test("extracts duration and token usage from result events", () => {
  assert.deepEqual(
    responseMetricsFromEvent({
      type: "result",
      duration_ms: 12_345,
      usage: {
        input_tokens: 1_200,
        output_tokens: 345,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      },
    }),
    {
      durationMs: 12_345,
      inputTokens: 1_200,
      outputTokens: 345,
      cacheReadTokens: 900,
      cacheCreationTokens: 100,
    },
  );
});
