import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiMcpPath = fileURLToPath(new URL("./ui-mcp.mjs", import.meta.url));
const uiMcpConfig = JSON.stringify({
  mcpServers: {
    ui: { command: process.execPath, args: [uiMcpPath] },
  },
});
const webUiSystemPrompt = `You are running inside a non-interactive Claude Code Web UI.
When you need clarification or a decision from the user, call mcp__ui__ask_user with structured questions and then stop the turn. Never call AskUserQuestion or SendUserMessage because they are unavailable in print mode.
Never call ExitPlanMode. In plan mode, present the completed plan in your response and stop normally; the Web UI manages mode transitions.`;

export function detectClaudeModel(cwd: string, timeoutMs = 30_000) {
  if (process.env.CLAUDE_MODEL)
    return Promise.resolve(process.env.CLAUDE_MODEL);

  return new Promise<string>((resolve) => {
    const child = spawn(
      process.env.CLAUDE_CLI_PATH || "claude",
      [
        "-p",
        "Reply with OK.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--tools",
        "",
      ],
      { cwd, env: process.env, stdio: ["ignore", "pipe", "ignore"] },
    );
    let settled = false;
    let buffer = "";
    const finish = (model = "CLI default") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(model);
    };
    const inspectLine = (line: string) => {
      if (!line.trim() || settled) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "system" && event.model) {
          finish(String(event.model));
          child.kill("SIGTERM");
        }
      } catch {}
    };
    const timer = setTimeout(() => {
      finish();
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) inspectLine(line);
    });
    child.stdout.on("end", () => inspectLine(buffer));
    child.on("error", () => finish());
    child.on("close", () => finish());
  });
}

export type ClaudeModelOption = {
  value: string;
  description: string;
};

export function configuredClaudeModels(currentModel: string) {
  const configuredEnvironment: Record<string, unknown> = {};
  for (const settingsPath of [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(process.cwd(), ".claude", "settings.json"),
  ]) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
        env?: Record<string, unknown>;
      };
      Object.assign(configuredEnvironment, settings.env);
    } catch {}
  }
  const candidates: Array<[unknown, string]> = [
    [currentModel, "当前默认模型"],
    [process.env.CLAUDE_MODEL, "服务端指定模型"],
    [configuredEnvironment.ANTHROPIC_MODEL, "默认模型"],
    [configuredEnvironment.ANTHROPIC_DEFAULT_OPUS_MODEL, "高性能模型"],
    [configuredEnvironment.ANTHROPIC_DEFAULT_SONNET_MODEL, "均衡模型"],
    [configuredEnvironment.ANTHROPIC_DEFAULT_HAIKU_MODEL, "高速模型"],
  ];
  const seen = new Set<string>();
  return candidates.reduce<ClaudeModelOption[]>(
    (models, [value, description]) => {
      if (typeof value !== "string" || !value.trim() || seen.has(value.trim()))
        return models;
      seen.add(value.trim());
      models.push({ value: value.trim(), description });
      return models;
    },
    [],
  );
}

export type ClaudeEvent = { type: string; [key: string]: unknown };
export type ClaudeCapabilities = {
  slashCommands: string[];
  skills: string[];
};
export type ClaudeActivity = {
  kind: "status" | "thinking" | "narration" | "tool" | "tool_result";
  label: string;
  detail?: string;
  toolUseId?: string;
  isError?: boolean;
  toolName?: string;
  output?: string;
};

export function capabilitiesFromEvent(
  event: ClaudeEvent,
): ClaudeCapabilities | null {
  if (event.type !== "system" || event.subtype !== "init") return null;
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    slashCommands: strings(event.slash_commands),
    skills: strings(event.skills),
  };
}

export function detectClaudeCapabilities(cwd: string, timeoutMs = 10_000) {
  return new Promise<ClaudeCapabilities>((resolve) => {
    const child = spawn(
      process.env.CLAUDE_CLI_PATH || "claude",
      [
        "-p",
        "Reply with OK.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--tools",
        "",
      ],
      { cwd, env: process.env, stdio: ["ignore", "pipe", "ignore"] },
    );
    let buffer = "";
    let settled = false;
    const finish = (
      capabilities: ClaudeCapabilities = { slashCommands: [], skills: [] },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(capabilities);
      child.kill("SIGTERM");
    };
    const inspectLine = (line: string) => {
      if (!line.trim() || settled) return;
      try {
        const capabilities = capabilitiesFromEvent(JSON.parse(line));
        if (capabilities) finish(capabilities);
      } catch {}
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) inspectLine(line);
    });
    child.stdout.on("end", () => inspectLine(buffer));
    child.on("error", () => finish());
    child.on("close", () => finish());
  });
}

