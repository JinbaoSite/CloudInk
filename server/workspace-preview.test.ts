import assert from "node:assert/strict";
import test from "node:test";
import {
  isWorkspaceImage,
  resolveMarkdownImageUrl,
} from "../src/workspace-preview.js";

test("recognizes workspace image formats", () => {
  for (const file of ["a.png", "a.JPG", "a.jpeg", "a.svg", "a.webp"])
    assert.equal(isWorkspaceImage(file), true);
  assert.equal(isWorkspaceImage("a.md"), false);
});

test("resolves local markdown images relative to the markdown file", () => {
  assert.equal(
    resolveMarkdownImageUrl(
      "../images/示例图.png",
      "docs/guide/readme.md",
      "/cloudink",
    ),
    "/cloudink/api/workspace/preview/docs/images/%E7%A4%BA%E4%BE%8B%E5%9B%BE.png",
  );
  assert.equal(
    resolveMarkdownImageUrl("/shared/logo.svg", "docs/readme.md", "/cloudink"),
    "/cloudink/api/workspace/preview/shared/logo.svg",
  );
  assert.equal(
    resolveMarkdownImageUrl(
      "https://example.com/a.png",
      "docs/readme.md",
      "/cloudink",
    ),
    "https://example.com/a.png",
  );
});
