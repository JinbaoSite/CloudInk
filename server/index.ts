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
const detectedModel = detectClaudeModel(process.cwd());
const slashCapabilityCache = new Map<
  string,
  {
    expiresAt: number;
    value: Awaited<ReturnType<typeof detectClaudeCapabilities>>;
  }
>();
app.use(express.json({ limit: "6mb" }));
app.use(cookieParser());
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
      const workspace = path.join(workspaceRoot, user.username);
      fs.mkdirSync(workspace, { recursive: true });
      try {
        const requestedDirectory =
          typeof req.query.directory === "string"
            ? req.query.directory
            : "uploads";
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
        const workspace = path.join(workspaceRoot, user.username);
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
  try {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    db.prepare(
      "INSERT INTO users(id,email,password_hash,created_at,username) VALUES(?,?,?,?,?)",
    ).run(
      id,
      p.data.email,
      await bcrypt.hash(p.data.password, 12),
      now,
      p.data.username,
    );
    fs.mkdirSync(path.join(workspaceRoot, p.data.username), {
      recursive: true,
    });
    res
      .cookie("session", await tokenFor(id), cookieOptions)
      .status(201)
      .json({ email: p.data.email, username: p.data.username });
  } catch {
    return res.status(409).json({ error: "邮箱或用户名已注册" });
  }
});
app.post("/api/auth/login", async (req, res) => {
  const p = credentials.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "邮箱或密码错误" });
  const u = db
    .prepare("SELECT * FROM users WHERE email=?")
    .get(p.data.email) as any;
  if (!u || !(await bcrypt.compare(p.data.password, u.password_hash)))
    return res.status(401).json({ error: "邮箱或密码错误" });
  res
    .cookie("session", await tokenFor(u.id), cookieOptions)
    .json({ email: u.email, username: u.username });
});
app.post("/api/auth/logout", (_req, res) =>
  res.clearCookie("session", { path: "/" }).status(204).end(),
);
app.get("/api/me", requireAuth, (req, res) => {
  const u = db
    .prepare("SELECT email,username FROM users WHERE id=?")
    .get((req as AuthedRequest).userId);
  res.json(u);
});
app.get("/api/config", requireAuth, async (_req, res) =>
  res.json({ model: await detectedModel }),
);
app.get("/api/slash-items", requireAuth, async (req, res) => {
  const uid = (req as AuthedRequest).userId;
  const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid) as
    { username: string } | undefined;
  if (!user) return res.status(401).json({ error: "用户不存在" });
  const workspace = path.join(workspaceRoot, user.username);
  fs.mkdirSync(workspace, { recursive: true });
  const cached = slashCapabilityCache.get(workspace);
  const capabilities =
    cached && cached.expiresAt > Date.now()
      ? cached.value
      : await detectClaudeCapabilities(workspace);
  slashCapabilityCache.set(workspace, {
    expiresAt: Date.now() + 10_000,
    value: capabilities,
  });
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

  const workspace = path.join(workspaceRoot, user.username);
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
  return path.join(workspaceRoot, user.username);
}
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
    return res.json(removeWorkspaceEntry(workspace, requestedPath));
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
      const workspace = path.join(workspaceRoot, user.username);
      return {
        name: original,
        path: path.relative(workspace, file.path).split(path.sep).join("/"),
        size: file.size,
      };
    });
    return res.status(201).json({ files: saved });
  });
});
app.get("/api/sessions", requireAuth, (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT id,title,created_at,updated_at FROM sessions WHERE user_id=? ORDER BY updated_at DESC",
      )
      .all((req as AuthedRequest).userId),
  ),
);
app.post("/api/sessions", requireAuth, (req, res) => {
  const id = crypto.randomUUID(),
    claude = crypto.randomUUID(),
    now = new Date().toISOString();
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(
    id,
    (req as AuthedRequest).userId,
    "新对话",
    claude,
    now,
    now,
  );
  res
    .status(201)
    .json({ id, title: "新对话", created_at: now, updated_at: now });
});
app.get("/api/sessions/:id/messages", requireAuth, (req, res) => {
  const uid = (req as AuthedRequest).userId;
  const ok = db
    .prepare("SELECT 1 FROM sessions WHERE id=? AND user_id=?")
    .get(req.params.id, uid);
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
  const r = db
    .prepare("DELETE FROM sessions WHERE id=? AND user_id=?")
    .run(req.params.id, (req as AuthedRequest).userId);
  res.status(r.changes ? 204 : 404).end();
});
app.post("/api/sessions/:id/messages", requireAuth, async (req, res) => {
  const body = z
    .object({
      content: z.string().max(100000),
      attachments: z
        .array(
          z.object({
            name: z.string().min(1).max(180),
            path: z.string().regex(/^uploads\/[a-f0-9-]+-[a-zA-Z0-9._-]+$/),
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
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
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
  console.log(`Claude Code UI: http://localhost:${process.env.PORT || 3001}`),
);
