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
import {
  cookieOptions,
  requireAuth,
  tokenFor,
  type AuthedRequest,
} from "./auth.js";
import { activitiesFromEvent, runClaude, textFromEvent } from "./claude.js";
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
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
app.post("/api/files", requireAuth, (req, res) => {
  upload.array("files", 10)(req, res, (error) => {
    if (error) {
      const message =
        error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
          ? "单个文件不能超过 20MB"
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

    const uploadDir = path.join(workspaceRoot, user.username, "uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    const saved = files.map((file) => {
      const original = path.basename(file.originalname).slice(0, 180);
      const extension = path.extname(original).replace(/[^.a-zA-Z0-9]/g, "");
      const stem =
        path
          .basename(original, path.extname(original))
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .slice(0, 80) || "file";
      const filename = `${crypto.randomUUID()}-${stem}${extension}`;
      fs.writeFileSync(path.join(uploadDir, filename), file.buffer, {
        flag: "wx",
      });
      return {
        name: original,
        path: `uploads/${filename}`,
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
  const prompt = body.data.attachments.length
    ? `${body.data.content.trim()}\n\n附件位于当前工作区，请按需使用 Read 或 Bash 读取：\n${body.data.attachments.map((attachment) => `- ${attachment.path}`).join("\n")}`
    : body.data.content.trim();
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
  req.on("close", () => abort.abort());
  const cwd = workspace;
  fs.mkdirSync(cwd, { recursive: true });
  const child = runClaude({
    prompt,
    cwd,
    sessionId: s.claude_session_id,
    resume: count > 0,
    permissionMode: body.data.mode,
    signal: abort.signal,
  });
  let answer = "",
    stderr = "";
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const text = textFromEvent(event);
        if (text) {
          answer += text;
          res.write(JSON.stringify({ type: "delta", text }) + "\n");
        }
        for (const activity of activitiesFromEvent(event)) {
          const t = new Date().toISOString();
          db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
            crypto.randomUUID(),
            s.id,
            "activity",
            JSON.stringify(activity),
            t,
          );
          res.write(JSON.stringify({ type: "activity", activity }) + "\n");
        }
        if (event.type === "result" && !answer && event.result) {
          answer = String(event.result);
          res.write(JSON.stringify({ type: "delta", text: answer }) + "\n");
        }
      } catch {}
    }
  });
  child.stderr.on("data", (c) => (stderr += c));
  child.on("close", (code) => {
    if (answer) {
      const t = new Date().toISOString();
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
        crypto.randomUUID(),
        s.id,
        "assistant",
        answer,
        t,
      );
      db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(t, s.id);
    }
    res.write(
      JSON.stringify(
        code === 0
          ? { type: "done" }
          : { type: "error", error: stderr || `Claude 退出码 ${code}` },
      ) + "\n",
    );
    res.end();
  });
});
if (process.env.NODE_ENV === "production") {
  app.use(express.static("dist"));
  app.get(/.*/, (_req, res) => res.sendFile(path.resolve("dist/index.html")));
}
app.listen(Number(process.env.PORT || 3001), () =>
  console.log(`Claude Code UI: http://localhost:${process.env.PORT || 3001}`),
);
