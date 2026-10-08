const IMAGE_FILE_PATTERN = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

export function isWorkspaceImage(filePath: string) {
  return IMAGE_FILE_PATTERN.test(filePath.split(/[?#]/, 1)[0]);
}

export function workspacePreviewUrl(filePath: string, basePath: string) {
  const normalized = filePath.replace(/^\/+/, "");
  const encoded = normalized
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${basePath}/api/workspace/preview/${encoded}`;
}

export function resolveMarkdownImageUrl(
  source: string | undefined,
  markdownPath: string,
  basePath: string,
) {
  if (!source || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)) return source;

  const suffixIndex = source.search(/[?#]/);
  const pathname = suffixIndex < 0 ? source : source.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? "" : source.slice(suffixIndex);
  const decodedPath = pathname
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
  const directory = markdownPath.split("/").slice(0, -1);
  const parts = decodedPath.startsWith("/") ? [] : directory;
  for (const part of decodedPath.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${workspacePreviewUrl(parts.join("/"), basePath)}${suffix}`;
}
