import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readEditableFile,
  removeWorkspaceEntry,
  resolveWorkspaceFile,
  resolveWorkspaceTarget,
} from "./workspace.js";

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