function shortValue(value: unknown, maxLength = 140) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function toolActivityLabel(
  name: string,
  input: Record<string, unknown>,
  cwd?: string,
) {
  const filePath = input.file_path || input.path;
  const resolvedPath =
    cwd &&
    typeof filePath === "string" &&
    filePath &&
    !path.isAbsolute(filePath)
      ? path.resolve(cwd, filePath)
      : filePath;
  const suffix = (value: unknown) => {
    const text = shortValue(value);
    return text ? ` ${text}` : "";
  };
  switch (name) {
    case "Read":
      return `Read${suffix(resolvedPath)}`;
    case "Write":
      return `Write${suffix(resolvedPath)}`;
    case "Edit":
    case "MultiEdit":
      return `${name}${suffix(resolvedPath)}`;
    case "Bash":
      return `Bash${suffix(input.description || input.command)}`;
    case "Agent":
    case "Task":
      return `Agent${suffix(input.description || input.subagent_type || input.prompt)}`;
    case "Glob":
      return `Glob${suffix(input.pattern)}`;
    case "Grep":
      return `Grep${suffix(input.pattern)}`;
    case "WebFetch":
      return `WebFetch${suffix(input.url)}`;
    case "WebSearch":
      return `WebSearch${suffix(input.query)}`;
    case "Skill":
      return `Skill${suffix(input.skill || input.name)}`;
    case "mcp__ui__ask_user":
      return "Ask user";
    default:
      return name;
  }
}
export type ClaudeQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
};
export type ClaudeResponseMetrics = {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};
export function runClaude(opts: {
  prompt: string;
  cwd: string;
  sessionId: string;
  resume: boolean;
  permissionMode: "auto" | "plan" | "manual" | "acceptEdits";
  model?: string;
  signal: AbortSignal;
  tools?: string;
}) {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--mcp-config",
    uiMcpConfig,
    "--append-system-prompt",
    webUiSystemPrompt,
    "--permission-mode",
    opts.permissionMode,
    "--allowed-tools",
    [process.env.CLAUDE_ALLOWED_TOOLS || "Bash", "mcp__ui__ask_user"].join(","),
    "--tools",
    opts.tools ?? "default",
  ];
  const model = opts.model || process.env.CLAUDE_MODEL;
  if (model) args.push("--model", model);
  if (opts.resume) args.push("--resume", opts.sessionId);
  else args.push("--session-id", opts.sessionId);
  const child = spawn(process.env.CLAUDE_CLI_PATH || "claude", args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  opts.signal.addEventListener("abort", () => child.kill("SIGTERM"), {
    once: true,
  });
  return child;
}
export function textFromEvent(event: ClaudeEvent) {
  if (event.type === "stream_event" && !event.parent_tool_use_id) {
    const e = event.event as
      { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta")
      return e.delta.text || "";
  }
  return "";
}

export function thinkingDeltaFromEvent(event: ClaudeEvent) {
  if (event.type !== "stream_event") return null;
  const e = event.event as
    { type?: string; delta?: { type?: string; thinking?: string } } | undefined;
  if (e?.type !== "content_block_delta" || e.delta?.type !== "thinking_delta")
    return null;
  return {
    text: e.delta.thinking || "",
    parentToolUseId: String(event.parent_tool_use_id || "root"),
  };
}

export function messageBoundaryFromEvent(event: ClaudeEvent) {
  if (event.type !== "stream_event" || event.parent_tool_use_id) return null;
  const e = event.event as
    { type?: string; delta?: { stop_reason?: string } } | undefined;
  if (e?.type === "message_start") return { type: "start" as const };
  if (e?.type === "message_delta" && e.delta?.stop_reason)
    return {
      type: "stop" as const,
      reason: String(e.delta.stop_reason),
    };
  return null;
}

export function completedAssistantTurn(event: ClaudeEvent) {
  if (event.type !== "assistant" || event.parent_tool_use_id) return null;
  const message = event.message as
    { content?: Array<Record<string, unknown>> } | undefined;
  const content = message?.content || [];
  return {
    text: content
      .filter(
        (block) => block.type === "text" && typeof block.text === "string",
      )
      .map((block) => String(block.text))
      .join(""),
    hasToolUse: content.some((block) => block.type === "tool_use"),
  };
}

export function responseMetricsFromEvent(
  event: ClaudeEvent,
): ClaudeResponseMetrics | null {
  if (event.type !== "result") return null;
  const usage =
    event.usage && typeof event.usage === "object"
      ? (event.usage as Record<string, unknown>)
      : {};
  const numberValue = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  return {
    durationMs: numberValue(event.duration_ms || event.duration_api_ms),
    inputTokens: numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.output_tokens),
    cacheReadTokens: numberValue(usage.cache_read_input_tokens),
    cacheCreationTokens: numberValue(usage.cache_creation_input_tokens),
  };
}

