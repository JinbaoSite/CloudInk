import path from "node:path";
import type { CodexActivity } from "./codex.js";

type Change = { path: string; kind: string; [key: string]: unknown };

// The exec stream omits diff contents. The same thread's patch_apply_end
// records retain them, including the original content of deleted files.
export function createCodexEditDetails(cwd: string) {
  const waiting: {
    input: Record<string, unknown>;
    changes: Change[];
    update: (detail: string) => void;
    timestamp?: number;
  }[] = [];
  const patches: {
    changes: Change[];
    startedAt?: number;
    completedAt?: number;
  }[] = [];
  const key = (changes: Change[]) =>
    JSON.stringify(
      changes
        .map((change) => [
          path.resolve(cwd, change.path),
          (
            {
              update: "modified",
              modify: "modified",
              add: "added",
              delete: "deleted",
            } as Record<string, string>
          )[change.kind] || change.kind,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  const reconcile = () => {
    for (let i = 0; i < waiting.length;) {
      const pending = waiting[i];
      const matches = patches
        .map((patch, index) => ({ patch, index }))
        .filter(
          ({ patch }) =>
            key(patch.changes) === key(pending.changes) &&
            (patch.startedAt === undefined ||
              (pending.timestamp !== undefined &&
                pending.timestamp >= patch.startedAt &&
                pending.timestamp <= patch.completedAt! + 5000)),
        );
      if (matches.length !== 1) {
        i++;
        continue;
      }
      const [{ changes }] = patches.splice(matches[0].index, 1);
      waiting.splice(i, 1);
      const enriched = pending.changes.map((original) => {
        const patch = changes.find(
          (change) =>
            path.resolve(cwd, change.path) === path.resolve(cwd, original.path),
        )!;
        return {
          ...patch,
          ...original,
          unified_diff:
            original.diff ??
            original.patch ??
            original.unified_diff ??
            patch.unified_diff,
        };
      });
      pending.update(
        JSON.stringify({ ...pending.input, changes: enriched }, null, 2),
      );
    }
  };
  return {
    addActivity(
      activity: CodexActivity,
      update: (detail: string) => void,
      timestamp?: number,
    ) {
      if (activity.kind !== "tool" || activity.toolName !== "Edit") return;
      try {
        const input = JSON.parse(activity.detail || "{}");
        if (
          !Array.isArray(input.changes) ||
          !input.changes.length ||
          !input.changes.every(
            (c: Change) =>
              c && typeof c.path === "string" && typeof c.kind === "string",
          )
        )
          return;
        waiting.push({ input, changes: input.changes, update, timestamp });
        reconcile();
      } catch {
        /* Legacy or path-only input has no reliable match. */
      }
    },
    addPatch(event: Record<string, unknown>) {
      if (
        event.type !== "patch_apply_end" ||
        event.success !== true ||
        !event.changes ||
        typeof event.changes !== "object" ||
        Array.isArray(event.changes)
      )
        return;
      const changes: Change[] = [];
      for (const [filePath, value] of Object.entries(event.changes)) {
        if (!value || typeof value !== "object") return;
        const change = value as Record<string, unknown>;
        if (typeof change.type !== "string") return;
        changes.push({ ...change, path: filePath, kind: change.type });
      }
      if (changes.length) {
        patches.push({
          changes,
          ...(event.source === "literal_apply_patch"
            ? {
                startedAt: Number(event.started_at),
                completedAt: Number(event.completed_at),
              }
            : {}),
        });
        reconcile();
      }
    },
  };
}
