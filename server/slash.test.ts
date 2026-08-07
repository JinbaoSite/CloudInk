import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { descriptionForSlashItem, discoverSlashDescriptions } from "./slash.js";

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
