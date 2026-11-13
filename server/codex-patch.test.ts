import assert from "node:assert/strict";
import test from "node:test";
import { literalCodexPatches, createCodexPatchBridge } from "./codex-patch.js";
import { createCodexEditDetails } from "./codex-edit.js";
import { parseEditDiff } from "../src/edit-diff.js";

const patch =
  "*** Begin Patch\n*** Update File: test.py\n@@\n-old\n+中文新内容\n*** End Patch";
const source = `text(await tools.apply_patch(${JSON.stringify(patch)}));`;
const call = (input = source) => ({
  name: "exec",
  type: "custom_tool_call",
  call_id: "call-1",
  input,
});
const record = (payload: object, time: number) => ({
  type: "response_item",
  timestamp: new Date(time).toISOString(),
  payload,
});

test("extracts literal exec patches without executing JavaScript or reading embedded examples", () => {
  const [parsed] = literalCodexPatches(
    call(source + '\ntext(await tools.exec_command({cmd:"python test.py"}));'),
  );
  assert.equal(parsed.changes["test.py"].type, "update");
  assert.match(parsed.changes["test.py"].unified_diff, /中文新内容/);
  assert.deepEqual(
    literalCodexPatches(call(`// ${source}\ntext(${JSON.stringify(source)});`)),
    [],
  );
  assert.deepEqual(
    literalCodexPatches(call("tools.apply_patch(buildPatch());")),
    [],
  );
  assert.deepEqual(
    literalCodexPatches(
      call(
        "tools.apply_patch(`*** Begin Patch\n${dangerous()}\n*** End Patch`);",
      ),
    ),
    [],
  );
  assert.deepEqual(
    literalCodexPatches(
      call("tools.apply_patch(" + JSON.stringify(patch) + " + suffix);"),
    ),
    [],
  );
});

test("enriches a confirmed file change only in its completed call interval and deduplicates replay", () => {
  const details = createCodexEditDetails("/workspace");
  const results: string[] = [],
    events: Record<string, unknown>[] = [];
  const bridge = createCodexPatchBridge((event) => {
    events.push(event);
    details.addPatch(event);
  });
  const activity = {
    kind: "tool" as const,
    label: "Edit files",
    toolName: "Edit",
    detail: JSON.stringify({ changes: [{ path: "test.py", kind: "update" }] }),
  };
  details.addActivity(
    activity,
    (value) => results.push("stale:" + value),
    1000,
  );
  details.addActivity(activity, (value) => results.push(value), 2100);
  bridge(record(call(), 2000));
  assert.equal(results.length, 0);
  const output = record(
    {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [{ type: "input_text", text: "{}" }],
    },
    2200,
  );
  bridge(output);
  assert.equal(results.length, 1);
  assert.deepEqual(
    parseEditDiff(results[0])[0]
      .lines.slice(1)
      .map((line) => [line.kind, line.text]),
    [
      ["removed", "old"],
      ["added", "中文新内容"],
    ],
  );
  bridge(record(call(), 2000));
  bridge(output);
  assert.equal(events.length, 1);
});

test("ignores errored, ambiguous and already-native patch calls", () => {
  for (const mode of ["error", "ambiguous", "native"]) {
    const events: unknown[] = [];
    const bridge = createCodexPatchBridge((event) => events.push(event));
    bridge(record(call(mode === "ambiguous" ? source + source : source), 1000));
    if (mode === "native")
      bridge({
        type: "event_msg",
        payload: { type: "patch_apply_end", call_id: "call-1", success: true },
      });
    bridge(
      record(
        {
          type: "custom_tool_call_output",
          call_id: "call-1",
          is_error: mode === "error",
        },
        2000,
      ),
    );
    assert.equal(events.length, 0, mode);
  }
});
