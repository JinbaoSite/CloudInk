import assert from "node:assert/strict";
import test from "node:test";
import { parseEditDiff, parsePatch } from "../src/edit-diff.js";

test("groups multi-file apply_patch edits and turns @@ into unnumbered hunks", () => {
  const files = parsePatch(`*** Begin Patch
*** Update File: /project/first.py
@@ def first():
-old
+new
@@
 context
---literal minus
+++literal plus
*** Add File: /project/new.py
+hello
+
*** Delete File: /project/old.py
*** Update File: /project/before.py
*** Move to: /project/after.py
@@
-before
+after
*** End Patch`);
  assert.deepEqual(
    files.map((f) => [f.path, f.operation]),
    [
      ["/project/first.py", "modified"],
      ["/project/new.py", "added"],
      ["/project/old.py", "deleted"],
      ["/project/after.py", "renamed"],
    ],
  );
  assert.equal(files[0].lines[0].kind, "hunk");
  assert.equal(files[0].lines[0].text, "def first():");
  assert.ok(
    files[0].lines.every(
      (l) => l.oldLine === undefined && l.newLine === undefined,
    ),
  );
  assert.deepEqual(
    files[0].lines.slice(-2).map((l) => [l.kind, l.text]),
    [
      ["removed", "--literal minus"],
      ["added", "++literal plus"],
    ],
  );
  assert.equal(files[1].lines[1].text, "");
  assert.equal(files[3].previousPath, "/project/before.py");
});

test("numbers old and new lines independently across unified hunks and files", () => {
  const files = parsePatch(`--- a/first.py
+++ b/first.py
@@ -10,2 +20,3 @@ function
 keep
-old
+new
+extra
@@ -40 +60 @@
-before
+after
--- a/second.py
+++ b/second.py
@@ -1 +1 @@
-a
+b`);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "first.py");
  assert.equal(files[1].path, "second.py");
  assert.deepEqual(
    files[0].lines.slice(1, 5).map((l) => [l.oldLine, l.newLine]),
    [
      [10, 20],
      [11, undefined],
      [undefined, 21],
      [undefined, 22],
    ],
  );
  assert.equal(files[0].lines[5].oldLine, 40);
  assert.equal(files[0].lines[6].oldLine, 40);
  assert.equal(files[0].lines[7].newLine, 60);
});

test("handles Git add/delete/rename and no-newline markers", () => {
  const files = parsePatch(`diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new
\\ No newline at end of file
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
diff --git a/old-name.txt b/new-name.txt
similarity index 100%
rename from old-name.txt
rename to new-name.txt`);
  assert.deepEqual(
    files.map((f) => [f.path, f.operation]),
    [
      ["new.txt", "added"],
      ["old.txt", "deleted"],
      ["new-name.txt", "renamed"],
    ],
  );
  assert.equal(files[0].lines[2].kind, "note");
  assert.equal(files[2].previousPath, "old-name.txt");
});

test("preserves structured changes with and without diff contents", () => {
  const files = parseEditDiff(
    JSON.stringify({
      changes: [
        { path: "one.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" },
        { path: "two.ts", kind: "add" },
        { path: "three.ts", kind: "delete" },
      ],
    }),
  );
  assert.deepEqual(
    files.map((f) => f.path),
    ["one.ts", "two.ts", "three.ts"],
  );
  assert.equal(files[0].lines[1].text, "old");
  assert.equal(files[1].lines.length, 0);
  assert.equal(files[2].operation, "deleted");
});

test("supports Claude MultiEdit and raw JSON patch inputs without false line numbers", () => {
  const [file] = parseEditDiff(
    JSON.stringify({
      file_path: "test.ts",
      edits: [
        { old_string: "one\ntwo\n", new_string: "three\n" },
        { old_string: "", new_string: "new\n" },
      ],
    }),
  );
  assert.equal(file.path, "test.ts");
  assert.equal(file.lines.filter((l) => l.kind === "hunk").length, 2);
  assert.equal(file.lines.filter((l) => l.kind === "removed").length, 2);
  assert.equal(file.lines.filter((l) => l.kind === "added").length, 2);
  assert.ok(file.lines.every((l) => l.oldLine === undefined));
  assert.equal(
    parseEditDiff(
      JSON.stringify({
        patch: "*** Begin Patch\n*** Add File: new.ts\n+ok\n*** End Patch",
      }),
    )[0].path,
    "new.ts",
  );
  assert.deepEqual(parseEditDiff("null"), []);
  assert.deepEqual(parseEditDiff(""), []);
});
