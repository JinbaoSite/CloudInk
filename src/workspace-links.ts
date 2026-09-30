export function resolveWorkspaceLink(
  href: string | undefined,
  workspacePaths: string[],
) {
  if (!href || href.startsWith("#")) return null;
  // Keep web, mail, and every other URI scheme on React Markdown's normal path.
  // Workspace links emitted by the agents are plain relative or absolute paths.
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return null;

  let linkedPath: string;
  try {
    linkedPath = decodeURIComponent(href);
  } catch {
    linkedPath = href;
  }
  linkedPath = linkedPath
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");

  const withoutLocation = linkedPath.replace(/:\d+(?::\d+)?$/, "");
  for (const candidate of [linkedPath, withoutLocation]) {
    const exact = workspacePaths.find(
      (path) => path === candidate || `/${path}` === candidate,
    );
    if (exact) return exact;

    const matches = workspacePaths.filter(
      (path) =>
        candidate.endsWith(`/${path}`) || path.endsWith(`/${candidate}`),
    );
    if (matches.length === 1) return matches[0];

    // A freshly loaded conversation can render before /workspace/files has
    // returned. Recognize CloudInk's absolute root-workspace links directly so
    // the click handler is available during that window as well.
    const workspaceMatch = candidate.match(
      /(?:^|\/)data\/workspaces\/[^/]+\/(.+)$/,
    );
    const relative = workspaceMatch?.[1];
    if (
      relative &&
      !relative.startsWith(".cloudink-projects/") &&
      !relative.split("/").some((part) => part === "." || part === "..")
    )
      return relative;
  }
  return null;
}
