import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listWorkspaceEntries,
  readEditableFile,
  removeWorkspaceEntry,
  resolveWorkspaceFile,
  resolveWorkspaceTarget,
  resolveWorkspaceEntry,
  editableFileVersion,
} from "./workspace.js";

test("workspace listing includes sibling projects and ignores dependency caches", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cloudink-list-"));
  try {
    fs.mkdirSync(path.join(workspace, "project-a", ".venv"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(workspace, "project-b"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "project-b", ".codex", "skills"), {
      recursive: true,
    });
    for (let index = 0; index < 20; index += 1)
      fs.writeFileSync(
        path.join(workspace, "project-a", ".venv", `${index}.py`),
        "ignored",
      );
    fs.writeFileSync(path.join(workspace, "project-a", "a.ts"), "a");
    fs.writeFileSync(path.join(workspace, "project-b", "b.ts"), "b");
    fs.writeFileSync(
      path.join(workspace, "project-b", ".codex", "skills", "hidden.md"),
      "hidden",
    );

    const result = listWorkspaceEntries(workspace, 10);
    assert.deepEqual(
      result.files.map((file) => file.path),
      ["project-a/a.ts", "project-b/b.ts"],
    );
    assert.deepEqual(result.directories, ["project-a", "project-b"]);
    assert.equal(
      result.files.some((file) => file.path.includes("/.codex/")),
      false,
    );
    assert.equal(result.truncated, false);
    const initialVersion = result.version;
    fs.writeFileSync(path.join(workspace, "project-a", "a.ts"), "z");
    const changedTime = new Date(Date.now() + 2_000);
    fs.utimesSync(
      path.join(workspace, "project-a", "a.ts"),
      changedTime,
      changedTime,
    );
    assert.notEqual(
      listWorkspaceEntries(workspace, 10).version,
      initialVersion,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true });
  }
});

test("listing reports omitted files even when they share one directory", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cloudink-cap-"));
  try {
    for (let i = 0; i < 3; i++)
      fs.writeFileSync(path.join(workspace, `${i}.txt`), "x");
    assert.equal(listWorkspaceEntries(workspace, 3).truncated, false);
    const limited = listWorkspaceEntries(workspace, 2);
    assert.equal(limited.files.length, 2);
    assert.equal(limited.truncated, true);
    fs.unlinkSync(path.join(workspace, "2.txt"));
    const exact = listWorkspaceEntries(workspace, 2);
    assert.equal(exact.truncated, false);
    assert.notEqual(exact.version, limited.version);
  } finally {
    fs.rmSync(workspace, { recursive: true });
  }
});

test("existing copy and publication sources cannot escape through parent symlinks", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cloudink-source-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cloudink-private-"));
  try {
    fs.mkdirSync(path.join(outside, "site"));
    fs.writeFileSync(path.join(outside, "site", "index.html"), "private");
    fs.symlinkSync(outside, path.join(workspace, "external"));
    assert.throws(() => resolveWorkspaceEntry(workspace, "external/site"));
    assert.throws(() =>
      resolveWorkspaceEntry(workspace, "external/site/index.html"),
    );
    fs.writeFileSync(path.join(workspace, "safe.html"), "safe");
    assert.equal(
      resolveWorkspaceEntry(workspace, "safe.html"),
      path.join(workspace, "safe.html"),
    );
  } finally {
    fs.rmSync(workspace, { recursive: true });
    fs.rmSync(outside, { recursive: true });
  }
});

test("file versions change on same-size edits without relying on timestamps", () => {
  assert.notEqual(editableFileVersion("one"), editableFileVersion("two"));
  assert.equal(
    editableFileVersion("你好"),
    editableFileVersion(Buffer.from("你好")),
  );
});

test("recursive folder deletion removes all descendants", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ui-delete-"));
  try {
    fs.mkdirSync(path.join(workspace, "folder", "nested"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "folder", "root.txt"), "root");
    fs.writeFileSync(
      path.join(workspace, "folder", "nested", "child.txt"),
      "child",
    );
    assert.deepEqual(removeWorkspaceEntry(workspace, "folder"), {
      path: "folder",
      kind: "folder",
    });
    assert.equal(fs.existsSync(path.join(workspace, "folder")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true });
  }
});

test("workspace file resolution stays inside the user workspace", () => {
  const workspace = path.join(os.tmpdir(), "claude-ui-workspace");
  assert.equal(
    resolveWorkspaceFile(workspace, "src/index.ts"),
    path.join(workspace, "src/index.ts"),
  );
  assert.throws(() => resolveWorkspaceFile(workspace, "../secret.txt"));
  assert.throws(() => resolveWorkspaceFile(workspace, "/etc/passwd"));
});

test("new workspace targets require a parent inside the workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ui-target-"));
  try {
    fs.mkdirSync(path.join(workspace, "src"));
    assert.equal(
      resolveWorkspaceTarget(workspace, "src/new.ts"),
      path.join(workspace, "src/new.ts"),
    );
    assert.throws(() => resolveWorkspaceTarget(workspace, "missing/new.ts"));
  } finally {
    fs.rmSync(workspace, { recursive: true });
  }
});

test("editable files reject binary content", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ui-edit-"));
  try {
    fs.writeFileSync(
      path.join(workspace, "binary.bin"),
      Buffer.from([1, 0, 2]),
    );
    assert.throws(() => readEditableFile(workspace, "binary.bin"));
  } finally {
    fs.rmSync(workspace, { recursive: true });
  }
});

test("editable files reject a parent directory symlink that escapes", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ui-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ui-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(workspace, "linked"), "dir");
    assert.throws(() => readEditableFile(workspace, "linked/secret.txt"));
  } finally {
    fs.rmSync(workspace, { recursive: true });
    fs.rmSync(outside, { recursive: true });
  }
});