export function questionsFromEvent(event: ClaudeEvent) {
  if (event.type !== "assistant") return null;
  const message = event.message as
    { content?: Array<Record<string, unknown>> } | undefined;
  const block = (message?.content || []).find(
    (item) =>
      item.type === "tool_use" &&
      ["AskUserQuestion", "mcp__ui__ask_user", "ask_user"].includes(
        String(item.name || ""),
      ),
  );
  if (!block) return null;
  const input = block.input as Record<string, unknown> | undefined;
  const rawQuestions = Array.isArray(input?.questions)
    ? input.questions
    : Object.entries(input || {}).find(
        ([key, value]) =>
          key.toLowerCase().includes("questions") && Array.isArray(value),
      )?.[1];
  if (!Array.isArray(rawQuestions)) return null;
  const questions = rawQuestions.flatMap<ClaudeQuestion>((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (typeof item.question !== "string" || !item.question.trim()) return [];
    const options = Array.isArray(item.options)
      ? item.options.flatMap<{ label: string; description?: string }>(
          (option) => {
            if (!option || typeof option !== "object") return [];
            const parsed = option as Record<string, unknown>;
            if (typeof parsed.label !== "string") return [];
            return [
              {
                label: parsed.label,
                description:
                  typeof parsed.description === "string"
                    ? parsed.description
                    : undefined,
              },
            ];
          },
        )
      : undefined;
    return [
      {
        question: item.question,
        header: typeof item.header === "string" ? item.header : undefined,
        multiSelect: Boolean(item.multiSelect),
        options,
      },
    ];
  });
  return questions.length
    ? { toolUseId: String(block.id || ""), questions }
    : null;
}

export function activitiesFromEvent(
  event: ClaudeEvent,
  cwd?: string,
): ClaudeActivity[] {
  if (event.type === "assistant") {
    const message = event.message as
      { content?: Array<Record<string, unknown>> } | undefined;
    const content = message?.content || [];
    const hasToolUse = content.some((block) => block.type === "tool_use");
    const isSubagent = Boolean(event.parent_tool_use_id);
    return content.flatMap<ClaudeActivity>((block) => {
      if (block.type === "thinking" && block.thinking) {
        return [
          {
            kind: "thinking" as const,
            label: "Thinking",
            detail: String(block.thinking),
          },
        ];
      }
      // Claude frequently narrates what it is about to do in a regular text
      // block. When the same assistant turn invokes a tool, that narration is
      // execution progress rather than the final answer.
      if (block.type === "text" && hasToolUse && block.text) {
        return [
          {
            kind: "thinking" as const,
            label: "Thinking",
            detail: String(block.text),
          },
        ];
      }
      if (block.type === "text" && isSubagent && block.text) {
        return [
          {
            kind: "narration" as const,
            label: "Agent",
            detail: String(block.text),
          },
        ];
      }
      if (block.type !== "tool_use") return [];
      const name = String(block.name || "Tool");
      const input =
        block.input && typeof block.input === "object"
          ? (block.input as Record<string, unknown>)
          : {};
      return [
        {
          kind: "tool" as const,
          label: toolActivityLabel(name, input, cwd),
          detail: JSON.stringify(input, null, 2),
          toolUseId: String(block.id || ""),
          toolName: name,
        },
      ];
    });
  }

  if (event.type === "user") {
    const message = event.message as
      { content?: Array<Record<string, unknown>> } | undefined;
    return (message?.content || []).flatMap<ClaudeActivity>((block) => {
      if (block.type !== "tool_result") return [];
      const content =
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content || "", null, 2);
      return [
        {
          kind: "tool_result" as const,
          label: block.is_error ? "执行失败" : "执行完成",
          detail: content,
          toolUseId: String(block.tool_use_id || ""),
          isError: Boolean(block.is_error),
        },
      ];
    });
  }

  return [];
}
