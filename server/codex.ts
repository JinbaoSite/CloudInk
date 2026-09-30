import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexEvent = { type: string; [key: string]: unknown };
export type CodexActivity = {
  kind: "status" | "thinking" | "narration" | "tool" | "tool_result";
  label: string;
  detail?: string;
  toolUseId?: string;
  isError?: boolean;
  toolName?: string;
  output?: string;
};
export type CodexResponseMetrics = {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};
export type StoredCodexResponseMetrics = CodexResponseMetrics & {
  usageScope: "turn";
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeCacheReadTokens: number;
  cumulativeCacheCreationTokens: number;
};

const codexWebPrompt = `You are running inside the CloudInk non-interactive Web UI. Complete the user's task directly in the current workspace. Do not ask for terminal confirmation because no interactive terminal is attached. If a decision is essential, explain the question clearly in your final response.`;

let codexAvailability: Promise<boolean> | undefined;

/**
 * Probe the CLI once without blocking Node's event loop. A synchronous
 * `codex --version` can take a couple of seconds on this server and used to
 * stall every request arriving while the config endpoint was being served.
 */
export function codexAvailable() {
  if (codexAvailability) return codexAvailability;
  codexAvailability = new Promise<boolean>((resolve) => {
    const child = spawn(process.env.CODEX_CLI_PATH || "codex", ["--version"], {
      stdio: "ignore",
    });
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 5_000);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
  return codexAvailability;
}

export function configuredCodexModels() {
  const candidates: Array<[string | undefined, string]> = [
    [process.env.CODEX_MODEL, "服务端指定模型"],
  ];
  try {
    const cache = JSON.parse(
      fs.readFileSync(
        path.join(
          process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
          "models_cache.json",
        ),
        "utf8",
      ),
    ) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        description?: unknown;
        visibility?: unknown;
        priority?: unknown;
        supported_in_api?: unknown;
      }>;
    };
    for (const model of [...(cache.models || [])].sort(
      (a, b) => Number(a.priority || 999) - Number(b.priority || 999),
    )) {
      if (
        model.visibility !== "list" ||
        model.supported_in_api === false ||
        typeof model.slug !== "string"
      )
        continue;
      candidates.push([
        model.slug,
        typeof model.description === "string"
          ? model.description
          : typeof model.display_name === "string"
            ? model.display_name
            : "Codex 模型",
      ]);
    }
  } catch {}
  try {
    const config = fs.readFileSync(
      path.join(
        process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        "config.toml",
      ),
      "utf8",
    );
    const configured = config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1];
    candidates.splice(1, 0, [configured, "Codex 默认模型"]);
  } catch {}
  const seen = new Set<string>();
  return candidates.flatMap(([value, description]) => {
    const model = value?.trim();
    if (!model || seen.has(model)) return [];
    seen.add(model);
    return [{ value: model, description }];
  });
}

export function currentCodexModel() {
  return configuredCodexModels()[0]?.value || "CLI default";
}

function short(value: unknown, max = 160) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function textFromCodexEvent(event: CodexEvent) {
  if (event.type !== "item.completed") return "";
  const item = event.item as Record<string, unknown> | undefined;
  return item?.type === "agent_message" && typeof item.text === "string"
    ? item.text
    : "";
}

/**
 * Codex emits completed agent messages both for progress narration before a
 * tool call and for the final answer. The distinction is only known when the
 * next event arrives, so keep the latest agent text pending until either a
 * tool starts or the turn completes.
 */
export function createCodexAnswerTracker() {
  let answer = "";
  let committedAnswer = "";
  let pendingText = "";

  return {
    append(text: string) {
      answer += text;
      pendingText += text;
      return answer;
    },
    beforeTool() {
      if (!pendingText.trim()) return null;
      const narration = pendingText;
      answer = committedAnswer;
      pendingText = "";
      return { answer, narration };
    },
    completeTurn() {
      committedAnswer = answer;
      pendingText = "";
      return answer;
    },
    answer() {
      return answer;
    },
  };
}

