export type DiffLine = {
  kind: "added" | "removed" | "context" | "hunk" | "note";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffFile = {
  path: string;
  previousPath?: string;
  operation: "modified" | "added" | "deleted" | "renamed";
  lines: DiffLine[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function operation(value: unknown): DiffFile["operation"] {
  const kind = typeof value === "string" ? value.toLowerCase() : "";
  if (["add", "added", "create"].includes(kind)) return "added";
  if (["delete", "deleted", "remove"].includes(kind)) return "deleted";
  if (["move", "rename", "renamed"].includes(kind)) return "renamed";
  return "modified";
}

function cleanPath(path: string) {
  const value = path.split("\t")[0];
  // Quoted Git paths may contain spaces. Preserve escapes we cannot decode.
  try {
    return (value.startsWith('"') ? JSON.parse(value) : value).replace(
      /^[ab]\//,
      "",
    );
  } catch {
    return value;
  }
}

/** Parse apply_patch and unified diffs without inventing unavailable line numbers. */
export function parsePatch(
  text: string,
  fallbackPath = "变更内容",
): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let inHunk = false;
  let oldRemaining: number | undefined;
  let newRemaining: number | undefined;
  let pendingOldPath: string | undefined;
  let applyPatch = false;
  const start = (path: string, kind: DiffFile["operation"] = "modified") => {
    current = { path, operation: kind, lines: [] };
    files.push(current);
    oldLine = undefined;
    newLine = undefined;
    inHunk = false;
    oldRemaining = undefined;
    newRemaining = undefined;
    pendingOldPath = undefined;
    return current;
  };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [index, line] of lines.entries()) {
    // A bare unified diff can contain several files without diff --git headers.
    // Only consume ---/+++ as headers after the preceding hunk is exhausted.
    if (
      !applyPatch &&
      inHunk &&
      oldRemaining === 0 &&
      newRemaining === 0 &&
      line.startsWith("--- ") &&
      lines[index + 1]?.startsWith("+++ ")
    )
      inHunk = false;
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;
    const header = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (header) {
      applyPatch = true;
      start(header[2], operation(header[1]));
      continue;
    }
    if (line.startsWith("diff --git ")) {
      applyPatch = false;
      const paths = line.match(
        /^diff --git ("(?:\\.|[^"\\])*"|\S+) ("(?:\\.|[^"\\])*"|\S+)$/,
      );
      start(paths ? cleanPath(paths[2]) : fallbackPath);
      continue;
    }
    if (!applyPatch && !inHunk && line.startsWith("--- ")) {
      pendingOldPath = cleanPath(line.slice(4));
      continue;
    }
    if (!applyPatch && !inHunk && line.startsWith("+++ ")) {
      const path = cleanPath(line.slice(4));
      const previous = pendingOldPath;
      if (!current || current.lines.length)
        start(path === "/dev/null" ? previous || fallbackPath : path);
      current!.path = path === "/dev/null" ? previous || fallbackPath : path;
      if (previous === "/dev/null") current!.operation = "added";
      else if (path === "/dev/null") current!.operation = "deleted";
      else if (previous && previous !== path) {
        current!.previousPath = previous;
        current!.operation = "renamed";
      }
      continue;
    }
    if (line.startsWith("*** Move to: ")) {
      if (current) {
        current.previousPath = current.path;
        current.path = line.slice(13);
        current.operation = "renamed";
      }
      continue;
    }
    if (line === "*** End of File") {
      current?.lines.push({ kind: "note", text: "文件末尾" });
      continue;
    }
    if (
      !applyPatch &&
      /^(index |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to )/.test(
        line,
      )
    ) {
      if (!current) start(fallbackPath);
      if (line.startsWith("new file mode")) current!.operation = "added";
      else if (line.startsWith("deleted file mode"))
        current!.operation = "deleted";
      else if (line.startsWith("rename from ")) {
        current!.previousPath = line.slice(12);
        current!.operation = "renamed";
      } else if (line.startsWith("rename to ")) current!.path = line.slice(10);
      else if (/^(old mode|new mode)/.test(line))
        current!.lines.push({ kind: "note", text: line });
      continue;
    }
    if (!current) start(fallbackPath);
    if (/^@@(?:\s|$)/.test(line)) {
      const range = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/,
      );
      oldLine = range ? Number(range[1]) : undefined;
      newLine = range ? Number(range[3]) : undefined;
      oldRemaining = range ? Number(range[2] ?? 1) : undefined;
      newRemaining = range ? Number(range[4] ?? 1) : undefined;
      inHunk = true;
      current!.lines.push({
        kind: "hunk",
        text: range ? range[5] || "" : line.replace(/^@@\s?/, ""),
        oldLine,
        newLine,
      });
    } else if (line.startsWith("\\ No newline at end of file")) {
      current!.lines.push({ kind: "note", text: "文件末尾无换行" });
    } else if (line.startsWith("+")) {
      current!.lines.push({ kind: "added", text: line.slice(1), newLine });
      if (newLine != null) newLine++;
      if (newRemaining != null) newRemaining--;
    } else if (line.startsWith("-")) {
      current!.lines.push({ kind: "removed", text: line.slice(1), oldLine });
      if (oldLine != null) oldLine++;
      if (oldRemaining != null) oldRemaining--;
    } else {
      current!.lines.push({
        kind: "context",
        text: line.startsWith(" ") ? line.slice(1) : line,
        oldLine,
        newLine,
      });
      if (oldLine != null) oldLine++;
      if (newLine != null) newLine++;
      if (oldRemaining != null) oldRemaining--;
      if (newRemaining != null) newRemaining--;
    }
  }
  return files;
}

