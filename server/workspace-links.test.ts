import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceLink } from "../src/workspace-links.js";

test("opens an absolute root-workspace link before the file list loads", () => {
  assert.equal(
    resolveWorkspaceLink(
      "/root/CloudInk/data/workspaces/jinbao/CDM%E5%A4%9A%E6%A0%B7%E5%8C%96%E6%8E%A8%E8%8D%90.md",
      [],
    ),
    "CDM多样化推荐.md",
  );
});

test("keeps external links external and rejects unsafe workspace paths", () => {
  assert.equal(
    resolveWorkspaceLink("https://arxiv.org/abs/2406.09021", []),
    null,
  );
  assert.equal(
    resolveWorkspaceLink(
      "/root/CloudInk/data/workspaces/jinbao/../other/secret.md",
      [],
    ),
    null,
  );
});
