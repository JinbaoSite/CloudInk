import fs from "node:fs";
import path from "node:path";

export const MAX_EDITABLE_FILE_SIZE = 5 * 1024 * 1024;

export function resolveWorkspaceFile(workspace: string, requestedPath: string) {
  if (!requestedPath || path.isAbsolute(requestedPath))
    throw new Error("文件路径无效");
  const normalized = requestedPath.split("/").join(path.sep);
  const resolved = path.resolve(workspace, normalized);
  const relative = path.relative(workspace, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("文件路径无效");
  return resolved;
}

export function resolveWorkspaceTarget(
  workspace: string,
  requestedPath: string,
) {
  if (!requestedPath || path.isAbsolute(requestedPath))
    throw new Error("文件路径无效");
  const target = resolveWorkspaceFile(workspace, requestedPath);
  const realWorkspace = fs.realpathSync(workspace);
  const parent = fs.realpathSync(path.dirname(target));
  const relative = path.relative(realWorkspace, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("文件路径无效");
  return target;
}

export function resolveWorkspaceDirectory(
  workspace: string,
  requestedPath = "",
) {
  const directory = requestedPath
    ? resolveWorkspaceFile(workspace, requestedPath)
    : workspace;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("目录无效");
  const realWorkspace = fs.realpathSync(workspace);
  const realDirectory = fs.realpathSync(directory);
  const relative = path.relative(realWorkspace, realDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("目录无效");
  return realDirectory;
}

export function removeWorkspaceEntry(workspace: string, requestedPath: string) {
  const target = resolveWorkspaceTarget(workspace, requestedPath);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error("不支持删除符号链接");
  const kind = stat.isDirectory() ? "folder" : stat.isFile() ? "file" : null;
  if (!kind) throw new Error("不支持删除此类型的条目");
  fs.rmSync(target, { recursive: kind === "folder", force: false });
  return { path: requestedPath, kind };
}

export function readEditableFile(workspace: string, requestedPath: string) {
  const absolutePath = resolveWorkspaceFile(workspace, requestedPath);
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("文件不可编辑");
  const realWorkspace = fs.realpathSync(workspace);
  const realFile = fs.realpathSync(absolutePath);
  const realRelative = path.relative(realWorkspace, realFile);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative))
    throw new Error("文件路径无效");
  if (stat.size > MAX_EDITABLE_FILE_SIZE)
    throw new Error("在线编辑仅支持 5MB 以内的文件");
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.includes(0)) throw new Error("二进制文件不支持在线编辑");
  return { absolutePath: realFile, stat, content: buffer.toString("utf8") };
}