/** Accept Codex changes, Claude Edit/MultiEdit inputs, and raw patch history. */
export function parseEditDiff(detail: string): DiffFile[] {
  let input: unknown;
  try {
    input = JSON.parse(detail);
  } catch {
    return parsePatch(detail);
  }
  if (typeof input === "string") return parsePatch(input);
  const root = record(input);
  if (!root) return [];
  const path =
    typeof root.file_path === "string"
      ? root.file_path
      : typeof root.path === "string"
        ? root.path
        : "变更内容";
  const patch = root.patch ?? root.diff;
  if (typeof patch === "string") return parsePatch(patch, path);
  if (Array.isArray(root.changes)) {
    return root.changes.flatMap((value): DiffFile[] => {
      const change = record(value);
      if (!change) return [];
      const filePath = typeof change.path === "string" ? change.path : path;
      const diff = change.diff ?? change.patch ?? change.unified_diff;
      if (typeof diff === "string" && diff.trim())
        return parsePatch(diff, filePath).map((file) => ({
          ...file,
          operation: change.kind ? operation(change.kind) : file.operation,
        }));
      const kind = operation(change.kind ?? change.type);
      const content = change.content;
      const lines: DiffLine[] = [];
      if (
        typeof content === "string" &&
        (kind === "added" || kind === "deleted")
      ) {
        const parts = content.replace(/\r\n/g, "\n").split("\n");
        if (parts.at(-1) === "") parts.pop();
        lines.push(
          ...parts.map((text) => ({
            kind: kind === "added" ? ("added" as const) : ("removed" as const),
            text,
          })),
        );
      }
      return [{ path: filePath, operation: kind, lines }];
    });
  }
  const edits = Array.isArray(root.edits) ? root.edits : [root];
  const lines: DiffLine[] = [];
  for (const value of edits) {
    const edit = record(value);
    if (
      !edit ||
      (typeof edit.old_string !== "string" &&
        typeof edit.new_string !== "string")
    )
      continue;
    lines.push({ kind: "hunk", text: "" });
    for (const [key, kind] of [
      ["old_string", "removed"],
      ["new_string", "added"],
    ] as const) {
      const content = edit[key];
      if (typeof content !== "string" || !content) continue;
      const parts = content.split("\n");
      if (parts.at(-1) === "") parts.pop();
      lines.push(...parts.map((text) => ({ kind, text })));
    }
  }
  return lines.length
    ? [{ path, operation: "modified", lines }]
    : typeof root.path === "string" || typeof root.file_path === "string"
      ? [{ path, operation: "modified", lines: [] }]
      : [];
}
