import { spawn } from "node:child_process";

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

export type ClaudeEvent = { type: string; [key: string]: unknown };
export type ClaudeActivity = {
  kind: "status" | "thinking" | "tool" | "tool_result";
  label: string;
  detail?: string;
  toolUseId?: string;
  isError?: boolean;
};
export function runClaude(opts: {
  prompt: string;
  cwd: string;
  sessionId: string;
  resume: boolean;
  permissionMode: "auto" | "plan" | "manual" | "acceptEdits";
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
    "--permission-mode",
    opts.permissionMode,
    "--allowed-tools",
    process.env.CLAUDE_ALLOWED_TOOLS || "Bash",
    "--tools",
    opts.tools ?? "default",
  ];
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);
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
  if (event.type === "stream_event") {
    const e = event.event as
      { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta")
      return e.delta.text || "";
  }
  return "";
}

export function activitiesFromEvent(event: ClaudeEvent): ClaudeActivity[] {
  if (event.type === "assistant") {
    const message = event.message as
      { content?: Array<Record<string, unknown>> } | undefined;
    return (message?.content || []).flatMap<ClaudeActivity>((block) => {
      if (block.type === "thinking" && block.thinking) {
        return [
          {
            kind: "thinking" as const,
            label: "Thinking",
            detail: String(block.thinking),
          },
        ];
      }
      if (block.type !== "tool_use") return [];
      return [
        {
          kind: "tool" as const,
          label: String(block.name || "Tool"),
          detail: JSON.stringify(block.input || {}, null, 2),
          toolUseId: String(block.id || ""),
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
