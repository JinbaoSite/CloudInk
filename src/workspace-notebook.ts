export type NotebookCell = Record<string, unknown> & {
  cell_type: string;
  source: string | string[];
};
export type Notebook = Record<string, unknown> & { cells: NotebookCell[] };

export function notebookText(value: unknown): string {
  return typeof value === "string"
    ? value
    : Array.isArray(value) && value.every((part) => typeof part === "string")
      ? value.join("")
      : "";
}

export function parseNotebook(content: string): Notebook {
  const value = JSON.parse(content);
  if (
    !value ||
    value.nbformat !== 4 ||
    !Array.isArray(value.cells) ||
    !value.cells.every((cell: unknown) => {
      if (!cell || typeof cell !== "object") return false;
      const item = cell as Record<string, unknown>;
      return (
        typeof item.cell_type === "string" &&
        (typeof item.source === "string" ||
          (Array.isArray(item.source) &&
            item.source.every((line) => typeof line === "string")))
      );
    })
  )
    throw new Error(
      "文件格式无效或版本不受支持，目前支持 nbformat 4 Notebook。",
    );
  return value;
}

export function updateNotebookCell(
  notebook: Notebook,
  index: number,
  source: string,
) {
  return (
    JSON.stringify(
      {
        ...notebook,
        cells: notebook.cells.map((cell, i) =>
          i === index
            ? {
                ...cell,
                source: Array.isArray(cell.source)
                  ? source.match(/[^\n]*\n|[^\n]+$/g) || []
                  : source,
              }
            : cell,
        ),
      },
      null,
      2,
    ) + "\n"
  );
}
