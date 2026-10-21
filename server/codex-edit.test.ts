import assert from "node:assert/strict";
import test from "node:test";
import { createCodexEditDetails } from "./codex-edit.js";
import { parseEditDiff } from "../src/edit-diff.js";

const activity = (file = "test.ts") => ({
  kind: "tool" as const,
  toolName: "Edit",
  label: "Edit files",
  detail: JSON.stringify({
    changes: [{ path: file, kind: "update", extra: true }],
  }),
});
const patch = (diff = "@@ -1 +1 @@\n-old\n+new") => ({
  type: "patch_apply_end",
  success: true,
  changes: { "/workspace/test.ts": { type: "update", unified_diff: diff } },
});

test("enriches Edit before or after its rollout arrives and preserves event fields", () => {
  for (const patchFirst of [true, false]) {
    const details = createCodexEditDetails("/workspace");
    let result = "";
    if (patchFirst) details.addPatch(patch());
    details.addActivity(activity(), (detail) => {
      result = detail;
    });
    if (!patchFirst) details.addPatch(patch());
    assert.equal(JSON.parse(result).changes[0].extra, true);
    assert.equal(JSON.parse(result).changes[0].path, "test.ts");
    const [file] = parseEditDiff(result);
    assert.deepEqual(
      file.lines.slice(1).map((l) => [l.kind, l.text]),
      [
        ["removed", "old"],
        ["added", "new"],
      ],
    );
  }
});

test("matches complete file sets, ignores failed patches, and consumes each patch once", () => {
  const details = createCodexEditDetails("/workspace");
  const results: string[] = [];
  details.addActivity(activity("other.ts"), (value) => results.push(value));
  details.addActivity(activity(), (value) => results.push(value));
  details.addPatch({ ...patch(), success: false });
  assert.equal(results.length, 0);
  details.addPatch(patch());
  assert.equal(results.length, 1);
  details.addActivity(activity(), (value) => results.push(value));
  assert.equal(results.length, 1);
  details.addPatch(patch("@@ -1 +1 @@\n-new\n+next"));
  assert.equal(results.length, 2);
  assert.match(results[1], /next/);
});

test("shows added and deleted content from rollout records", () => {
  const details = createCodexEditDetails("/workspace");
  let result = "";
  details.addActivity(
    {
      ...activity(),
      detail: JSON.stringify({
        changes: [
          { path: "new.ts", kind: "add" },
          { path: "old.ts", kind: "delete" },
        ],
      }),
    },
    (value) => {
      result = value;
    },
  );
  details.addPatch({
    type: "patch_apply_end",
    success: true,
    changes: {
      "/workspace/new.ts": { type: "add", content: "hello\n" },
      "/workspace/old.ts": { type: "delete", content: "bye\n" },
    },
  });
  const files = parseEditDiff(result);
  assert.deepEqual(
    files.map((f) => f.lines),
    [[{ kind: "added", text: "hello" }], [{ kind: "removed", text: "bye" }]],
  );
});
