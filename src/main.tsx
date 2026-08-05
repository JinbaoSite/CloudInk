import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "./MarkdownMessage";
import "./styles.css";
import "./chat-layout.css";
import "./markdown.css";
import "./activity.css";
import "./composer.css";
type Session = { id: string; title: string; updated_at: string };
type Activity = {
  kind: "status" | "thinking" | "tool" | "tool_result";
  label: string;
  detail?: string;
  toolUseId?: string;
  isError?: boolean;
};
type Message = {
  id?: string;
  role: "user" | "assistant" | "activity";
  content: string;
};
type ExecutionMode = "auto" | "plan" | "manual" | "acceptEdits";
type Attachment = { name: string; path: string; size: number };
const executionModes: Array<{
  value: ExecutionMode;
  icon: string;
  name: string;
  description: string;
}> = [
  {
    value: "auto",
    icon: "✦",
    name: "Auto",
    description: "Claude 自动判断并执行所需工具",
  },
  {
    value: "plan",
    icon: "◇",
    name: "Plan",
    description: "只分析任务并制定实施计划",
  },
  {
    value: "manual",
    icon: "✋",
    name: "Manual",
    description: "由用户明确控制每项操作",
  },
  {
    value: "acceptEdits",
    icon: "✎",
    name: "Edit automatically",
    description: "自动接受 Claude 的文件编辑",
  },
];
const slashCommands = [
  { name: "/compact", description: "压缩当前对话上下文" },
  { name: "/context", description: "查看上下文和 Token 使用情况" },
  { name: "/doctor", description: "检查 Claude Code 配置与运行环境" },
  { name: "/review", description: "审查当前工作区的代码变更" },
  { name: "/security-review", description: "检查代码中的安全风险" },
];
const slashSkills = [
  { name: "/debug", description: "分析问题根因并修复代码" },
  { name: "/code-review", description: "对代码进行系统性质量审查" },
  { name: "/simplify", description: "简化结构并提升代码可读性" },
  { name: "/verify", description: "验证实现和完整业务流程" },
  { name: "/deep-research", description: "执行多步骤深度研究" },
];
function localId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
async function api(url: string, options?: RequestInit) {
  const r = await fetch("/api" + url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!r.ok)
    throw new Error((await r.json().catch(() => ({}))).error || "请求失败");
  return r.status === 204 ? null : r.json();
}
function Login({ onDone }: { onDone: () => void }) {
  const [register, setRegister] = useState(false),
    [username, setUsername] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api("/auth/" + (register ? "register" : "login"), {
        method: "POST",
        body: JSON.stringify({ username, email, password }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="login">
      <form onSubmit={submit}>
        <div className="brand">✦ Claude Code UI</div>
        <h1>{register ? "创建账号" : "欢迎回来"}</h1>
        <p>在浏览器中继续你的 Claude Code 工作</p>
        {register && (
          <label>
            用户名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              pattern="[a-z0-9][a-z0-9_-]*"
              minLength={2}
              maxLength={32}
              placeholder="例如 jinbao"
              required
            />
          </label>
        )}
        <label>
          邮箱
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button>{register ? "注册并登录" : "登录"}</button>
        <button
          type="button"
          className="link"
          onClick={() => setRegister(!register)}
        >
          {register ? "已有账号？登录" : "没有账号？注册"}
        </button>
      </form>
    </main>
  );
}
function App() {
  const [me, setMe] = useState<
      { email: string; username: string } | null | undefined
    >(),
    [sessions, setSessions] = useState<Session[]>([]),
    [active, setActive] = useState(""),
    [messages, setMessages] = useState<Message[]>([]),
    [input, setInput] = useState(""),
    [mode, setMode] = useState<ExecutionMode>("auto"),
    [currentModel, setCurrentModel] = useState("CLI default"),
    [attachments, setAttachments] = useState<Attachment[]>([]),
    [showSlashMenu, setShowSlashMenu] = useState(false),
    [showModeMenu, setShowModeMenu] = useState(false),
    [mobileSessionsOpen, setMobileSessionsOpen] = useState(false),
    [uploading, setUploading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const skipMessageLoadForRef = useRef("");
  const responseAbortRef = useRef<AbortController | null>(null);
  const slashMatch = input.match(/(?:^|\s)(\/[^\s]*)$/);
  const slashQuery = slashMatch?.[1].toLowerCase() || "";
  const filteredCommands = slashCommands.filter((command) =>
    command.name.startsWith(slashQuery),
  );
  const filteredSkills = slashSkills.filter((skill) =>
    skill.name.startsWith(slashQuery),
  );
  const activeMode =
    executionModes.find((option) => option.value === mode) || executionModes[0];
  const load = () => api("/sessions").then(setSessions);
  useEffect(() => {
    api("/me")
      .then((user) => {
        setMe(user);
        void load();
        void api("/config")
          .then((config) => setCurrentModel(config.model))
          .catch(() => undefined);
      })
      .catch(() => setMe(null));
  }, []);
  useEffect(() => {
    if (!active) return;
    if (skipMessageLoadForRef.current === active) {
      skipMessageLoadForRef.current = "";
      return;
    }
    let cancelled = false;
    api(`/sessions/${active}/messages`).then((items: Message[]) => {
      if (!cancelled) setMessages(items);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  useLayoutEffect(() => {
    if (!autoScrollRef.current) return;
    const frame = requestAnimationFrame(() => {
      const container = messagesRef.current;
      if (!container) return;
      container.scrollTo({
        top: container.scrollHeight,
        behavior: busy ? "auto" : "smooth",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, busy]);
  function create() {
    if (busy) return;
    autoScrollRef.current = true;
    setActive("");
    setMessages([]);
    setInput("");
    setAttachments([]);
    setError("");
    setShowSlashMenu(false);
    setShowModeMenu(false);
    setMobileSessionsOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }
  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      Array.from(files)
        .slice(0, 10 - attachments.length)
        .forEach((file) => form.append("files", file));
      const response = await fetch("/api/files", {
        method: "POST",
        body: form,
      });
      if (!response.ok)
        throw new Error(
          (await response.json().catch(() => ({}))).error || "上传失败",
        );
      const result = (await response.json()) as { files: Attachment[] };
      setAttachments((current) => [...current, ...result.files].slice(0, 10));
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }
  function insertSlashCommand(command = "/") {
    setInput((current) => {
      if (!current.trim()) return command === "/" ? "/" : `${command} `;
      if (/(^|\s)\/[^\s]*$/.test(current))
        return current.replace(/(^|\s)\/[^\s]*$/, `$1${command} `);
      return `${current}${current.endsWith(" ") ? "" : " "}${command} `;
    });
    setShowSlashMenu(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if ((!input.trim() && !attachments.length) || busy || uploading) return;
    let id = active;
    if (!id) {
      const s = await api("/sessions", { method: "POST" });
      id = s.id;
      skipMessageLoadForRef.current = id;
      setActive(id);
    }
    const text = input;
    const sentAttachments = attachments;
    const userMessageId = localId("user");
    const assistantMessageId = localId("assistant");
    const requestController = new AbortController();
    responseAbortRef.current = requestController;
    autoScrollRef.current = true;
    setInput("");
    setBusy(true);
    setError("");
    setMessages((v) => [
      ...v,
      {
        id: userMessageId,
        role: "user",
        content: [
          text,
          ...sentAttachments.map((attachment) => `📎 ${attachment.name}`),
        ]
          .filter(Boolean)
          .join("\n"),
      },
      { id: assistantMessageId, role: "assistant", content: "" },
    ]);
    try {
      const r = await fetch(`/api/sessions/${id}/messages`, {
        method: "POST",
        signal: requestController.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          mode,
          attachments: sentAttachments,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      setAttachments([]);
      const reader = r.body!.getReader(),
        decoder = new TextDecoder();
      let buf = "";
      const handleEvent = (evt: {
        type: string;
        text?: string;
        activity?: Activity;
        error?: string;
        model?: string;
      }) => {
        if (evt.type === "model" && evt.model) setCurrentModel(evt.model);
        if (evt.type === "delta" && evt.text)
          setMessages((items) =>
            items.map((message) =>
              message.id === assistantMessageId
                ? { ...message, content: message.content + evt.text }
                : message,
            ),
          );
        if (evt.type === "activity" && evt.activity)
          setMessages((items) => {
            const assistantIndex = items.findIndex(
              (message) => message.id === assistantMessageId,
            );
            if (assistantIndex < 0) return items;
            return [
              ...items.slice(0, assistantIndex),
              {
                id: localId("activity"),
                role: "activity",
                content: JSON.stringify(evt.activity),
              },
              ...items.slice(assistantIndex),
            ];
          });
        if (evt.type === "error")
          throw new Error(evt.error || "Claude 请求失败");
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines)
          if (line.trim()) handleEvent(JSON.parse(line));
      }
      buf += decoder.decode();
      if (buf.trim()) handleEvent(JSON.parse(buf));
    } catch (e) {
      if (
        requestController.signal.aborted ||
        (e as Error).name === "AbortError"
      ) {
        setMessages((items) =>
          items.filter(
            (message) =>
              message.id !== assistantMessageId || Boolean(message.content),
          ),
        );
      } else {
        setError((e as Error).message);
      }
    } finally {
      if (responseAbortRef.current === requestController)
        responseAbortRef.current = null;
      await load().catch(() => undefined);
      setBusy(false);
    }
  }
  if (me === undefined) return <div className="center">加载中…</div>;
  if (!me) return <Login onDone={() => location.reload()} />;
  return (
    <div className="shell">
      {mobileSessionsOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="关闭历史会话"
          onClick={() => setMobileSessionsOpen(false)}
        />
      )}
      <aside className={mobileSessionsOpen ? "mobile-open" : ""}>
        <div className="sidebar-heading">
          <div className="brand">✦ Claude Code</div>
          <button
            type="button"
            className="sidebar-close"
            aria-label="关闭历史会话"
            onClick={() => setMobileSessionsOpen(false)}
          >
            ×
          </button>
        </div>
        <button className="new" onClick={create}>
          <span className="new-icon" aria-hidden="true">
            +
          </span>
          <span>新对话</span>
        </button>
        <nav>
          {sessions.map((s) => (
            <div
              className={"session " + (s.id === active ? "active" : "")}
              key={s.id}
              onClick={() => {
                autoScrollRef.current = true;
                setActive(s.id);
                setMobileSessionsOpen(false);
              }}
            >
              <span>{s.title}</span>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  await api("/sessions/" + s.id, { method: "DELETE" });
                  if (active === s.id) {
                    setActive("");
                    setMessages([]);
                  }
                  load();
                }}
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        <footer>
          <span title={me.email}>@{me.username}</span>
          <button
            onClick={async () => {
              await api("/auth/logout", { method: "POST" });
              location.reload();
            }}
          >
            退出
          </button>
        </footer>
      </aside>
      <section className="chat">
        <header>
          <button
            type="button"
            className="mobile-header-button menu-button"
            aria-label="打开历史会话"
            aria-expanded={mobileSessionsOpen}
            onClick={() => setMobileSessionsOpen(true)}
          >
            ☰
          </button>
          <div className="chat-heading">
            {sessions.find((s) => s.id === active)?.title || "新对话"}
            <small>工作区与会话均按用户隔离</small>
          </div>
          <button
            type="button"
            className="mobile-header-button create-button"
            aria-label="新建会话"
            onClick={create}
          >
            +
          </button>
        </header>
        <div
          className="messages"
          ref={messagesRef}
          onScroll={(event) => {
            const container = event.currentTarget;
            const distanceFromBottom =
              container.scrollHeight -
              container.scrollTop -
              container.clientHeight;
            autoScrollRef.current = distanceFromBottom < 96;
          }}
        >
          {messages.length === 0 && (
            <div className="empty">
              <b>今天想构建什么？</b>
              <span>
                像 Claude Code CLI
                一样描述任务，它可以读取、编辑并运行你独立工作区中的代码。
              </span>
            </div>
          )}
          {messages.map((m, i) => {
            if (m.role === "activity") {
              let activity: Activity;
              try {
                activity = JSON.parse(m.content);
              } catch {
                activity = { kind: "status", label: m.content };
              }
              return <ActivityCard activity={activity} key={m.id || i} />;
            }
            return (
              <article className={m.role} key={m.id || i}>
                <div className="bubble">
                  {m.role === "assistant" ? (
                    <ReactMarkdown
                      streaming={busy && i === messages.length - 1}
                    >
                      {m.content || "▍"}
                    </ReactMarkdown>
                  ) : (
                    m.content
                  )}
                </div>
              </article>
            );
          })}
          {error && <div className="error">{error}</div>}
        </div>
        <form className="composer" onSubmit={send}>
          {showModeMenu && (
            <div className="mode-menu">
              <div className="mode-menu-heading">
                <span>执行模式</span>
                <small>控制 Claude 如何处理工具和文件修改</small>
              </div>
              {executionModes.map((option) => (
                <button
                  type="button"
                  className={option.value === mode ? "active" : ""}
                  key={option.value}
                  onClick={() => {
                    setMode(option.value);
                    setShowModeMenu(false);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                >
                  <span className="mode-icon">{option.icon}</span>
                  <span className="mode-copy">
                    <b>{option.name}</b>
                    <small>{option.description}</small>
                  </span>
                  {option.value === mode && (
                    <span className="mode-check">✓</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {showSlashMenu && (
            <div className="slash-menu">
              {filteredCommands.length > 0 && (
                <div className="slash-menu-heading">
                  <span>Commands</span>
                  <small>控制 Claude Code 会话和上下文</small>
                </div>
              )}
              {filteredCommands.map((command) => (
                <button
                  type="button"
                  key={command.name}
                  onClick={() => insertSlashCommand(command.name)}
                >
                  <code>{command.name}</code>
                  <span>{command.description}</span>
                </button>
              ))}
              {filteredSkills.length > 0 && (
                <div className="slash-menu-heading">
                  <span>Skills</span>
                  <small>调用 Claude 的专业工作流</small>
                </div>
              )}
              {filteredSkills.map((skill) => (
                <button
                  type="button"
                  key={skill.name}
                  onClick={() => insertSlashCommand(skill.name)}
                >
                  <code>{skill.name}</code>
                  <span>{skill.description}</span>
                </button>
              ))}
              {!filteredCommands.length && !filteredSkills.length && (
                <div className="slash-empty">没有匹配项</div>
              )}
              <button
                type="button"
                className="slash-custom"
                onClick={() => insertSlashCommand()}
              >
                输入其他命令…
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              const value = e.target.value;
              setInput(value);
              setShowSlashMenu(/(?:^|\s)\/[^\s]*$/.test(value));
              if (/(?:^|\s)\/[^\s]*$/.test(value)) setShowModeMenu(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && showSlashMenu) {
                e.preventDefault();
                setShowSlashMenu(false);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="给 Claude 发消息…"
          />
          {attachments.length > 0 && (
            <div className="attachment-list">
              {attachments.map((attachment) => (
                <span className="attachment-chip" key={attachment.path}>
                  <span>📎 {attachment.name}</span>
                  <button
                    type="button"
                    aria-label={`移除 ${attachment.name}`}
                    onClick={() =>
                      setAttachments((items) =>
                        items.filter((item) => item.path !== attachment.path),
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="composer-actions">
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              multiple
              onChange={(event) => void uploadFiles(event.target.files)}
            />
            <div className="composer-actions-left">
              <button
                type="button"
                className="add-button"
                aria-label="添加附件"
                title="添加附件"
                disabled={busy || uploading || attachments.length >= 10}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? "…" : "+"}
              </button>
              <button
                type="button"
                className="slash-button"
                aria-label="Commands 和 Skills"
                title="Commands 和 Skills"
                disabled={busy}
                onClick={() => {
                  if (showSlashMenu) {
                    setShowSlashMenu(false);
                    return;
                  }
                  if (!/(?:^|\s)\/[^\s]*$/.test(input))
                    setInput(
                      (current) =>
                        `${current}${current && !current.endsWith(" ") ? " " : ""}/`,
                    );
                  setShowSlashMenu(true);
                  setShowModeMenu(false);
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
              >
                /
              </button>
            </div>
            <div className="composer-actions-right">
              <span
                className="model-indicator"
                title={`当前模型：${currentModel}`}
              >
                {currentModel}
              </span>
              <button
                type="button"
                className="mode-picker"
                disabled={busy}
                aria-label="Claude 执行模式"
                aria-expanded={showModeMenu}
                onClick={() => {
                  setShowModeMenu((visible) => !visible);
                  setShowSlashMenu(false);
                }}
              >
                <span>{activeMode.icon}</span>
                <span>{activeMode.name}</span>
              </button>
              <button
                type={busy ? "button" : "submit"}
                className={`send-button ${busy ? "stop-button" : ""}`}
                disabled={
                  uploading || (!busy && !input.trim() && !attachments.length)
                }
                aria-label={busy ? "中止回答" : "发送消息"}
                title={busy ? "中止回答" : "发送消息"}
                onClick={
                  busy ? () => responseAbortRef.current?.abort() : undefined
                }
              >
                {busy ? <span className="stop-icon" /> : "↑"}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

function ActivityCard({ activity }: { activity: Activity }) {
  const icon =
    activity.kind === "thinking"
      ? "✦"
      : activity.kind === "status"
        ? "◌"
        : activity.isError
          ? "×"
          : activity.kind === "tool_result"
            ? "✓"
            : "⌘";
  return (
    <details
      className={`activity-card ${activity.kind} ${activity.isError ? "failed" : ""}`}
    >
      <summary>
        <span className="activity-icon">{icon}</span>
        <span>{activity.label}</span>
        {activity.detail && <small aria-label="展开详情">&gt;</small>}
      </summary>
      {activity.detail && <ActivityDetail activity={activity} />}
    </details>
  );
}

function ActivityDetail({ activity }: { activity: Activity }) {
  if (activity.kind === "tool") {
    try {
      const input = JSON.parse(activity.detail || "{}") as Record<
        string,
        unknown
      >;
      const primary = input.command || input.file_path || input.path;
      return (
        <div className="activity-detail">
          {primary != null && <code>{String(primary)}</code>}
          {input.description != null && <p>{String(input.description)}</p>}
          <pre>{JSON.stringify(input, null, 2)}</pre>
        </div>
      );
    } catch {
      // Fall through to the plain output renderer.
    }
  }
  return <pre>{activity.detail}</pre>;
}
createRoot(document.getElementById("root")!).render(<App />);
