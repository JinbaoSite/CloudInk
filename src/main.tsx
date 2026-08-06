import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBox,
  faComments,
  faDatabase,
  faFile,
  faFileCode,
  faFileExcel,
  faFileImage,
  faFileLines,
  faFilePdf,
  faFileVideo,
  faFileZipper,
  faFolder,
  faFolderTree,
  faGear,
  faKey,
  faListCheck,
  faPalette,
  faPenToSquare,
  faSliders,
  faTerminal,
  faWandMagicSparkles,
  faHand,
} from "@fortawesome/free-solid-svg-icons";
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
type WorkspaceFile = { name: string; path: string; size: number };
type FileTreeNode = {
  name: string;
  path: string;
  directories: FileTreeNode[];
  files: WorkspaceFile[];
};
const executionModes: Array<{
  value: ExecutionMode;
  icon: typeof faWandMagicSparkles;
  name: string;
  description: string;
}> = [
  {
    value: "auto",
    icon: faWandMagicSparkles,
    name: "Auto",
    description: "Claude 自动判断并执行所需工具",
  },
  {
    value: "plan",
    icon: faListCheck,
    name: "Plan",
    description: "只分析任务并制定实施计划",
  },
  {
    value: "manual",
    icon: faHand,
    name: "Manual",
    description: "由用户明确控制每项操作",
  },
  {
    value: "acceptEdits",
    icon: faPenToSquare,
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
  const initialSidebarWidth = () => {
    const saved = Number(localStorage.getItem("claude-ui-sidebar-width"));
    return Number.isFinite(saved) && saved >= 220 && saved <= 520 ? saved : 280;
  };
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
    [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]),
    [workspaceFilesLoaded, setWorkspaceFilesLoaded] = useState(false),
    [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false),
    [showMentionMenu, setShowMentionMenu] = useState(false),
    [showSlashMenu, setShowSlashMenu] = useState(false),
    [showModeMenu, setShowModeMenu] = useState(false),
    [sidebarView, setSidebarView] = useState<"sessions" | "files">("sessions"),
    [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth),
    [mobileSessionsOpen, setMobileSessionsOpen] = useState(false),
    [uploading, setUploading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modeButtonRef = useRef<HTMLButtonElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashButtonRef = useRef<HTMLButtonElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const skipMessageLoadForRef = useRef("");
  const responseAbortRef = useRef<AbortController | null>(null);
  const resizingSidebarRef = useRef(false);
  const slashMatch = input.match(/(?:^|\s)(\/[^\s]*)$/);
  const slashQuery = slashMatch?.[1].toLowerCase() || "";
  const mentionMatch = input.match(/(?:^|\s)@([^\s@]*)$/);
  const mentionQuery = mentionMatch?.[1].toLowerCase() || "";
  const filteredWorkspaceFiles = workspaceFiles
    .filter((file) => file.path.toLowerCase().includes(mentionQuery))
    .slice(0, 12);
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
    localStorage.setItem("claude-ui-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    if (!showModeMenu) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        modeMenuRef.current?.contains(target) ||
        modeButtonRef.current?.contains(target)
      )
        return;
      setShowModeMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowModeMenu(false);
        modeButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showModeMenu]);
  useEffect(() => {
    if (!showSlashMenu) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        slashMenuRef.current?.contains(target) ||
        slashButtonRef.current?.contains(target)
      )
        return;
      setShowSlashMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowSlashMenu(false);
        slashButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showSlashMenu]);
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
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(240, Math.max(58, textarea.scrollHeight))}px`;
    if (inputHighlightRef.current) {
      inputHighlightRef.current.scrollTop = textarea.scrollTop;
      inputHighlightRef.current.scrollLeft = textarea.scrollLeft;
    }
  }, [input]);
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
      if (workspaceFilesLoaded)
        setWorkspaceFiles((current) => [
          ...current,
          ...result.files.filter(
            (uploaded) => !current.some((file) => file.path === uploaded.path),
          ),
        ]);
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }
  function focusComposerAt(position?: number) {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      const cursor = position ?? textarea.value.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  }
  function insertSlashCommand(command = "/") {
    let cursorPosition: number | undefined;
    setInput((current) => {
      let next: string;
      if (!current.trim()) next = command === "/" ? "/" : `${command} `;
      else if (/(^|\s)\/[^\s]*$/.test(current))
        next = current.replace(/(^|\s)\/[^\s]*$/, `$1${command} `);
      else next = `${current}${current.endsWith(" ") ? "" : " "}${command} `;
      cursorPosition = next.length;
      return next;
    });
    setShowSlashMenu(false);
    focusComposerAt(cursorPosition);
  }
  async function loadWorkspaceFiles(force = false) {
    if ((!force && workspaceFilesLoaded) || workspaceFilesLoading) return;
    setWorkspaceFilesLoading(true);
    try {
      const result = (await api("/workspace/files")) as {
        files: WorkspaceFile[];
      };
      setWorkspaceFiles(result.files);
      setWorkspaceFilesLoaded(true);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setWorkspaceFilesLoading(false);
    }
  }
  function showWorkspaceFiles() {
    setSidebarView("files");
    void loadWorkspaceFiles();
  }
  function insertFileMention(file: WorkspaceFile) {
    const mention = file.path.includes(" ") ? `@"${file.path}"` : `@${file.path}`;
    let cursorPosition: number | undefined;
    setInput((current) => {
      const next = /(^|\s)@[^\s@]*$/.test(current)
        ? current.replace(/(^|\s)@[^\s@]*$/, `$1${mention} `)
        : `${current}${current && !current.endsWith(" ") ? " " : ""}${mention} `;
      cursorPosition = next.length;
      return next;
    });
    setShowMentionMenu(false);
    focusComposerAt(cursorPosition);
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
    <div
      className="shell"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
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
        <div className="sidebar-tabs" role="tablist" aria-label="侧栏内容">
          <button
            type="button"
            role="tab"
            aria-selected={sidebarView === "sessions"}
            className={sidebarView === "sessions" ? "active" : ""}
            onClick={() => setSidebarView("sessions")}
          >
            <FontAwesomeIcon icon={faComments} aria-hidden="true" /> 对话
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sidebarView === "files"}
            className={sidebarView === "files" ? "active" : ""}
            onClick={showWorkspaceFiles}
          >
            <FontAwesomeIcon icon={faFolderTree} aria-hidden="true" /> 文件
          </button>
        </div>
        {sidebarView === "sessions" ? (
          <nav aria-label="历史对话">
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
                  aria-label={`删除 ${s.title}`}
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
        ) : (
          <div className="workspace-browser" role="tabpanel">
            <div className="workspace-browser-heading">
              <span title={me.username}>~/{me.username}</span>
              <button
                type="button"
                title="刷新文件目录"
                aria-label="刷新文件目录"
                onClick={() => {
                  setWorkspaceFilesLoaded(false);
                  setWorkspaceFiles([]);
                  void loadWorkspaceFiles(true);
                }}
              >
                ↻
              </button>
            </div>
            {workspaceFilesLoading ? (
              <div className="workspace-browser-empty">正在读取文件目录…</div>
            ) : workspaceFiles.length ? (
              <WorkspaceFileTree files={workspaceFiles} />
            ) : (
              <div className="workspace-browser-empty">工作区暂无文件</div>
            )}
          </div>
        )}
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
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemin={220}
        aria-valuemax={520}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onDoubleClick={() => {
          setSidebarWidth(280);
          localStorage.setItem("claude-ui-sidebar-width", "280");
        }}
        onPointerDown={(event) => {
          resizingSidebarRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          document.body.classList.add("resizing-sidebar");
        }}
        onPointerMove={(event) => {
          if (!resizingSidebarRef.current) return;
          const maximum = Math.min(520, window.innerWidth - 420);
          setSidebarWidth(Math.max(220, Math.min(maximum, event.clientX)));
        }}
        onPointerUp={(event) => {
          if (!resizingSidebarRef.current) return;
          resizingSidebarRef.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
          document.body.classList.remove("resizing-sidebar");
        }}
        onPointerCancel={() => {
          resizingSidebarRef.current = false;
          document.body.classList.remove("resizing-sidebar");
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = event.shiftKey ? 40 : 10;
          const direction = event.key === "ArrowLeft" ? -1 : 1;
          setSidebarWidth((current) => {
            const next = Math.max(220, Math.min(520, current + direction * step));
            localStorage.setItem("claude-ui-sidebar-width", String(next));
            return next;
          });
        }}
      >
        <span />
      </div>
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
            <div className="mode-menu" ref={modeMenuRef}>
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
                  <span className="mode-icon" aria-hidden="true">
                    <FontAwesomeIcon icon={option.icon} />
                  </span>
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
            <div className="slash-menu" ref={slashMenuRef}>
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
          {showMentionMenu && (
            <div className="mention-menu">
              <div className="mention-menu-heading">
                <span>工作区文件</span>
                <small>输入文件名或路径进行搜索</small>
              </div>
              {workspaceFilesLoading ? (
                <div className="mention-empty">正在读取工作区…</div>
              ) : filteredWorkspaceFiles.length ? (
                filteredWorkspaceFiles.map((file) => (
                  <button
                    type="button"
                    key={file.path}
                    title={file.path}
                    onClick={() => insertFileMention(file)}
                  >
                    <span className="mention-file-icon" aria-hidden="true">
                      <FontAwesomeIcon icon={fileTypeIcon(file.name)} />
                    </span>
                    <span className="mention-file-copy">
                      <b>{file.name}</b>
                      <small>{file.path}</small>
                    </span>
                  </button>
                ))
              ) : (
                <div className="mention-empty">
                  {workspaceFilesLoaded ? "没有匹配的文件" : "无法读取工作区文件"}
                </div>
              )}
            </div>
          )}
          <div className="composer-input-wrap">
            <div
              className="composer-input-highlight"
              ref={inputHighlightRef}
              aria-hidden="true"
            >
              <HighlightedComposerInput value={input} />
            </div>
            <textarea
              ref={textareaRef}
              value={input}
              onScroll={(event) => {
                if (!inputHighlightRef.current) return;
                inputHighlightRef.current.scrollTop = event.currentTarget.scrollTop;
                inputHighlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }}
              onChange={(e) => {
                const value = e.target.value;
                setInput(value);
                const hasSlash = /(?:^|\s)\/[^\s]*$/.test(value);
                const hasMention = /(?:^|\s)@[^\s@]*$/.test(value);
                setShowSlashMenu(hasSlash);
                setShowMentionMenu(hasMention);
                if (hasMention) void loadWorkspaceFiles();
                if (hasSlash || hasMention) setShowModeMenu(false);
                if (hasSlash) setShowMentionMenu(false);
                if (hasMention) setShowSlashMenu(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && (showSlashMenu || showMentionMenu)) {
                  e.preventDefault();
                  setShowSlashMenu(false);
                  setShowMentionMenu(false);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="给 Claude 发消息…"
            />
          </div>
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
                ref={slashButtonRef}
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
                ref={modeButtonRef}
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
                <FontAwesomeIcon
                  className="mode-picker-icon"
                  icon={activeMode.icon}
                  aria-hidden="true"
                />
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

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function HighlightedComposerInput({ value }: { value: string }) {
  const parts: React.ReactNode[] = [];
  const tokenPattern = /(^|\s)(\/[^\s]*|@(?:"[^"]*"|[^\s@]*))/gm;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(value))) {
    const tokenStart = match.index + match[1].length;
    if (tokenStart > cursor) parts.push(value.slice(cursor, tokenStart));
    parts.push(
      <mark
        className={match[2].startsWith("@") ? "mention" : "command"}
        key={`${tokenStart}-${match[2]}`}
      >
        {match[2]}
      </mark>,
    );
    cursor = tokenStart + match[2].length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return <>{parts}{value.endsWith("\n") ? "\u200b" : null}</>;
}

function buildFileTree(files: WorkspaceFile[]): FileTreeNode {
  const root: FileTreeNode = {
    name: "",
    path: "",
    directories: [],
    files: [],
  };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.directories.find((directory) => directory.name === part);
      if (!child) {
        child = {
          name: part,
          path: node.path ? `${node.path}/${part}` : part,
          directories: [],
          files: [],
        };
        node.directories.push(child);
      }
      node = child;
    }
    node.files.push(file);
  }
  const sortNode = (node: FileTreeNode) => {
    node.directories.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    node.directories.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function WorkspaceFileTree({ files }: { files: WorkspaceFile[] }) {
  const root = buildFileTree(files);
  return (
    <div className="file-tree">
      {root.directories.map((directory) => (
        <WorkspaceDirectory key={directory.path} node={directory} />
      ))}
      {root.files.map((file) => (
        <WorkspaceFileRow key={file.path} file={file} />
      ))}
    </div>
  );
}

function WorkspaceDirectory({ node }: { node: FileTreeNode }) {
  return (
    <details className="file-directory" open>
      <summary title={node.path}>
        <span className="directory-chevron">›</span>
        <span className="directory-icon" aria-hidden="true">
          <FontAwesomeIcon icon={faFolder} />
        </span>
        <span>{node.name}</span>
      </summary>
      <div className="file-directory-children">
        {node.directories.map((directory) => (
          <WorkspaceDirectory key={directory.path} node={directory} />
        ))}
        {node.files.map((file) => (
          <WorkspaceFileRow key={file.path} file={file} />
        ))}
      </div>
    </details>
  );
}

function fileTypeIcon(filename: string) {
  const lower = filename.toLowerCase();
  const extension = lower.includes(".") ? lower.split(".").pop() || "" : "";
  if (["ts", "tsx"].includes(extension)) return faFileCode;
  if (["js", "jsx", "mjs", "cjs"].includes(extension))
    return faFileCode;
  if (extension === "py") return faFileCode;
  if (["html", "htm", "vue", "svelte"].includes(extension))
    return faFileCode;
  if (["css", "scss", "sass", "less"].includes(extension))
    return faPalette;
  if (["md", "mdx", "markdown"].includes(extension))
    return faFileLines;
  if (["json", "jsonc", "yaml", "yml", "toml", "xml"].includes(extension))
    return faSliders;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(extension))
    return faFileImage;
  if (extension === "pdf") return faFilePdf;
  if (["doc", "docx", "odt", "rtf", "txt"].includes(extension))
    return faFileLines;
  if (["csv", "xls", "xlsx", "parquet"].includes(extension))
    return faFileExcel;
  if (["zip", "tar", "gz", "tgz", "rar", "7z"].includes(extension))
    return faFileZipper;
  if (["sh", "bash", "zsh", "fish", "ps1"].includes(extension))
    return faTerminal;
  if (["sql", "db", "sqlite", "sqlite3"].includes(extension))
    return faDatabase;
  if (["mp3", "wav", "ogg", "m4a", "flac", "mp4", "mov", "webm"].includes(extension))
    return faFileVideo;
  if (lower === "dockerfile" || lower.startsWith("dockerfile."))
    return faBox;
  if (lower === "makefile" || lower === "justfile")
    return faGear;
  if (lower === ".env" || lower.startsWith(".env."))
    return faKey;
  return faFile;
}

function WorkspaceFileRow({ file }: { file: WorkspaceFile }) {
  const iconType = fileTypeIcon(file.name);
  return (
    <div className="workspace-file" title={`${file.path} · ${formatFileSize(file.size)}`}>
      <span className="workspace-file-icon" aria-hidden="true">
        <FontAwesomeIcon icon={iconType} />
      </span>
      <span>{file.name}</span>
      <small>{formatFileSize(file.size)}</small>
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
