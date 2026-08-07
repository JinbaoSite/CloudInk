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
import {
  activitiesFromEvent,
  completedAssistantTurn,
  detectClaudeModel,
  questionsFromEvent,
  responseMetricsFromEvent,
  runClaude,
  textFromEvent,
} from "./claude.js";
const app = express();
const detectedModel = detectClaudeModel(process.cwd());
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
app.get("/api/config", requireAuth, async (_req, res) =>
  res.json({ model: await detectedModel }),
);
app.get("/api/workspace/files", requireAuth, (req, res) => {
  const uid = (req as AuthedRequest).userId;
  const user = db
    .prepare("SELECT username FROM users WHERE id=?")
    .get(uid) as { username: string } | undefined;
  if (!user) return res.status(401).json({ error: "用户不存在" });

  const workspace = path.join(workspaceRoot, user.username);
  fs.mkdirSync(workspace, { recursive: true });
  const ignored = new Set([".git", "node_modules", ".claude", "dist", "build"]);
  const files: Array<{ name: string; path: string; size: number }> = [];
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
        if (!ignored.has(entry.name)) pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        files.push({
          name: entry.name,
          path: path.relative(workspace, absolutePath).split(path.sep).join("/"),
          size: fs.statSync(absolutePath).size,
        });
      } catch {}
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  res.json({ files, truncated: files.length >= 2000 });
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
  let buffer = "";
  let questionAsked = false;
  let responseMetrics: ReturnType<typeof responseMetricsFromEvent> = null;
  const toolActivities = new Map<
    string,
    { messageId: string; activity: ReturnType<typeof activitiesFromEvent>[number] }
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
      const completedTurn = completedAssistantTurn(event);
      if (completedTurn?.hasToolUse) {
        // Partial stream events arrive before we know whether this assistant
        // turn will call a tool. Retract that narration from the answer once
        // the completed turn confirms it was execution progress.
        answer = committedAnswer;
        sendEvent({ type: "replace_answer", text: answer });
      } else if (completedTurn) {
        committedAnswer = answer;
      }
      for (const activity of activitiesFromEvent(event, cwd)) {
        const t = new Date().toISOString();
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
      if (event.type === "result" && !answer && !questionAsked && event.result) {
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
