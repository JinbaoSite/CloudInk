import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  descriptionForSlashItem,
  discoverCodexCapabilities,
  discoverSlashDescriptions,
} from "./slash.js";

test("uses specific descriptions for built-in Claude items", () => {
  const descriptions = discoverSlashDescriptions(
    path.join(os.tmpdir(), "missing-claude-workspace"),
  );
  assert.equal(
    descriptionForSlashItem(descriptions, "loop", "skill"),
    "Repeat a prompt or command on an interval (for example, /loop 5m /foo)",
  );
  assert.equal(
    descriptionForSlashItem(descriptions, "dataviz", "skill"),
    "Design guidance and fundamentals for Artifacts",
  );
});

test("project Skill metadata overrides built-in descriptions", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slash-scan-"));
  const skillDirectory = path.join(workspace, ".claude", "skills", "dataviz");
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(skillDirectory, "SKILL.md"),
    "---\nname: dataviz\ndescription: Project-specific chart guidance\n---\n",
  );
  const descriptions = discoverSlashDescriptions(workspace);
  assert.equal(descriptions.get("dataviz"), "Project-specific chart guidance");
  fs.rmSync(workspace, { recursive: true });
});

test("discovers Codex commands and skills from user and project directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-slash-scan-"));
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(path.join(codexHome, "prompts"), { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "prompts", "release.md"),
    "---\ndescription: Prepare a release\n---\n",
  );
  fs.mkdirSync(path.join(workspace, ".agents", "skills", "workspace-audit"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(workspace, ".agents", "skills", "workspace-audit", "SKILL.md"),
    "---\nname: workspace-audit\ndescription: Audit this workspace\n---\n",
  );
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const capabilities = discoverCodexCapabilities(workspace);
    assert.ok(capabilities.slashCommands.includes("status"));
    assert.ok(capabilities.slashCommands.includes("release"));
    assert.deepEqual(capabilities.skills, ["workspace-audit"]);
    assert.equal(
      capabilities.descriptions.get("workspace-audit"),
      "Audit this workspace",
    );
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(root, { recursive: true });
  }
});