export function activitiesFromCodexEvent(event: CodexEvent): CodexActivity[] {
  const item = event.item as Record<string, unknown> | undefined;
  if (!item || typeof item.id !== "string") return [];
  const id = item.id;
  if (item.type === "reasoning") {
    const detail = String(item.text || "");
    return detail
      ? [{ kind: "thinking", label: "Thinking", detail, toolUseId: id }]
      : [];
  }
  if (event.type === "item.started" && item.type === "command_execution") {
    return [
      {
        kind: "tool",
        label: `Bash${item.command ? ` ${short(item.command)}` : ""}`,
        detail: String(item.command || ""),
        toolUseId: id,
        toolName: "Bash",
      },
    ];
  }
  if (event.type === "item.completed" && item.type === "command_execution") {
    return [
      {
        kind: "tool_result",
        label: "Bash",
        detail: String(item.aggregated_output || ""),
        toolUseId: id,
        isError: Number(item.exit_code) !== 0,
      },
    ];
  }
  if (event.type === "item.started" && item.type === "mcp_tool_call") {
    const name = String(item.tool || item.name || "MCP");
    return [
      {
        kind: "tool",
        label: `${name}${item.server ? ` (${short(item.server)})` : ""}`,
        detail: item.arguments ? JSON.stringify(item.arguments) : "",
        toolUseId: id,
        toolName: name,
      },
    ];
  }
  if (event.type === "item.completed" && item.type === "mcp_tool_call") {
    return [
      {
        kind: "tool_result",
        label: String(item.tool || item.name || "MCP"),
        detail:
          typeof item.result === "string"
            ? item.result
            : JSON.stringify(item.result || ""),
        toolUseId: id,
        isError: item.status === "failed" || Boolean(item.error),
      },
    ];
  }
  if (event.type === "item.started" && item.type === "web_search") {
    return [
      {
        kind: "tool",
        label: `Web Search${item.query ? ` ${short(item.query)}` : ""}`,
        detail: String(item.query || ""),
        toolUseId: id,
        toolName: "WebSearch",
      },
    ];
  }
  if (event.type === "item.completed" && item.type === "web_search") {
    return [
      {
        kind: "tool_result",
        label: "Web Search",
        detail: String(item.query || "完成"),
        toolUseId: id,
      },
    ];
  }
  if (event.type === "item.completed" && item.type === "file_change") {
    return [
      {
        kind: "tool",
        label: `Edit${item.path ? ` ${short(item.path)}` : " files"}`,
        detail: String(item.path || item.changes || "文件已修改"),
        toolUseId: id,
        toolName: "Edit",
      },
    ];
  }
  return [];
}

export function metricsFromCodexEvent(
  event: CodexEvent,
  durationMs: number,
): CodexResponseMetrics | null {
  if (event.type !== "turn.completed") return null;
  const usage = (event.usage || {}) as Record<string, unknown>;
  const number = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  return {
    durationMs,
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    cacheReadTokens: number(usage.cached_input_tokens),
    cacheCreationTokens: number(usage.cache_write_input_tokens),
  };
}

export function metricsForCodexTurn(
  cumulative: CodexResponseMetrics,
  previous?: Partial<StoredCodexResponseMetrics & CodexResponseMetrics> | null,
): StoredCodexResponseMetrics {
  const previousValue = (
    cumulativeKey: keyof StoredCodexResponseMetrics,
    legacyKey: keyof CodexResponseMetrics,
  ) => {
    const value =
      previous?.usageScope === "turn"
        ? previous[cumulativeKey]
        : previous?.[legacyKey];
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  };
  const delta = (current: number, prior: number) =>
    current >= prior ? current - prior : current;
  return {
    durationMs: cumulative.durationMs,
    inputTokens: delta(
      cumulative.inputTokens,
      previousValue("cumulativeInputTokens", "inputTokens"),
    ),
    outputTokens: delta(
      cumulative.outputTokens,
      previousValue("cumulativeOutputTokens", "outputTokens"),
    ),
    cacheReadTokens: delta(
      cumulative.cacheReadTokens,
      previousValue("cumulativeCacheReadTokens", "cacheReadTokens"),
    ),
    cacheCreationTokens: delta(
      cumulative.cacheCreationTokens,
      previousValue("cumulativeCacheCreationTokens", "cacheCreationTokens"),
    ),
    usageScope: "turn",
    cumulativeInputTokens: cumulative.inputTokens,
    cumulativeOutputTokens: cumulative.outputTokens,
    cumulativeCacheReadTokens: cumulative.cacheReadTokens,
    cumulativeCacheCreationTokens: cumulative.cacheCreationTokens,
  };
}

export function codexThreadIdFromEvent(event: CodexEvent) {
  return event.type === "thread.started" && typeof event.thread_id === "string"
    ? event.thread_id
    : "";
}

export function codexSandboxConfig(
  permissionMode: "auto" | "plan" | "manual" | "acceptEdits",
  writableRoot?: string,
) {
  const mode =
    permissionMode === "plan" || permissionMode === "manual"
      ? "read-only"
      : "workspace-write";
  const args = ["-c", `sandbox_mode=${JSON.stringify(mode)}`];
  if (mode === "workspace-write" && writableRoot)
    args.push(
      "-c",
      `sandbox_workspace_write.writable_roots=${JSON.stringify([
        writableRoot,
      ])}`,
    );
  return { mode, args };
}

export function runCodex(opts: {
  prompt: string;
  cwd: string;
  writableRoot?: string;
  threadId?: string;
  permissionMode: "auto" | "plan" | "manual" | "acceptEdits";
  model?: string;
  signal: AbortSignal;
}) {
  const prompt = `${codexWebPrompt}\n\n${opts.prompt}`;
  const shared = ["--json", "--skip-git-repo-check"];
  const model =
    opts.model && opts.model !== "CLI default"
      ? opts.model
      : process.env.CODEX_MODEL;
  if (model) shared.push("--model", model);
  const sandbox = codexSandboxConfig(opts.permissionMode, opts.writableRoot);
  const args = opts.threadId
    ? ["exec", "resume", ...shared, ...sandbox.args, opts.threadId, prompt]
    : [
        "exec",
        ...shared,
        "--sandbox",
        sandbox.mode,
        ...sandbox.args.slice(2),
        "--cd",
        opts.cwd,
        prompt,
      ];
  const child = spawn(process.env.CODEX_CLI_PATH || "codex", args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  opts.signal.addEventListener("abort", () => child.kill("SIGTERM"), {
    once: true,
  });
  return child;
}
