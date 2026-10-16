import { memo, useMemo } from "react";
import { ChevronDown, FileCode2 } from "lucide-react";
import { parseEditDiff } from "./edit-diff";
import "./edit-diff.css";

const labels = {
  modified: "已修改",
  added: "新增",
  deleted: "已删除",
  renamed: "已重命名",
};

export default memo(function EditFilesDiff({ detail }: { detail: string }) {
  const files = useMemo(() => parseEditDiff(detail), [detail]);
  if (!files.length)
    return (
      <pre className="edit-files-fallback">{detail || "没有文件变更信息"}</pre>
    );
  const additions = files.reduce(
    (sum, file) =>
      sum + file.lines.filter((line) => line.kind === "added").length,
    0,
  );
  const deletions = files.reduce(
    (sum, file) =>
      sum + file.lines.filter((line) => line.kind === "removed").length,
    0,
  );
  return (
    <div className="edit-files-view">
      <div className="edit-files-overview">
        <span>{files.length} 个文件变更</span>
        <span
          className="edit-files-stats"
          aria-label={`新增 ${additions} 行，删除 ${deletions} 行`}
        >
          <span className="edit-count-added">+{additions}</span>
          <span className="edit-count-removed">−{deletions}</span>
        </span>
      </div>
      {files.map((file, fileIndex) => {
        let hunk = 0;
        const added = file.lines.filter((line) => line.kind === "added").length;
        const removed = file.lines.filter(
          (line) => line.kind === "removed",
        ).length;
        return (
          <details className="edit-file" key={`${fileIndex}:${file.path}`} open>
            <summary className="edit-file-header">
              <ChevronDown
                className="edit-file-chevron"
                size={14}
                aria-hidden="true"
              />
              <FileCode2 size={15} aria-hidden="true" />
              <span
                className="edit-file-path"
                title={
                  file.previousPath
                    ? `${file.previousPath} → ${file.path}`
                    : file.path
                }
              >
                {file.previousPath ? (
                  <span className="edit-file-previous">
                    {file.previousPath} →{" "}
                  </span>
                ) : null}
                {file.path}
              </span>
              <span className={`edit-file-status status-${file.operation}`}>
                {labels[file.operation]}
              </span>
              {added || removed ? (
                <span className="edit-files-stats">
                  <span className="edit-count-added">+{added}</span>
                  <span className="edit-count-removed">−{removed}</span>
                </span>
              ) : null}
            </summary>
            {file.lines.length ? (
              <div
                className="edit-file-code"
                role="region"
                aria-label={`${file.path} 的变更`}
                tabIndex={0}
              >
                {file.lines.map((line, index) => {
                  if (line.kind === "hunk") {
                    hunk++;
                    return (
                      <div className="edit-hunk" key={index}>
                        <span>变更区块 {hunk}</span>
                        {line.oldLine != null && line.newLine != null ? (
                          <span className="edit-hunk-range">
                            原第 {line.oldLine} 行 → 新第 {line.newLine} 行
                          </span>
                        ) : null}
                        {line.text ? <code>{line.text}</code> : null}
                      </div>
                    );
                  }
                  return (
                    <div
                      className={`edit-code-line edit-code-${line.kind}`}
                      key={index}
                    >
                      <span className="edit-line-number" aria-hidden="true">
                        {line.oldLine ?? ""}
                      </span>
                      <span className="edit-line-number" aria-hidden="true">
                        {line.newLine ?? ""}
                      </span>
                      <span
                        className="edit-line-sign"
                        aria-label={
                          line.kind === "added"
                            ? "新增"
                            : line.kind === "removed"
                              ? "删除"
                              : undefined
                        }
                      >
                        {line.kind === "added"
                          ? "+"
                          : line.kind === "removed"
                            ? "−"
                            : ""}
                      </span>
                      <code>{line.text || " "}</code>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="edit-file-empty">
                {file.operation === "deleted"
                  ? "文件已删除"
                  : "已记录文件变更，未提供逐行差异。"}
              </p>
            )}
          </details>
        );
      })}
      <details className="edit-files-source">
        <summary>原始内容</summary>
        <pre>{detail}</pre>
      </details>
    </div>
  );
});
