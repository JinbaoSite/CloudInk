import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import {
  faBars,
  faCode,
  faFloppyDisk,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";

export type OpenWorkspaceFile = {
  name: string;
  path: string;
  size: number;
  content: string;
  savedContent: string;
  loading?: boolean;
  error?: string;
};

type WorkspaceEditorProps = {
  files: OpenWorkspaceFile[];
  activePath: string;
  savingPath: string;
  onActivate: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onClose: (path: string) => void;
  onCloseWorkspace: () => void;
  onOpenSidebar: () => void;
};

async function languageForFile(filePath: string): Promise<Extension[]> {
  const lower = filePath.toLowerCase();
  const extension = lower.split(".").pop() || "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension)) {
    const { javascript } = await import("@codemirror/lang-javascript");
    return [
      javascript({
        typescript: ["ts", "tsx"].includes(extension),
        jsx: ["jsx", "tsx"].includes(extension),
      }),
    ];
  }
  if (extension === "py") {
    const { python } = await import("@codemirror/lang-python");
    return [python()];
  }
  if (["md", "mdx", "markdown"].includes(extension)) {
    const { markdown } = await import("@codemirror/lang-markdown");
    return [markdown()];
  }
  if (["json", "jsonc"].includes(extension)) {
    const { json } = await import("@codemirror/lang-json");
    return [json()];
  }
  if (["html", "htm", "vue", "svelte"].includes(extension)) {
    const { html } = await import("@codemirror/lang-html");
    return [html()];
  }
  if (["css", "scss", "sass", "less"].includes(extension)) {
    const { css } = await import("@codemirror/lang-css");
    return [css()];
  }
  if (extension === "sql") {
    const { sql } = await import("@codemirror/lang-sql");
    return [sql()];
  }
  if (["yaml", "yml"].includes(extension)) {
    const { yaml } = await import("@codemirror/lang-yaml");
    return [yaml()];
  }
  return [];
}

export default function WorkspaceEditor({
  files,
  activePath,
  savingPath,
  onActivate,
  onChange,
  onSave,
  onClose,
  onCloseWorkspace,
  onOpenSidebar,
}: WorkspaceEditorProps) {
  const activeFile = files.find((file) => file.path === activePath) || files[0];
  const activeRef = useRef(activeFile);
  activeRef.current = activeFile;
  const [languageExtensions, setLanguageExtensions] = useState<Extension[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLanguageExtensions([]);
    void languageForFile(activeFile?.path || "").then((extensions) => {
      if (!cancelled) setLanguageExtensions(extensions);
    });
    return () => {
      cancelled = true;
    };
  }, [activeFile?.path]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s")
        return;
      const file = activeRef.current;
      if (!file || file.loading || file.error) return;
      event.preventDefault();
      onSave(file.path);
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [onSave]);

  if (!activeFile) return null;
  const dirty = activeFile.content !== activeFile.savedContent;

  return (
    <section className="workspace-editor" aria-label="工作区编辑器">
      <header className="workspace-editor-header">
        <button
          type="button"
          className="workspace-editor-menu"
          aria-label="打开侧边栏"
          onClick={onOpenSidebar}
        >
          <FontAwesomeIcon icon={faBars} />
        </button>
        <span>
          <FontAwesomeIcon icon={faCode} aria-hidden="true" /> Workspace
        </span>
        <button
          type="button"
          title="关闭工作区"
          aria-label="关闭工作区"
          onClick={onCloseWorkspace}
        >
          <FontAwesomeIcon icon={faXmark} />
        </button>
      </header>
      <div className="workspace-tabs" role="tablist" aria-label="已打开文件">
        {files.map((file) => {
          const fileDirty = file.content !== file.savedContent;
          return (
            <div
              className={`workspace-tab${file.path === activeFile.path ? " active" : ""}`}
              key={file.path}
              role="presentation"
            >
              <button
                type="button"
                role="tab"
                aria-selected={file.path === activeFile.path}
                title={file.path}
                onClick={() => onActivate(file.path)}
              >
                <span className="workspace-tab-state" aria-hidden="true">
                  {fileDirty ? "●" : ""}
                </span>
                <span>{file.name}</span>
              </button>
              <button
                type="button"
                className="workspace-tab-close"
                aria-label={`关闭 ${file.name}`}
                onClick={() => onClose(file.path)}
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="workspace-editor-body">
        {activeFile.loading ? (
          <div className="workspace-editor-message">正在打开文件…</div>
        ) : activeFile.error ? (
          <div className="workspace-editor-message error">
            {activeFile.error}
          </div>
        ) : (
          <CodeMirror
            className="workspace-code-editor"
            aria-label={`编辑 ${activeFile.path}`}
            height="100%"
            value={activeFile.content}
            extensions={languageExtensions}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              foldGutter: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              indentOnInput: true,
            }}
            onChange={(value) => onChange(activeFile.path, value)}
          />
        )}
      </div>
      <footer className="workspace-editor-status">
        <span title={activeFile.path}>{activeFile.path}</span>
        <button
          type="button"
          disabled={activeFile.loading || Boolean(activeFile.error) || !dirty}
          onClick={() => onSave(activeFile.path)}
        >
          <FontAwesomeIcon icon={faFloppyDisk} />
          {savingPath === activeFile.path
            ? "保存中…"
            : dirty
              ? "保存"
              : "已保存"}
        </button>
      </footer>
    </section>
  );
}
