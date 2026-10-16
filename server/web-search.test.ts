import assert from "node:assert/strict";
import test from "node:test";
import { isWebSearch, webSearchPresentation } from "../src/web-search.js";

test("shows legacy Codex search queries once without an empty IN or duplicate title", () => {
  assert.deepEqual(
    webSearchPresentation({
      label: "Web Search",
      toolName: "WebSearch",
      detail: "",
      output: "site:example.com test query",
    }),
    {
      input: "site:example.com test query",
      output: undefined,
      description: "site:example.com test query",
    },
  );
  assert.equal(
    webSearchPresentation({ label: "Web Search", detail: "", output: "完成" })
      .input,
    "",
  );
  assert.ok(isWebSearch({ label: "Web Search" }));
  assert.ok(!isWebSearch({ label: "Bash" }));
});

test("keeps real search results and formats structured queries", () => {
  const output = "Found results\nhttps://example.com";
  const display = webSearchPresentation({
    label: "WebSearch test",
    toolName: "WebSearch",
    detail: JSON.stringify({ query: "test" }),
    output,
  });
  assert.equal(display.input, "test");
  assert.equal(display.output, output);
  assert.equal(
    webSearchPresentation({
      label: "WebSearch",
      detail: JSON.stringify({ queries: ["one", "two"] }),
    }).input,
    "one\ntwo",
  );
  assert.equal(
    webSearchPresentation({ label: "WebSearch", detail: "{}" }).input,
    "",
  );
  assert.equal(
    webSearchPresentation({
      label: "Web Search test",
      detail: "test",
      output: "test",
    }).output,
    undefined,
  );
});

test("does not hide a failed legacy search result as a query", () => {
  const display = webSearchPresentation({
    label: "Web Search",
    detail: "",
    output: "Search request failed",
    isError: true,
  });
  assert.equal(display.input, "");
  assert.equal(display.output, "Search request failed");
});
