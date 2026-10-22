import test from "node:test";
import assert from "node:assert/strict";
import {
  notebookText,
  parseNotebook,
  updateNotebookCell,
} from "../src/workspace-notebook.js";

test("Notebook edits preserve metadata, outputs and untouched cells", () => {
  const original = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3" } },
    cells: [
      {
        id: "first",
        cell_type: "code",
        metadata: { tags: ["keep"] },
        source: ["print(1)\n"],
        execution_count: 1,
        outputs: [{ output_type: "stream", text: ["1\n"] }],
      },
      { cell_type: "markdown", source: "# Title", metadata: {} },
    ],
  };
  const notebook = parseNotebook(JSON.stringify(original));
  const updated = parseNotebook(
    updateNotebookCell(notebook, 0, "print(2)\nprint(3)\n"),
  );
  assert.equal(notebookText(updated.cells[0].source), "print(2)\nprint(3)\n");
  assert.deepEqual(updated.cells[0].outputs, original.cells[0].outputs);
  assert.deepEqual(updated.metadata, original.metadata);
  assert.deepEqual(updated.cells[1], original.cells[1]);
  assert.equal(updated.cells[0].id, "first");
  assert.equal(
    notebookText(
      parseNotebook(updateNotebookCell(updated, 0, "")).cells[0].source,
    ),
    "",
  );
});

test("Notebook parser rejects malformed structures without modifying content", () => {
  for (const content of [
    "{",
    "null",
    '{"nbformat":3,"cells":[]}',
    '{"nbformat":4,"cells":[null]}',
    '{"nbformat":4,"cells":[{"cell_type":"code","source":[1]}]}',
  ]) {
    assert.throws(() => parseNotebook(content));
  }
  assert.deepEqual(parseNotebook('{"nbformat":4,"cells":[]}').cells, []);
});
