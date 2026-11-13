import { parsePatch } from "../src/edit-diff.js";

// Read static JSON string arguments only. Never execute rollout JavaScript.
// Unsupported templates/regex expressions fail closed rather than guessing.
export function literalCodexPatches(payload: Record<string, unknown>) {
  const source = payload.input ?? payload.arguments;
  if (typeof source !== "string") return [];
  let patches: string[] = [];
  if (payload.name === "apply_patch") {
    if (source.startsWith("*** Begin Patch\n")) patches = [source];
    else {
      try {
        const input = JSON.parse(source);
        const patch =
          typeof input === "string" ? input : (input.patch ?? input.input);
        if (typeof patch === "string") patches = [patch];
      } catch {
        /* Not a static patch. */
      }
    }
  } else if (payload.name === "exec") {
    const tokens: { value: string; literal?: string }[] = [];
    for (let i = 0; i < source.length;) {
      if (/\s/.test(source[i])) {
        i++;
        continue;
      }
      if (source.startsWith("//", i)) {
        const end = source.indexOf("\n", i + 2);
        i = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith("/*", i)) {
        const end = source.indexOf("*/", i + 2);
        if (end < 0) return [];
        i = end + 2;
        continue;
      }
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const start = i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === "\\") i++;
          i++;
        }
        if (i >= source.length) return [];
        const raw = source.slice(start, ++i);
        let literal: string | undefined;
        if (quote === '"') {
          try {
            literal = JSON.parse(raw);
          } catch {
            /* Unsupported JS escape. */
          }
        }
        tokens.push({ value: "string", literal });
        continue;
      }
      if (quote === "`" || quote === "/") return [];
      const identifier = source.slice(i).match(/^[a-zA-Z_$][\w$]*/)?.[0];
      tokens.push({ value: identifier || quote });
      i += identifier?.length || 1;
    }
    for (let i = 0; i + 5 < tokens.length; i++) {
      if (tokens[i - 1]?.value === ".") continue;
      if (
        tokens
          .slice(i, i + 4)
          .map((t) => t.value)
          .join(" ") !== "tools . apply_patch ("
      )
        continue;
      if (tokens[i + 5].value !== ")") continue;
      const patch = tokens[i + 4].literal;
      if (patch) patches.push(patch);
    }
  }
  return patches.flatMap((patch) => {
    if (
      !patch.startsWith("*** Begin Patch\n") ||
      !patch.trimEnd().endsWith("*** End Patch")
    )
      return [];
    const headers = [
      ...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: .+$/gm),
    ];
    const files = parsePatch(patch);
    if (!headers.length || files.length !== headers.length) return [];
    const changes: Record<string, { type: string; unified_diff: string }> = {};
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.path || changes[file.path]) return [];
      const section = patch.slice(
        headers[i].index!,
        headers[i + 1]?.index ?? patch.lastIndexOf("*** End Patch"),
      );
      changes[file.path] = {
        type:
          file.operation === "added"
            ? "add"
            : file.operation === "deleted"
              ? "delete"
              : "update",
        unified_diff: `*** Begin Patch\n${section.trimEnd()}\n*** End Patch`,
      };
    }
    return [{ changes }];
  });
}

export function createCodexPatchBridge(
  onPatch: (event: Record<string, unknown>) => void,
) {
  const calls = new Map<
    string,
    { startedAt: number; patches: ReturnType<typeof literalCodexPatches> }
  >();
  const completed = new Set<string>();
  return (event: Record<string, any>) => {
    if (
      event.type === "event_msg" &&
      event.payload?.type === "patch_apply_end"
    ) {
      calls.delete(event.payload.call_id);
      completed.add(event.payload.call_id);
      return;
    }
    if (event.type !== "response_item") return;
    const payload = event.payload;
    if (!payload || typeof payload.call_id !== "string") return;
    const callId = payload.call_id;
    if (completed.has(callId)) return;
    if (["custom_tool_call", "function_call"].includes(payload.type)) {
      const patches = literalCodexPatches(payload);
      if (patches.length)
        calls.set(callId, { startedAt: Date.parse(event.timestamp), patches });
    } else if (
      ["custom_tool_call_output", "function_call_output"].includes(payload.type)
    ) {
      const call = calls.get(callId);
      calls.delete(callId);
      completed.add(callId);
      if (!call || payload.is_error || payload.isError) return;
      const keys = call.patches.map((patch) =>
        JSON.stringify(
          Object.entries(patch.changes)
            .map(([file, change]) => [file, change.type])
            .sort(),
        ),
      );
      for (let i = 0; i < call.patches.length; i++) {
        // Repeated edits of the same files inside one exec have no unique
        // timing boundary. Leave them unresolved instead of misattributing.
        if (keys.filter((key) => key === keys[i]).length !== 1) continue;
        onPatch({
          type: "patch_apply_end",
          success: true,
          call_id: `${callId}:${i}`,
          source: "literal_apply_patch",
          started_at: call.startedAt,
          completed_at: Date.parse(event.timestamp),
          ...call.patches[i],
        });
      }
    }
  };
}
