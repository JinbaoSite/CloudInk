import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import MarkdownMessage from "./MarkdownMessage";
import {
  notebookText,
  parseNotebook,
  updateNotebookCell,
} from "./workspace-notebook";

function NotebookOutput({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const output = value as Record<string, unknown>;
  const data =
    output.data && typeof output.data === "object"
      ? (output.data as Record<string, unknown>)
      : {};
  for (const mime of ["image/png", "image/jpeg"]) {
    const encoded = notebookText(data[mime]);
    if (encoded)
      return (
        <img
          alt="Notebook 输出"
          src={`data:${mime};base64,${encoded.replace(/\s/g, "")}`}
        />
      );
  }
  const svg = notebookText(data["image/svg+xml"]);
  if (svg)
    return (
      <img
        alt="Notebook SVG 输出"
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      />
    );
  const markdown = notebookText(data["text/markdown"]);
  if (markdown)
    return (
      <div className="workspace-markdown-preview notebook-markdown">
        <MarkdownMessage>{markdown}</MarkdownMessage>
      </div>
    );
  const html = notebookText(data["text/html"]);
  if (html)
    return (
      <iframe
        title="Notebook HTML 输出"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={html}
      />
    );
  const text =
    notebookText(output.text) ||
    notebookText(data["text/plain"]) ||
    (output.output_type === "error"
      ? notebookText(
          Array.isArray(output.traceback)
            ? output.traceback.join("\n")
            : output.traceback,
        ) ||
        `${String(output.ename || "Error")}: ${String(output.evalue || "")}`
      : "");
  return text ? (
    <pre className={output.output_type === "error" ? "error" : ""}>
      {text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")}
    </pre>
  ) : (
    <p>此输出格式暂不支持预览</p>
  );
}

export default function WorkspaceNotebook({
  content,
  path,
  editing,
  onChange,
  workspacePaths,
  onOpenFile,
}: {
  content: string;
  path: string;
  editing: boolean;
  onChange: (content: string) => void;
  workspacePaths: string[];
  onOpenFile: (path: string) => void;
}) {
  const result = useMemo(() => {
    try {
      return { notebook: parseNotebook(content), error: "" };
    } catch (error) {
      return { notebook: undefined, error: (error as Error).message };
    }
  }, [content]);
  const metadata = result.notebook?.metadata as
    | { language_info?: { name?: string }; kernelspec?: { language?: string } }
    | undefined;
  const language = String(
    metadata?.language_info?.name || metadata?.kernelspec?.language || "python",
  ).toLowerCase();
  const [codeExtensions, setCodeExtensions] = useState<Extension[]>([]);
  useEffect(() => {
    let cancelled = false;
    setCodeExtensions([]);
    if (language === "python") {
      void import("@codemirror/lang-python").then(({ python }) => {
        if (!cancelled) setCodeExtensions([python()]);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [language]);
  if (!result.notebook)
    return (
      <div className="workspace-editor-message error">
        无法预览 Notebook：{result.error}
      </div>
    );
  const notebook = result.notebook;
  return (
    <article
      className={`workspace-notebook${editing ? " notebook-editing" : ""}`}
      aria-label={`Notebook ${path}`}
    >
      <p className="notebook-hint">
        {notebook.cells.length} 个单元格 · 仅展示已保存的输出，不执行代码
      </p>
      {notebook.cells.map((cell, index) => (
        <section
          className={`notebook-cell notebook-cell-${cell.cell_type === "code" ? "code" : "text"}`}
          key={index}
          aria-label={`第 ${index + 1} 个单元格`}
        >
          <div className="notebook-input-row">
            <div
              className="notebook-prompt notebook-input-prompt"
              aria-hidden="true"
            >
              {cell.cell_type === "code"
                ? `In [${typeof cell.execution_count === "number" ? cell.execution_count : " "}]:`
                : ""}
            </div>
            <div className="notebook-input">
              {cell.cell_type === "code" ? (
                <CodeMirror
                  className="notebook-code"
                  aria-label={`${editing ? "编辑" : "代码"}第 ${index + 1} 个单元格`}
                  value={notebookText(cell.source)}
                  extensions={codeExtensions}
                  editable={editing}
                  readOnly={!editing}
                  basicSetup={{
                    lineNumbers: false,
                    foldGutter: false,
                    highlightActiveLine: editing,
                    highlightActiveLineGutter: false,
                  }}
                  onChange={(value) =>
                    onChange(updateNotebookCell(notebook, index, value))
                  }
                />
              ) : editing ? (
                <textarea
                  aria-label={`编辑第 ${index + 1} 个单元格`}
                  spellCheck={false}
                  value={notebookText(cell.source)}
                  rows={Math.min(
                    24,
                    Math.max(3, notebookText(cell.source).split("\n").length),
                  )}
                  onChange={(event) =>
                    onChange(
                      updateNotebookCell(notebook, index, event.target.value),
                    )
                  }
                />
              ) : cell.cell_type === "markdown" ? (
                <div className="workspace-markdown-preview notebook-markdown">
                  <MarkdownMessage
                    markdownPath={path}
                    workspacePaths={workspacePaths}
                    onOpenWorkspaceFile={onOpenFile}
                  >
                    {notebookText(cell.source)}
                  </MarkdownMessage>
                </div>
              ) : (
                <pre className="notebook-source">
                  {notebookText(cell.source) || "（空单元格）"}
                </pre>
              )}
            </div>
          </div>
          {Array.isArray(cell.outputs) && cell.outputs.length > 0 && (
            <div
              className="notebook-outputs"
              aria-label={`第 ${index + 1} 个单元格的输出`}
            >
              {cell.outputs.map((output, i) => (
                <div className="notebook-output-row" key={i}>
                  <div
                    className="notebook-prompt notebook-output-prompt"
                    aria-hidden="true"
                  >
                    {output &&
                    typeof output === "object" &&
                    (output as Record<string, unknown>).output_type ===
                      "execute_result"
                      ? `Out [${typeof (output as Record<string, unknown>).execution_count === "number" ? (output as Record<string, unknown>).execution_count : " "}]:`
                      : ""}
                  </div>
                  <div className="notebook-output-body">
                    <NotebookOutput value={output} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
      {notebook.cells.length === 0 && <p>此 Notebook 暂无单元格</p>}
    </article>
  );
}
