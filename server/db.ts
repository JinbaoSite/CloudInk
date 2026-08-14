import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.DATA_DIR || "data");
fs.mkdirSync(root, { recursive: true });
export const db = new Database(path.join(root, "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,username TEXT UNIQUE NOT NULL,approved INTEGER NOT NULL DEFAULT 1,approval_status TEXT,reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,claude_session_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS scheduled_tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,prompt TEXT NOT NULL,cron_expression TEXT NOT NULL,timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',model TEXT,permission_mode TEXT NOT NULL DEFAULT 'auto',overlap_policy TEXT NOT NULL DEFAULT 'skip',enabled INTEGER NOT NULL DEFAULT 1,next_run_at TEXT,last_run_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS scheduled_task_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,session_id TEXT,scheduled_for TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT,finished_at TEXT,duration_ms INTEGER,input_tokens INTEGER,output_tokens INTEGER,error TEXT,created_at TEXT NOT NULL,FOREIGN KEY(task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE,FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL,UNIQUE(task_id,scheduled_for));
CREATE TABLE IF NOT EXISTS published_pages(id TEXT PRIMARY KEY,token TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL,file_path TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'file',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,UNIQUE(user_id,file_path));
CREATE INDEX IF NOT EXISTS sessions_user_updated ON sessions(user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_session_created ON messages(session_id,created_at);
CREATE INDEX IF NOT EXISTS scheduled_tasks_due ON scheduled_tasks(enabled,next_run_at);
CREATE INDEX IF NOT EXISTS scheduled_task_runs_task_created ON scheduled_task_runs(task_id,created_at DESC);
CREATE INDEX IF NOT EXISTS scheduled_task_runs_status ON scheduled_task_runs(status,created_at);
CREATE INDEX IF NOT EXISTS published_pages_user_path ON published_pages(user_id,file_path);
`);

const publishedPageColumns = db
  .prepare("PRAGMA table_info(published_pages)")
  .all() as Array<{ name: string }>;
if (!publishedPageColumns.some((column) => column.name === "kind")) {
  db.exec(
    "ALTER TABLE published_pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'file'",
  );
}

const sessionColumns = db
  .prepare("PRAGMA table_info(sessions)")
  .all() as Array<{
  name: string;
}>;
if (!sessionColumns.some((column) => column.name === "favorite")) {
  db.exec(
    "ALTER TABLE sessions ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
  );
}
db.exec(
  "CREATE INDEX IF NOT EXISTS sessions_user_favorite_updated ON sessions(user_id,favorite DESC,updated_at DESC)",
);

const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{
  name: string;
}>;
if (!userColumns.some((column) => column.name === "username")) {
  db.exec("ALTER TABLE users ADD COLUMN username TEXT");
}
if (!userColumns.some((column) => column.name === "approved")) {
  db.exec("ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1");
}
if (!userColumns.some((column) => column.name === "approval_status")) {
  db.exec("ALTER TABLE users ADD COLUMN approval_status TEXT");
}
if (!userColumns.some((column) => column.name === "reviewed_at")) {
  db.exec("ALTER TABLE users ADD COLUMN reviewed_at TEXT");
}

const users = db
  .prepare("SELECT id,email,username,approved FROM users ORDER BY created_at")
  .all() as Array<{
  id: string;
  email: string;
  username: string | null;
  approved: number;
}>;
const usedNames = new Set(users.map((user) => user.username).filter(Boolean));
const setUsername = db.prepare("UPDATE users SET username=? WHERE id=?");
for (const user of users) {
  if (user.username) continue;
  const base =
    user.email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/^-+|-+$/g, "") || "user";
  let username = base;
  if (usedNames.has(username)) username = `${base}-${user.id.slice(0, 8)}`;
  usedNames.add(username);
  setUsername.run(username, user.id);
  user.username = username;
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username)");

export const workspaceRoot = path.resolve(
  process.env.WORKSPACE_DIR || path.join(root, "workspaces"),
);
fs.mkdirSync(workspaceRoot, { recursive: true });
for (const user of users) {
  if (!user.username || !user.approved) continue;
  const oldPath = path.join(workspaceRoot, user.id);
  const newPath = path.join(workspaceRoot, user.username);
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.renameSync(oldPath, newPath);
  } else {
    fs.mkdirSync(newPath, { recursive: true });
  }
}

export const dataRoot = root;
