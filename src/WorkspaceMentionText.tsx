import { Fragment, type ReactNode } from "react";

function workspacePathFromToken(token: string, workspacePaths: string[]) {
  const normalized = token.trim().replace(/^@/, "");
  return workspacePaths.includes(normalized) ? normalized : null;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function linkWorkspaceMentions(
  content: ReactNode,
  workspacePaths: string[],
  onOpenWorkspaceFile?: (path: string) => void,
): ReactNode {
  if (!onOpenWorkspaceFile || !workspacePaths.length) return content;
  if (Array.isArray(content))
    return content.map((child, index) => (
      <Fragment key={index}>
        {linkWorkspaceMentions(child, workspacePaths, onOpenWorkspaceFile)}
      </Fragment>
    ));
  if (typeof content !== "string") return content;
  const paths = [...workspacePaths].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(@?(?:${paths.map(escapeRegex).join("|")}))`,
    "g",
  );
  return content.split(pattern).map((part, index) => {
    const path = workspacePathFromToken(part, workspacePaths);
    return path ? (
      <button
        type="button"
        className="workspace-file-mention"
        title={`在 Workspace 中打开 ${path}`}
        onClick={() => onOpenWorkspaceFile(path)}
        key={`${path}-${index}`}
      >
        {part}
      </button>
    ) : (
      part
    );
  });
}

export default function WorkspaceMentionText({
  children,
  workspacePaths,
  onOpenWorkspaceFile,
}: {
  children: string;
  workspacePaths: string[];
  onOpenWorkspaceFile: (path: string) => void;
}) {
  return (
    <>{linkWorkspaceMentions(children, workspacePaths, onOpenWorkspaceFile)}</>
  );
}
