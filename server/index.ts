import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { db, workspaceRoot } from "./db.js";
import { descriptionForSlashItem, discoverSlashDescriptions } from "./slash.js";
import {
  readEditableFile,
  removeWorkspaceEntry,
  resolveWorkspaceDirectory,
  resolveWorkspaceFile,
  resolveWorkspaceTarget,
} from "./workspace.js";
import {
  cookieOptions,
  requireAuth,
  tokenFor,
  type AuthedRequest,
} from "./auth.js";
import {
  activitiesFromEvent,
  detectClaudeCapabilities,
  detectClaudeModel,
  questionsFromEvent,
  responseMetricsFromEvent,
  runClaude,
  messageBoundaryFromEvent,
  textFromEvent,
  thinkingDeltaFromEvent,
} from "./claude.js";
const app = express();
const appName = process.env.APP_NAME?.trim().slice(0, 60) || "CloudInk";
const ROOT_USERNAME = "root";
const rootPassword = process.env.ROOT_PASSWORD;
if (rootPassword) {
  const rootEmail = (process.env.ROOT_EMAIL || "root@cloudink.local")
    .trim()
    .toLowerCase();
  if (
    rootPassword.length < 8 ||
    !z.string().email().safeParse(rootEmail).success
  )
    throw new Error("ROOT_EMAIL 或 ROOT_PASSWORD 配置无效");
  const existingRoot = db
    .prepare("SELECT id FROM users WHERE username=?")
    .get(ROOT_USERNAME) as { id: string } | undefined;
  if (existingRoot)
    db.prepare("UPDATE users SET email=?,approved=1 WHERE id=?").run(
      rootEmail,
      existingRoot.id,
    );
  else {
    const passwordHash = await bcrypt.hash(rootPassword, 12);
    db.prepare(
      "INSERT INTO users(id,email,password_hash,created_at,username,approved) VALUES(?,?,?,?,?,1)",
    ).run(
      crypto.randomUUID(),
      rootEmail,
      passwordHash,
      new Date().toISOString(),
      ROOT_USERNAME,
    );
  }
  fs.mkdirSync(path.join(workspaceRoot, ROOT_USERNAME), { recursive: true });
}
const detectedModel = detectClaudeModel(process.cwd());
type ActiveClaudeRun = {
  abort: AbortController;
  userId: string;
  startedAt: string;
};
const activeClaudeRuns = new Map<string, ActiveClaudeRun>();
app.use(express.json({ limit: "6mb" }));
app.use(cookieParser());
app.get("/api/public-config", (_req, res) => res.json({ appName }));
type PublishedPageRecord = {
  file_path: string;
  kind: "file" | "folder";
  username: string;
  token: string;
};
function encodedPublicPath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
}
function publicPageUrl(page: PublishedPageRecord) {
  const publishedPath =
    page.kind === "folder" ? `${page.file_path}/` : page.file_path;
  return `/${encodeURIComponent(page.username)}/published/${encodedPublicPath(publishedPath)}?token=${page.token}`;
}
function legacyPublishedResourceUrl(page: PublishedPageRecord, resource = "") {
  if (page.kind === "file") return `/published/${page.token}/page.html`;
  const folderName = encodeURIComponent(path.posix.basename(page.file_path));
  const suffix = resource ? `/${encodedPublicPath(resource)}` : "/";
  return `/published/${page.token}/${folderName}${suffix}`;
}
function servePublishedResource(
  page: PublishedPageRecord,
  resource: string,
  res: express.Response,
) {
  try {
    const workspace = path.join(workspaceRoot, page.username);
    const publicationRoot = resolveWorkspaceFile(workspace, page.file_path);
    let absolutePath: string;
    if (page.kind === "file") {
      if (resource) throw new Error("Page not found");
      absolutePath = publicationRoot;
    } else {
      const requestedResource = resource || "index.html";
      const normalizedResource = requestedResource.endsWith("/")
        ? `${requestedResource}index.html`
        : requestedResource;
      absolutePath = resolveWorkspaceFile(publicationRoot, normalizedResource);
      const realRoot = fs.realpathSync(publicationRoot);
      const realResource = fs.realpathSync(absolutePath);
      const relative = path.relative(realRoot, realResource);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Page not found");
    }
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Page not found");
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    });
    if (/\.html?$/i.test(absolutePath)) {
      // A published document is untrusted user HTML. A sandboxed opaque origin
      // lets scripts run without inheriting the Web UI login origin.
      res.set(
        "Content-Security-Policy",
        "sandbox allow-scripts allow-forms allow-modals allow-popups",
      );
    }
    return res.sendFile(absolutePath);
  } catch {
    return res.status(404).send("Page not found");
  }
}
app.get(/^\/([a-z0-9][a-z0-9_-]*)\/published\/(.+)$/, (req, res) => {
  const username = req.params[0];
  const requestedPath = req.params[1];
  const queryToken = z
    .string()
    .regex(/^[a-f0-9]{48}$/)
    .safeParse(req.query.token);
  if (req.query.token !== undefined && !queryToken.success)
    return res.status(404).send("Page not found");
  const cookieTokens = Object.entries(req.cookies || {})
    .filter(([name, value]) =>
      Boolean(name.startsWith("cloudink_published_") && value),
    )
    .map(([, value]) => String(value));
  const tokens = queryToken.success ? [queryToken.data] : cookieTokens;
  let page: PublishedPageRecord | undefined;
  for (const token of tokens) {
    const candidate = db
      .prepare(
        "SELECT p.file_path,p.kind,p.token,u.username FROM published_pages p JOIN users u ON u.id=p.user_id WHERE p.token=? AND u.username=?",
      )
      .get(token, username) as PublishedPageRecord | undefined;
    if (!candidate) continue;
    const matches =
      candidate.kind === "file"
        ? requestedPath === candidate.file_path
        : requestedPath.startsWith(`${candidate.file_path}/`);
    if (matches) {
      page = candidate;
      break;
    }
  }
  if (!page && !requestedPath.endsWith("/")) {
    for (const token of tokens) {
      const folder = db
        .prepare(
          "SELECT p.file_path,p.kind,p.token,u.username FROM published_pages p JOIN users u ON u.id=p.user_id WHERE p.token=? AND u.username=? AND p.kind='folder' AND p.file_path=?",
        )
        .get(token, username, requestedPath) as PublishedPageRecord | undefined;
      if (!folder) continue;
      const tokenQuery = queryToken.success
        ? `?token=${encodeURIComponent(queryToken.data)}`
        : "";
      return res.redirect(
        302,
        `/${encodeURIComponent(username)}/published/${encodedPublicPath(requestedPath)}/${tokenQuery}`,
      );
    }
  }
  if (!page) return res.status(404).send("Page not found");
  if (queryToken.success)
    res.cookie(`cloudink_published_${page.token.slice(0, 12)}`, page.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 86400_000,
      path: `/${encodeURIComponent(username)}/published/`,
    });
  const resource =
    page.kind === "folder"
      ? requestedPath.slice(page.file_path.length + 1)
      : "";
  const internalUrl = legacyPublishedResourceUrl(page, resource);
  const isHtmlRequest =
    /\.html?$/i.test(requestedPath) ||
    (page.kind === "folder" && (!resource || resource.endsWith("/")));
  if (!isHtmlRequest) return res.redirect(302, internalUrl);
  res.set({
    "Content-Security-Policy":
      "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
  });
  return res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Published page</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style></head>
<body><iframe src="${internalUrl}" sandbox="allow-scripts allow-forms allow-modals allow-popups" title="Published page"></iframe></body></html>`);
});
app.get(/^\/published\/([a-f0-9]{48})(?:\/(.*))?$/, (req, res) => {
  const page = db
    .prepare(
      "SELECT p.file_path,p.kind,p.token,u.username FROM published_pages p JOIN users u ON u.id=p.user_id WHERE p.token=?",
    )
    .get(req.params[0]) as PublishedPageRecord | undefined;
  if (!page) return res.status(404).send("Page not found");
  if (page.kind === "file") {
    if (req.params[1] !== "page.html")
      return res.status(404).send("Page not found");
    return servePublishedResource(page, "", res);
  }
  const publishedPath = req.params[1] || "";
  const [folderName, ...resourceParts] = publishedPath.split("/");
  if (folderName !== path.posix.basename(page.file_path))
    return res.status(404).send("Page not found");
  return servePublishedResource(page, resourceParts.join("/"), res);
});
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;
function safeUploadFilename(originalName: string) {
  const original = path.basename(originalName).slice(0, 180);
  const extension = path.extname(original).replace(/[^.a-zA-Z0-9]/g, "");
  const stem =
    path
      .basename(original, path.extname(original))
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 80) || "file";
  return `${crypto.randomUUID()}-${stem}${extension}`;
}
const upload = multer({
  // Large uploads must be streamed to disk instead of being buffered in the
  // Node.js heap. requireAuth runs before this middleware, so userId is set.
  storage: multer.diskStorage({
    destination: (req, _file, done) => {
      const uid = (req as AuthedRequest).userId;
      const user = db
        .prepare("SELECT username FROM users WHERE id=?")
        .get(uid) as { username: string } | undefined;
      if (!user) return done(new Error("用户不存在"), "");
      const isWorkspaceUpload = typeof req.query.directory === "string";
      const workspace =
        user.username === ROOT_USERNAME && isWorkspaceUpload
          ? workspaceRoot
          : path.join(workspaceRoot, user.username);
      fs.mkdirSync(workspace, { recursive: true });
      try {
        const requestedDirectory =
          typeof req.query.directory === "string" ? req.query.directory : "";
        const uploadDir = requestedDirectory
          ? resolveWorkspaceDirectory(workspace, requestedDirectory)
          : workspace;
        done(null, uploadDir);
      } catch (error) {
        done(error as Error, "");
      }
    },
    filename: (req, file, done) => {
      if (typeof req.query.directory !== "string")
        return done(null, safeUploadFilename(file.originalname));
      const name = path.basename(file.originalname).slice(0, 180) || "file";
      const extension = path.extname(name);
      const stem = path.basename(name, extension);
      try {
        const uid = (req as AuthedRequest).userId;
        const user = db
          .prepare("SELECT username FROM users WHERE id=?")
          .get(uid) as { username: string } | undefined;
        if (!user) throw new Error("用户不存在");
        const workspace =
          user.username === ROOT_USERNAME
            ? workspaceRoot
            : path.join(workspaceRoot, user.username);
        const directory = resolveWorkspaceDirectory(
          workspace,
          req.query.directory,
        );
        let candidate = name;
        let suffix = 1;
        while (fs.existsSync(path.join(directory, candidate)))
          candidate = `${stem}-${suffix++}${extension}`;
        done(null, candidate);
      } catch (error) {
        done(error as Error, "");
      }
    },
  }),
  limits: { fileSize: MAX_UPLOAD_SIZE, files: 10 },
});
const credentials = z.object({
  email: z
    .string()
    .email()
    .transform((v) => v.toLowerCase()),
  password: z.string().min(6).max(128),
});
const loginCredentials = z
  .object({
    identifier: z.string().trim().min(2).max(254).optional(),
    // Keep accepting `email` so older clients can still sign in.
    email: z.string().trim().min(2).max(254).optional(),
    password: z.string().min(6).max(128),
  })
  .transform((value) => ({
    identifier: (value.identifier || value.email || "").toLowerCase(),
    password: value.password,
  }))
  .refine((value) => Boolean(value.identifier));
const registration = credentials.extend({
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .transform((value) => value.toLowerCase()),
});
app.post("/api/auth/register", async (req, res) => {
  const p = registration.safeParse(req.body);
  if (!p.success)
    return res.status(400).json({
      error: "请输入有效邮箱、至少 6 位密码和有效用户名",
    });
  if (p.data.username === ROOT_USERNAME)
    return res.status(403).json({ error: "该用户名为系统保留账号" });
  try {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    db.prepare(
      "INSERT INTO users(id,email,password_hash,created_at,username,approved,approval_status) VALUES(?,?,?,?,?,0,'pending')",
    ).run(
      id,
      p.data.email,
      await bcrypt.hash(p.data.password, 12),
      now,
      p.data.username,
    );
    return res.status(202).json({
      pending: true,
      message: "注册申请已提交，请等待管理员审批",
    });
  } catch {
    return res.status(409).json({ error: "邮箱或用户名已注册" });
  }
});
app.post("/api/auth/login", async (req, res) => {
  const p = loginCredentials.safeParse(req.body);
  if (!p.success)
    return res.status(400).json({ error: "用户名、邮箱或密码错误" });
  const u = db
    .prepare("SELECT * FROM users WHERE email=? OR username=?")
    .get(p.data.identifier, p.data.identifier) as any;
  if (!u || !(await bcrypt.compare(p.data.password, u.password_hash)))
    return res.status(401).json({ error: "用户名、邮箱或密码错误" });
  if (u.approval_status === "rejected")
    return res.status(403).json({ error: "注册申请未通过，请联系 Root" });
  if (!u.approved)
    return res.status(403).json({ error: "账号正在等待管理员审批" });
  res
    .cookie("session", await tokenFor(u.id), cookieOptions)
    .json({ email: u.email, username: u.username });
});
app.post("/api/auth/logout", (_req, res) =>
  res.clearCookie("session", { path: "/" }).status(204).end(),
);
app.get("/api/me", requireAuth, (req, res) => {
  const u = db
    .prepare("SELECT email,username,created_at FROM users WHERE id=?")
    .get((req as AuthedRequest).userId);
  res.json(
    u && {
      ...(u as { email: string; username: string; created_at: string }),
      isRoot: (u as { username: string }).username === ROOT_USERNAME,
    },
  );
});
const passwordChange = z.object({
  newPassword: z.string().min(8).max(128),
});
app.post("/api/me/password", requireAuth, async (req, res) => {
  const parsed = passwordChange.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "新密码至少需要 8 位" });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
    await bcrypt.hash(parsed.data.newPassword, 12),
    (req as AuthedRequest).userId,
  );
  return res.status(204).end();
});
app.get("/api/config", requireAuth, async (_req, res) =>
  res.json({
    model: await detectedModel,
    appName,
  }),
);
function rootUser(req: express.Request) {
  return db
    .prepare("SELECT username FROM users WHERE id=?")
    .get((req as AuthedRequest).userId) as { username: string } | undefined;
}
function requireRoot(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (rootUser(req)?.username !== ROOT_USERNAME)
    return res.status(403).json({ error: "仅 Root 可以执行此操作" });
  next();
}
app.get("/api/admin/registrations", requireAuth, requireRoot, (_req, res) => {
  const users = db
    .prepare(
      `SELECT id,username,email,created_at,approval_status,reviewed_at
       FROM users
       WHERE approval_status IS NOT NULL
       ORDER BY CASE approval_status WHEN 'pending' THEN 0 ELSE 1 END,
                COALESCE(reviewed_at,created_at) DESC`,
    )
    .all();
  return res.json({ users });
});
app.get("/api/admin/users", requireAuth, requireRoot, (_req, res) => {
  const users = db
    .prepare(
      `SELECT id,username,email,created_at,approved,approval_status
       FROM users ORDER BY created_at DESC`,
    )
    .all();
  return res.json({ users });
});
app.post(
  "/api/admin/registrations/:id/approve",
  requireAuth,
  requireRoot,
  (req, res) => {
    const user = db
      .prepare(
        "SELECT username FROM users WHERE id=? AND approval_status='pending'",
      )
      .get(req.params.id) as { username: string } | undefined;
    if (!user) return res.status(404).json({ error: "待审批用户不存在" });
    fs.mkdirSync(path.join(workspaceRoot, user.username), { recursive: true });
    db.prepare(
      "UPDATE users SET approved=1,approval_status='approved',reviewed_at=? WHERE id=?",
    ).run(new Date().toISOString(), req.params.id);
    return res.json({ id: req.params.id, approved: true });
  },
);
app.delete(
  "/api/admin/registrations/:id",
  requireAuth,
  requireRoot,
  (req, res) => {
    const result = db
      .prepare(
        `UPDATE users
         SET approved=0,approval_status='rejected',reviewed_at=?
         WHERE id=? AND approval_status='pending' AND username<>?`,
      )
      .run(new Date().toISOString(), req.params.id, ROOT_USERNAME);
    if (!result.changes)
      return res.status(404).json({ error: "待审批用户不存在" });
    return res.json({ id: req.params.id, approved: false });
  },
);
app.get("/api/slash-items", requireAuth, async (req, res) => {
  const uid = (req as AuthedRequest).userId;
  const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid) as
    { username: string } | undefined;
  if (!user) return res.status(401).json({ error: "用户不存在" });
  const workspace = path.join(workspaceRoot, user.username);
  fs.mkdirSync(workspace, { recursive: true });
  const capabilities = await detectClaudeCapabilities(workspace);
  const skillNames = new Set(capabilities.skills);
  const descriptions = discoverSlashDescriptions(workspace);
  const item = (name: string, kind: "command" | "skill") => ({
    name: `/${name}`,
    description: descriptionForSlashItem(descriptions, name, kind),
  });
  res.json({
    commands: capabilities.slashCommands
      .filter((name) => !skillNames.has(name) && !name.startsWith("__"))
      .map((name) => item(name, "command")),
    skills: capabilities.skills.map((name) => item(name, "skill")),
  });
});
app.get("/api/workspace/files", requireAuth, (req, res) => {
  const uid = (req as AuthedRequest).userId;
  const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid) as
    { username: string } | undefined;
  if (!user) return res.status(401).json({ error: "用户不存在" });

  const workspace =
    user.username === ROOT_USERNAME
      ? workspaceRoot
      : path.join(workspaceRoot, user.username);
  fs.mkdirSync(workspace, { recursive: true });
  const ignored = new Set([".git", "node_modules", ".claude", "dist", "build"]);
  const files: Array<{ name: string; path: string; size: number }> = [];
  const directories: string[] = [];
  const pending = [workspace];
  while (pending.length && files.length < 2000) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= 2000 || entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          directories.push(
            path.relative(workspace, absolutePath).split(path.sep).join("/"),
          );
          pending.push(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        files.push({
          name: entry.name,
          path: path
            .relative(workspace, absolutePath)
            .split(path.sep)
            .join("/"),
          size: fs.statSync(absolutePath).size,
        });
      } catch {}
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  directories.sort((a, b) => a.localeCompare(b));
  res.json({ files, directories, truncated: files.length >= 2000 });
});
function userWorkspace(req: express.Request) {
  const uid = (req as AuthedRequest).userId;
  const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid) as
    { username: string } | undefined;
  if (!user) return null;
  return user.username === ROOT_USERNAME
    ? workspaceRoot
    : path.join(workspaceRoot, user.username);
}
app.get(/^\/api\/workspace\/preview\/(.+)$/, requireAuth, (req, res) => {
  const workspace = userWorkspace(req);
  if (!workspace) return res.status(401).json({ error: "用户不存在" });
  try {
    const requestedPath = z.string().min(1).parse(req.params[0]);
    const absolutePath = resolveWorkspaceFile(workspace, requestedPath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("预览资源无效");
    const realWorkspace = fs.realpathSync(workspace);
    const realFile = fs.realpathSync(absolutePath);
    const relative = path.relative(realWorkspace, realFile);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("文件路径无效");
    res.set({
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    return res.sendFile(realFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取预览资源";
    return res.status(message.includes("no such file") ? 404 : 400).json({
      error: message,
    });
  }
});
app.get("/api/workspace/file", requireAuth, (req, res) => {
  const workspace = userWorkspace(req);
  if (!workspace) return res.status(401).json({ error: "用户不存在" });
  try {
    const requestedPath = z.string().min(1).parse(req.query.path);
    const file = readEditableFile(workspace, requestedPath);
    return res.json({
      path: requestedPath,
      name: path.basename(requestedPath),
      size: file.stat.size,
      mtime: file.stat.mtime.toISOString(),
      content: file.content,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取文件";
    return res
      .status(message.includes("no such file") ? 404 : 400)
      .json({ error: message });
  }
});
app.put("/api/workspace/file", requireAuth, (req, res) => {
  const workspace = userWorkspace(req);
  if (!workspace) return res.status(401).json({ error: "用户不存在" });
  const payload = z
    .object({
      path: z.string().min(1),
      content: z.string().max(5 * 1024 * 1024),
    })
    .safeParse(req.body);
  if (!payload.success)
    return res.status(400).json({ error: "文件内容无效或超过 5MB" });
  if (Buffer.byteLength(payload.data.content, "utf8") > 5 * 1024 * 1024)
    return res.status(400).json({ error: "文件内容无效或超过 5MB" });
  try {
    const file = readEditableFile(workspace, payload.data.path);
    fs.writeFileSync(file.absolutePath, payload.data.content, "utf8");
    const stat = fs.statSync(file.absolutePath);
    return res.json({
      path: payload.data.path,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法保存文件";
    return res
      .status(message.includes("no such file") ? 404 : 400)
      .json({ error: message });
  }
});
app.get("/api/workspace/download", requireAuth, (req, res) => {
  const workspace = userWorkspace(req);
  if (!workspace) return res.status(401).json({ error: "用户不存在" });
  try {
    const requestedPath = z.string().min(1).parse(req.query.path);
    const absolutePath = resolveWorkspaceFile(workspace, requestedPath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("文件不可下载");
    const realFile = fs.realpathSync(absolutePath);
    const relative = path.relative(fs.realpathSync(workspace), realFile);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("文件路径无效");
    return res.download(realFile, path.basename(requestedPath));
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});
app.get("/api/workspace/publications", requireAuth, (req, res) => {
  const pages = db
    .prepare(
      "SELECT p.file_path,p.kind,p.token,p.created_at,p.updated_at,u.username FROM published_pages p JOIN users u ON u.id=p.user_id WHERE p.user_id=? ORDER BY p.updated_at DESC",
    )
    .all((req as AuthedRequest).userId) as Array<{
    file_path: string;
    kind: "file" | "folder";
    token: string;
    username: string;
    created_at: string;
    updated_at: string;
  }>;
  return res.json({
    pages: pages.map((page) => ({
      ...page,
      url: publicPageUrl(page),
    })),
  });
});
app.post("/api/workspace/publish", requireAuth, (req, res) => {
  const workspace = userWorkspace(req);
  if (!workspace) return res.status(401).json({ error: "用户不存在" });
  const payload = z
    .object({
      path: z.string().min(1),
      kind: z.enum(["file", "folder"]).default("file"),
    })
    .safeParse(req.body);
  if (
    !payload.success ||
    (payload.data.kind === "file" && !/\.html?$/i.test(payload.data.path))
  )
    return res.status(400).json({ error: "只能发布 HTML 文件或网站文件夹" });
  try {
    const absolutePath = resolveWorkspaceFile(workspace, payload.data.path);
    const stat = fs.lstatSync(absolutePath);
    if (
      stat.isSymbolicLink() ||
      (payload.data.kind === "file" && !stat.isFile()) ||
      (payload.data.kind === "folder" && !stat.isDirectory())
    )
      throw new Error("发布类型与工作区条目不匹配");
    if (payload.data.kind === "folder") {
      const indexPath = path.join(absolutePath, "index.html");
      const indexStat = fs.lstatSync(indexPath);
      if (!indexStat.isFile() || indexStat.isSymbolicLink())
        throw new Error("发布文件夹必须包含 index.html");
    }
    const userId = (req as AuthedRequest).userId;
    const existing = db
      .prepare(
        "SELECT token,kind FROM published_pages WHERE user_id=? AND file_path=?",
      )
      .get(userId, payload.data.path) as
      { token: string; kind: "file" | "folder" } | undefined;
    const now = new Date().toISOString();
    const token = existing?.token || crypto.randomBytes(24).toString("hex");
    if (existing)
      db.prepare(
        "UPDATE published_pages SET kind=?,updated_at=? WHERE user_id=? AND file_path=?",
      ).run(payload.data.kind, now, userId, payload.data.path);
    else
      db.prepare(
        "INSERT INTO published_pages(id,token,user_id,file_path,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        crypto.randomUUID(),
        token,
        userId,
        payload.data.path,
        payload.data.kind,
        now,
        now,
      );
    return res.status(existing ? 200 : 201).json({
      path: payload.data.path,
      kind: payload.data.kind,
      url: publicPageUrl({
        file_path: payload.data.path,
        kind: payload.data.kind,
        username: path.basename(workspace),
        token,
      }),
    });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});
app.delete("/api/workspace/publish", requireAuth, (req, res) => {
  const requestedPath = z.string().min(1).safeParse(req.query.path);
  if (!requestedPath.success)
    return res.status(400).json({ error: "文件路径无效" });
  const result = db
    .prepare("DELETE FROM published_pages WHERE user_id=? AND file_path=?")
    .run((req as AuthedRequest).userId, requestedPath.data);
  if (!result.changes) return res.status(404).json({ error: "页面尚未发布" });
  return res.status(204).end();
});
app.post("/api/workspace/entry", requireAuth, (req, res) => {
  const workspace = userWorkspace(req);
  if (!workspace) return res.status(401).json({ error: "用户不存在" });
  const payload = z
    .object({ path: z.string().min(1), kind: z.enum(["file", "folder"]) })
    .safeParse(req.body);
  if (!payload.success) return res.status(400).json({ error: "名称无效" });
  try {
    const target = resolveWorkspaceTarget(workspace, payload.data.path);
    if (fs.existsSync(target)) throw new Error("同名文件或目录已存在");
    if (payload.data.kind === "folder") fs.mkdirSync(target);
    else fs.writeFileSync(target, "", { flag: "wx" });
    return res.status(201).json({ path: payload.data.path });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});
app.post("/api/workspace/rename", requireAuth, (req, res) => {
  const workspace = userWorkspace(req);
  if (!workspace) return res.status(401).json({ error: "用户不存在" });
  const payload = z
    .object({
      path: z.string().min(1),
      name: z.string().trim().min(1).max(180),
      kind: z.enum(["file", "folder"]),
    })
    .safeParse(req.body);
  if (
    !payload.success ||
    path.posix.basename(payload.data.name) !== payload.data.name ||
    payload.data.name === "." ||
    payload.data.name === ".."
  )
    return res.status(400).json({ error: "名称无效" });
  try {
    const source = resolveWorkspaceFile(workspace, payload.data.path);
    const sourceStat = fs.lstatSync(source);
    if (sourceStat.isSymbolicLink()) throw new Error("不支持重命名符号链接");
    if (
      (payload.data.kind === "file" && !sourceStat.isFile()) ||
      (payload.data.kind === "folder" && !sourceStat.isDirectory())
    )
      throw new Error("文件类型已变化，请刷新目录后重试");
    const destinationPath = path.posix.join(
      path.posix.dirname(payload.data.path),
      payload.data.name,
    );
    const destination = resolveWorkspaceTarget(workspace, destinationPath);
    if (fs.existsSync(destination)) throw new Error("同名文件或目录已存在");
    fs.renameSync(source, destination);
    const userId = (req as AuthedRequest).userId;
    const publications = db
      .prepare("SELECT id,file_path FROM published_pages WHERE user_id=?")
      .all(userId) as Array<{ id: string; file_path: string }>;
    const renamedPublications = publications.filter(
      (page) =>
        page.file_path === payload.data.path ||
        (payload.data.kind === "folder" &&
          page.file_path.startsWith(`${payload.data.path}/`)),
    );
    const updatePublication = db.prepare(
      "UPDATE published_pages SET file_path=?,updated_at=? WHERE id=?",
    );
    const updatePublications = db.transaction(() => {
      const now = new Date().toISOString();
      for (const page of renamedPublications) {
        const suffix = page.file_path.slice(payload.data.path.length);
        updatePublication.run(`${destinationPath}${suffix}`, now, page.id);
      }
    });
    updatePublications();
    return res.json({
      path: destinationPath,
      name: payload.data.name,
      kind: payload.data.kind,
    });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});
app.delete("/api/workspace/entry", requireAuth, (req, res) => {
  const workspace = userWorkspace(req);
  if (!workspace) return res.status(401).json({ error: "用户不存在" });
  try {
    const requestedPath = z.string().min(1).parse(req.query.path);
    const removed = removeWorkspaceEntry(workspace, requestedPath);
    const userId = (req as AuthedRequest).userId;
    const publications = db
      .prepare("SELECT id,file_path FROM published_pages WHERE user_id=?")
      .all(userId) as Array<{ id: string; file_path: string }>;
    const removePublication = db.prepare(
      "DELETE FROM published_pages WHERE id=? AND user_id=?",
    );
    const removePublications = db.transaction(() => {
      for (const page of publications)
        if (
          page.file_path === requestedPath ||
          (removed.kind === "folder" &&
            page.file_path.startsWith(`${requestedPath}/`))
        )
          removePublication.run(page.id, userId);
    });
    removePublications();
    return res.json(removed);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});
app.post("/api/workspace/paste", requireAuth, (req, res) => {
  const workspace = userWorkspace(req);
  if (!workspace) return res.status(401).json({ error: "用户不存在" });
  const payload = z
    .object({
      source: z.string().min(1),
      directory: z.string(),
      operation: z.enum(["copy", "cut"]),
    })
    .safeParse(req.body);
  if (!payload.success) return res.status(400).json({ error: "粘贴参数无效" });
  try {
    const source = resolveWorkspaceFile(workspace, payload.data.source);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("文件不可粘贴");
    const directory = resolveWorkspaceDirectory(
      workspace,
      payload.data.directory,
    );
    const originalName = path.basename(source);
    if (
      payload.data.operation === "cut" &&
      path.resolve(path.dirname(source)) === path.resolve(directory)
    )
      return res.json({
        path: payload.data.source,
        source: payload.data.source,
        operation: payload.data.operation,
      });
    const extension = path.extname(originalName);
    const stem = path.basename(originalName, extension);
    let destination = path.join(directory, originalName);
    let suffix = 1;
    while (fs.existsSync(destination))
      destination = path.join(
        directory,
        `${stem}-copy-${suffix++}${extension}`,
      );
    if (payload.data.operation === "cut") fs.renameSync(source, destination);
    else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    return res.status(201).json({
      path: path.relative(workspace, destination).split(path.sep).join("/"),
      source: payload.data.source,
      operation: payload.data.operation,
    });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});
app.post("/api/files", requireAuth, (req, res) => {
  upload.array("files", 10)(req, res, (error) => {
    if (error) {
      const message =
        error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
          ? "单个文件不能超过 500MB"
          : "文件上传失败";
      return res.status(400).json({ error: message });
    }
    const uid = (req as AuthedRequest).userId;
    const user = db
      .prepare("SELECT username FROM users WHERE id=?")
      .get(uid) as { username: string } | undefined;
    if (!user) return res.status(401).json({ error: "用户不存在" });
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0)
      return res.status(400).json({ error: "请选择文件" });

    const saved = files.map((file) => {
      const original = path.basename(file.originalname).slice(0, 180);
      const workspace =
        user.username === ROOT_USERNAME &&
        typeof req.query.directory === "string"
          ? workspaceRoot
          : path.join(workspaceRoot, user.username);
      return {
        name: original,
        path: path.relative(workspace, file.path).split(path.sep).join("/"),
        size: file.size,
      };
    });
    return res.status(201).json({ files: saved });
  });
});
app.get("/api/sessions", requireAuth, (req, res) => {
  const uid = (req as AuthedRequest).userId;
  const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid) as
    { username: string } | undefined;
  if (!user) return res.status(401).json({ error: "用户不存在" });
  const sessions =
    user.username === ROOT_USERNAME
      ? db
          .prepare(
            `SELECT s.id,s.title,s.created_at,s.updated_at,s.favorite,u.username
           FROM sessions s JOIN users u ON u.id=s.user_id
           ORDER BY u.username,s.favorite DESC,s.updated_at DESC`,
          )
          .all()
      : db
          .prepare(
            `SELECT s.id,s.title,s.created_at,s.updated_at,s.favorite,u.username
           FROM sessions s JOIN users u ON u.id=s.user_id
           WHERE s.user_id=? ORDER BY s.favorite DESC,s.updated_at DESC`,
          )
          .all(uid);
  return res.json(sessions);
});
app.post("/api/sessions", requireAuth, (req, res) => {
  const id = crypto.randomUUID(),
    claude = crypto.randomUUID(),
    now = new Date().toISOString();
  db.prepare(
    "INSERT INTO sessions(id,user_id,title,claude_session_id,created_at,updated_at,favorite) VALUES(?,?,?,?,?,?,0)",
  ).run(id, (req as AuthedRequest).userId, "新对话", claude, now, now);
  res.status(201).json({
    id,
    title: "新对话",
    created_at: now,
    updated_at: now,
    favorite: 0,
  });
});
app.post("/api/sessions/:id/favorite", requireAuth, (req, res) => {
  const payload = z.object({ favorite: z.boolean() }).safeParse(req.body);
  if (!payload.success) return res.status(400).json({ error: "收藏状态无效" });
  const favorite = payload.data.favorite ? 1 : 0;
  const result = db
    .prepare("UPDATE sessions SET favorite=? WHERE id=? AND user_id=?")
    .run(favorite, req.params.id, (req as AuthedRequest).userId);
  if (!result.changes) return res.status(404).json({ error: "会话不存在" });
  return res.json({ id: req.params.id, favorite });
});
app.get("/api/sessions/:id/messages", requireAuth, (req, res) => {
  const uid = (req as AuthedRequest).userId;
  const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid) as
    { username: string } | undefined;
  if (!user) return res.status(401).json({ error: "用户不存在" });
  const ok = db
    .prepare("SELECT 1 FROM sessions WHERE id=? AND (user_id=? OR ?=1)")
    .get(req.params.id, uid, user.username === ROOT_USERNAME ? 1 : 0);
  if (!ok) return res.status(404).json({ error: "会话不存在" });
  res.json(
    db
      .prepare(
        "SELECT id,role,content,created_at FROM messages WHERE session_id=? ORDER BY created_at",
      )
      .all(req.params.id),
  );
});
app.delete("/api/sessions/:id", requireAuth, (req, res) => {
  const sessionId = String(req.params.id);
  if (activeClaudeRuns.has(sessionId))
    return res.status(409).json({ error: "会话仍在运行，请先中止回答" });
  const r = db
    .prepare("DELETE FROM sessions WHERE id=? AND user_id=?")
    .run(req.params.id, (req as AuthedRequest).userId);
  res.status(r.changes ? 204 : 404).end();
});
app.get("/api/sessions/:id/run", requireAuth, (req, res) => {
  const uid = (req as AuthedRequest).userId;
  const sessionId = String(req.params.id);
  const session = db
    .prepare("SELECT id FROM sessions WHERE id=? AND user_id=?")
    .get(req.params.id, uid);
  if (!session) return res.status(404).json({ error: "会话不存在" });
  const run = activeClaudeRuns.get(sessionId);
  return res.json({
    running: Boolean(run && run.userId === uid),
    startedAt: run?.userId === uid ? run.startedAt : null,
  });
});
app.post("/api/sessions/:id/stop", requireAuth, (req, res) => {
  const uid = (req as AuthedRequest).userId;
  const sessionId = String(req.params.id);
  const session = db
    .prepare("SELECT id FROM sessions WHERE id=? AND user_id=?")
    .get(req.params.id, uid);
  if (!session) return res.status(404).json({ error: "会话不存在" });
  const run = activeClaudeRuns.get(sessionId);
  if (!run || run.userId !== uid) return res.status(204).end();
  run.abort.abort();
  return res.status(202).json({ stopping: true });
});
app.post("/api/sessions/:id/messages", requireAuth, async (req, res) => {
  const body = z
    .object({
      content: z.string().max(100000),
      attachments: z
        .array(
          z.object({
            name: z.string().min(1).max(180),
            path: z
              .string()
              // New chat uploads live at the workspace root. Keep accepting
              // the legacy prefix for files uploaded before this change.
              .regex(/^(?:uploads\/)?[a-f0-9-]+-[a-zA-Z0-9._-]+$/),
            size: z.number().nonnegative(),
          }),
        )
        .max(10)
        .default([]),
      mode: z.enum(["auto", "plan", "manual", "acceptEdits"]).default("auto"),
    })
    .safeParse(req.body);
  if (
    !body.success ||
    (!body.data.content.trim() && !body.data.attachments.length)
  )
    return res.status(400).json({ error: "消息或附件不能为空" });
  const uid = (req as AuthedRequest).userId;
  const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid) as
    { username: string } | undefined;
  if (!user) return res.status(401).json({ error: "用户不存在" });
  const workspace = path.join(workspaceRoot, user.username);
  for (const attachment of body.data.attachments) {
    const absolutePath = path.resolve(workspace, attachment.path);
    if (
      !absolutePath.startsWith(`${workspace}${path.sep}`) ||
      !fs.existsSync(absolutePath)
    )
      return res.status(400).json({ error: "附件不存在" });
  }
  const s = db
    .prepare("SELECT * FROM sessions WHERE id=? AND user_id=?")
    .get(req.params.id, uid) as any;
  if (!s) return res.status(404).json({ error: "会话不存在" });
  if (activeClaudeRuns.has(s.id))
    return res.status(409).json({ error: "该会话仍有任务在后台运行" });
  const count = (
    db
      .prepare("SELECT count(*) n FROM messages WHERE session_id=?")
      .get(s.id) as any
  ).n;
  const now = new Date().toISOString();
  const displayContent = [
    body.data.content.trim(),
    ...body.data.attachments.map((attachment) => `📎 ${attachment.name}`),
  ]
    .filter(Boolean)
    .join("\n");
  let promptContent = body.data.content.trim();
  let restartClaudeSession = false;
  const isContinuation =
    /^(继续|继续回答|继续说|接着|接着说|接着回答|continue)[。.!！]?$/i.test(
      promptContent,
    );
  if (isContinuation) {
    const previousAnswer = db
      .prepare(
        `SELECT content FROM messages
         WHERE session_id=? AND role='assistant' AND content<>'No response requested.'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(s.id) as { content: string } | undefined;
    const originalQuestion = db
      .prepare(
        `SELECT content FROM messages
         WHERE session_id=? AND role='user'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(s.id) as { content: string } | undefined;
    if (previousAnswer?.content) {
      restartClaudeSession = true;
      promptContent = [
        "用户要求继续一段因连接中断而未完成的回答。请直接从中断处续写，不要回复 No response requested，也不要从头重复已经完成的内容。",
        originalQuestion?.content
          ? `原始问题：\n${originalQuestion.content.slice(0, 10_000)}`
          : "",
        `已经输出的回答：\n${previousAnswer.content.slice(-50_000)}`,
        "请继续：",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  }
  const prompt = body.data.attachments.length
    ? `${promptContent}\n\n附件位于当前工作区，请按需使用 Read 或 Bash 读取：\n${body.data.attachments.map((attachment) => `- ${attachment.path}`).join("\n")}`
    : promptContent;
  let claudeSessionId = s.claude_session_id as string;
  if (restartClaudeSession) {
    claudeSessionId = crypto.randomUUID();
    db.prepare("UPDATE sessions SET claude_session_id=? WHERE id=?").run(
      claudeSessionId,
      s.id,
    );
  }
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
    crypto.randomUUID(),
    s.id,
    "user",
    displayContent,
    now,
  );
  if (count === 0)
    db.prepare("UPDATE sessions SET title=?,updated_at=? WHERE id=?").run(
      displayContent.slice(0, 36),
      now,
      s.id,
    );
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.flushHeaders();
  const abort = new AbortController();
  const activeRun = {
    abort,
    userId: uid,
    startedAt: new Date().toISOString(),
  };
  activeClaudeRuns.set(s.id, activeRun);
  const cwd = workspace;
  fs.mkdirSync(cwd, { recursive: true });
  const child = runClaude({
    prompt,
    cwd,
    sessionId: claudeSessionId,
    resume: count > 0 && !restartClaudeSession,
    permissionMode: body.data.mode,
    signal: abort.signal,
    tools: restartClaudeSession ? "" : undefined,
  });
  let answer = "",
    stderr = "";
  let committedAnswer = "";
  let messageStartAnswer = "";
  let buffer = "";
  let questionAsked = false;
  let responseMetrics: ReturnType<typeof responseMetricsFromEvent> = null;
  const toolActivities = new Map<
    string,
    {
      messageId: string;
      activity: ReturnType<typeof activitiesFromEvent>[number];
    }
  >();
  const streamingThinking = new Map<
    string,
    {
      messageId: string;
      activity: ReturnType<typeof activitiesFromEvent>[number];
    }
  >();
  const sendEvent = (event: object) => {
    if (!res.destroyed && !res.writableEnded)
      res.write(JSON.stringify(event) + "\n");
  };
  const processClaudeLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "system" && event.model)
        sendEvent({ type: "model", model: String(event.model) });
      responseMetrics = responseMetricsFromEvent(event) || responseMetrics;
      const messageBoundary = messageBoundaryFromEvent(event);
      if (messageBoundary?.type === "start")
        messageStartAnswer = committedAnswer;
      const question = questionsFromEvent(event);
      if (question) {
        questionAsked = true;
        sendEvent({ type: "question", question });
      }
      const text = textFromEvent(event);
      if (text && !questionAsked) {
        answer += text;
        sendEvent({ type: "delta", text });
      }
      const thinkingDelta = thinkingDeltaFromEvent(event);
      if (thinkingDelta?.text) {
        const key = thinkingDelta.parentToolUseId;
        const previous = streamingThinking.get(key);
        const activity = previous
          ? {
              ...previous.activity,
              detail: `${previous.activity.detail || ""}${thinkingDelta.text}`,
            }
          : {
              kind: "thinking" as const,
              label: key === "root" ? "Thinking" : "Agent Thinking",
              detail: thinkingDelta.text,
              toolUseId: `thinking-${crypto.randomUUID()}`,
            };
        if (previous) {
          previous.activity = activity;
          db.prepare("UPDATE messages SET content=? WHERE id=?").run(
            JSON.stringify(activity),
            previous.messageId,
          );
        } else {
          const messageId = crypto.randomUUID();
          db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
            messageId,
            s.id,
            "activity",
            JSON.stringify(activity),
            new Date().toISOString(),
          );
          streamingThinking.set(key, { messageId, activity });
        }
        sendEvent({ type: "activity", activity });
      }
      if (messageBoundary?.type === "stop") {
        if (messageBoundary.reason === "tool_use") {
          const narration = answer.slice(messageStartAnswer.length);
          answer = messageStartAnswer;
          sendEvent({ type: "replace_answer", text: answer });
          if (narration.trim()) {
            const activity = {
              kind: "narration" as const,
              label: "Progress",
              detail: narration,
              toolUseId: `narration-${crypto.randomUUID()}`,
            };
            db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
              crypto.randomUUID(),
              s.id,
              "activity",
              JSON.stringify(activity),
              new Date().toISOString(),
            );
            sendEvent({ type: "activity", activity });
          }
        } else if (messageBoundary.reason === "end_turn") {
          committedAnswer = answer;
        }
      }
      for (const activity of activitiesFromEvent(event, cwd)) {
        const t = new Date().toISOString();
        if (activity.kind === "thinking") {
          const key = String(event.parent_tool_use_id || "root");
          const pending = streamingThinking.get(key);
          if (pending) {
            const finalized = {
              ...pending.activity,
              label: activity.label,
              detail: activity.detail || pending.activity.detail,
            };
            db.prepare("UPDATE messages SET content=? WHERE id=?").run(
              JSON.stringify(finalized),
              pending.messageId,
            );
            sendEvent({ type: "activity", activity: finalized });
            streamingThinking.delete(key);
            continue;
          }
        }
        const previous = activity.toolUseId
          ? toolActivities.get(activity.toolUseId)
          : undefined;
        if (activity.kind === "tool_result" && previous) {
          const merged = {
            ...previous.activity,
            output: activity.detail || "",
            isError: activity.isError,
          };
          db.prepare("UPDATE messages SET content=? WHERE id=?").run(
            JSON.stringify(merged),
            previous.messageId,
          );
          previous.activity = merged;
          sendEvent({ type: "activity", activity: merged });
          continue;
        }
        const messageId = crypto.randomUUID();
        db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
          messageId,
          s.id,
          "activity",
          JSON.stringify(activity),
          t,
        );
        if (activity.kind === "tool" && activity.toolUseId)
          toolActivities.set(activity.toolUseId, { messageId, activity });
        sendEvent({ type: "activity", activity });
      }
      if (
        event.type === "result" &&
        !answer &&
        !questionAsked &&
        event.result
      ) {
        answer = String(event.result);
        sendEvent({ type: "delta", text: answer });
      }
    } catch {}
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processClaudeLine(line);
  });
  child.stdout.on("end", () => {
    processClaudeLine(buffer);
    buffer = "";
  });
  child.stderr.on("data", (c) => (stderr += c));
  child.on("close", (code) => {
    if (activeClaudeRuns.get(s.id) === activeRun) activeClaudeRuns.delete(s.id);
    if (answer) {
      const t = new Date().toISOString();
      const assistantMessageId = crypto.randomUUID();
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
        assistantMessageId,
        s.id,
        "assistant",
        answer,
        t,
      );
      if (responseMetrics) {
        db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
          crypto.randomUUID(),
          s.id,
          "metrics",
          JSON.stringify({ messageId: assistantMessageId, ...responseMetrics }),
          new Date(Date.now() + 1).toISOString(),
        );
        sendEvent({ type: "metrics", metrics: responseMetrics });
      }
      db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(t, s.id);
    }
    sendEvent(
      code === 0
        ? { type: "done" }
        : { type: "error", error: stderr || `Claude 退出码 ${code}` },
    );
    if (!res.destroyed && !res.writableEnded) res.end();
  });
});
if (process.env.NODE_ENV === "production") {
  app.use(express.static("dist"));
  app.get(/.*/, (_req, res) => res.sendFile(path.resolve("dist/index.html")));
}
app.listen(Number(process.env.PORT || 3001), () =>
  console.log(`${appName}: http://localhost:${process.env.PORT || 3001}`),
);
