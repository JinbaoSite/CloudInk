import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.DATA_DIR || "data");
fs.mkdirSync(root, { recursive: true });
export const db = new Database(path.join(root, "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,username TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,claude_session_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS sessions_user_updated ON sessions(user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_session_created ON messages(session_id,created_at);
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{
  name: string;
}>;
if (!userColumns.some((column) => column.name === "username")) {
  db.exec("ALTER TABLE users ADD COLUMN username TEXT");
}

const users = db
  .prepare("SELECT id,email,username FROM users ORDER BY created_at")
  .all() as Array<{ id: string; email: string; username: string | null }>;
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
  if (!user.username) continue;
  const oldPath = path.join(workspaceRoot, user.id);
  const newPath = path.join(workspaceRoot, user.username);
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.renameSync(oldPath, newPath);
  } else {
    fs.mkdirSync(newPath, { recursive: true });
  }
}

export const dataRoot = root;
