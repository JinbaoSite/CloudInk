import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBox,
  faCheck,
  faBars,
  faComments,
  faCopy,
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
  faCloudArrowUp,
  faGear,
  faKey,
  faListCheck,
  faPalette,
  faPenToSquare,
  faRotateRight,
  faSliders,
  faTerminal,
  faTableColumns,
  faWandMagicSparkles,
  faXmark,
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
  toolName?: string;
  output?: string;
};
type Message = {
  id?: string;
  role: "user" | "assistant" | "activity" | "metrics";
  content: string;
  metrics?: ResponseMetrics;
};
type ResponseMetrics = {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};
type ExecutionMode = "auto" | "plan" | "manual" | "acceptEdits";
type Attachment = { name: string; path: string; size: number };
type WorkspaceFile = { name: string; path: string; size: number };
type QuestionOption = { label: string; description?: string };
type ClaudeQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
};
type PendingQuestion = { toolUseId: string; questions: ClaudeQuestion[] };
type FileTreeNode = {
  name: string;
  path: string;
  directories: FileTreeNode[];
  files: WorkspaceFile[];
};
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;
function sessionIdFromLocation() {
  const match = window.location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}
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
type SlashItem = { name: string; description: string };
function localId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function parseActivity(message: Message) {
  if (message.role !== "activity") return null;
  try {
    return JSON.parse(message.content) as Activity;
  } catch {
    return null;
  }
}
function mergeActivityMessages(messages: Message[]) {
  const metricsByMessage = new Map<string, ResponseMetrics>();
  for (const message of messages) {
    if (message.role !== "metrics") continue;
    try {
      const stored = JSON.parse(message.content) as ResponseMetrics & {
        messageId?: string;
      };
      if (stored.messageId) metricsByMessage.set(stored.messageId, stored);
    } catch {}
  }
  const merged: Message[] = [];
  const tools = new Map<string, number>();
  for (const message of messages) {
    if (message.role === "metrics") continue;
    const hydratedMessage =
      message.role === "assistant" &&
      message.id &&
      metricsByMessage.has(message.id)
        ? { ...message, metrics: metricsByMessage.get(message.id) }
        : message;
    const activity = parseActivity(message);
    if (!activity?.toolUseId) {
      merged.push(hydratedMessage);
      continue;
    }
    if (activity.kind === "tool") {
      const previousIndex = tools.get(activity.toolUseId);
      if (previousIndex != null) merged[previousIndex] = message;
      else {
        tools.set(activity.toolUseId, merged.length);
        merged.push(message);
      }
      continue;
    }
    if (activity.kind === "tool_result") {
      const toolIndex = tools.get(activity.toolUseId);
      if (toolIndex != null) {
        const tool = parseActivity(merged[toolIndex]);
        if (tool) {
          merged[toolIndex] = {
            ...merged[toolIndex],
            content: JSON.stringify({
              ...tool,
              output: activity.detail || "",
              isError: activity.isError,
            }),
          };
          continue;
        }
      }
    }
    merged.push(message);
  }
  return merged;
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
    [active, setActive] = useState(sessionIdFromLocation),
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
    [dynamicCommands, setDynamicCommands] =
      useState<SlashItem[]>(slashCommands),
    [dynamicSkills, setDynamicSkills] = useState<SlashItem[]>(slashSkills),
    [slashItemsLoading, setSlashItemsLoading] = useState(false),
    [showModeMenu, setShowModeMenu] = useState(false),
    [sidebarView, setSidebarView] = useState<"sessions" | "files">("sessions"),
    [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth),
    [sidebarCollapsed, setSidebarCollapsed] = useState(
      () => localStorage.getItem("claude-ui-sidebar-collapsed") === "true",
    ),
    [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(
      null,
    ),
    [questionAnswers, setQuestionAnswers] = useState<Record<number, string[]>>(
      {},
    ),
    [customQuestionAnswers, setCustomQuestionAnswers] = useState<
      Record<number, string>
    >({}),
    [copiedMessageId, setCopiedMessageId] = useState(""),
    [mobileSessionsOpen, setMobileSessionsOpen] = useState(false),
    [uploading, setUploading] = useState(false),
    [draggingFiles, setDraggingFiles] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
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
  const fileDragDepthRef = useRef(0);
  const slashMatch = input.match(/(?:^|\s)(\/[^\s]*)$/);
  const slashQuery = slashMatch?.[1].toLowerCase() || "";
  const mentionMatch = input.match(/(?:^|\s)@([^\s@]*)$/);
  const mentionQuery = mentionMatch?.[1].toLowerCase() || "";
  const filteredWorkspaceFiles = workspaceFiles
    .filter((file) => file.path.toLowerCase().includes(mentionQuery))
    .slice(0, 12);
  const filteredCommands = dynamicCommands.filter((command) =>
    command.name.startsWith(slashQuery),
  );
  const filteredSkills = dynamicSkills.filter((skill) =>
    skill.name.startsWith(slashQuery),
  );
  const activeMode =
    executionModes.find((option) => option.value === mode) || executionModes[0];
  const load = () => api("/sessions").then(setSessions);
  async function refreshSlashItems() {
    if (slashItemsLoading) return;
    setSlashItemsLoading(true);
    try {
      const result = (await api("/slash-items")) as {
        commands: SlashItem[];
        skills: SlashItem[];
      };
      setDynamicCommands(result.commands);
      setDynamicSkills(result.skills);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setSlashItemsLoading(false);
    }
  }
  function navigateToSession(id: string, replace = false) {
    const url = id ? `/sessions/${encodeURIComponent(id)}` : "/";
    window.history[replace ? "replaceState" : "pushState"](null, "", url);
    setActive(id);
  }
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
    const restoreSessionFromUrl = () => {
      autoScrollRef.current = true;
      setActive(sessionIdFromLocation());
      setMobileSessionsOpen(false);
    };
    window.addEventListener("popstate", restoreSessionFromUrl);
    return () => window.removeEventListener("popstate", restoreSessionFromUrl);
  }, []);
  useEffect(() => {
    localStorage.setItem(
      "claude-ui-sidebar-collapsed",
      String(sidebarCollapsed),
    );
  }, [sidebarCollapsed]);
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
    setPendingQuestion(null);
    setQuestionAnswers({});
    setCustomQuestionAnswers({});
    if (skipMessageLoadForRef.current === active) {
      skipMessageLoadForRef.current = "";
      return;
    }
    let cancelled = false;
    api(`/sessions/${active}/messages`)
      .then((items: Message[]) => {
        if (!cancelled) setMessages(mergeActivityMessages(items));
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError((loadError as Error).message);
        setMessages([]);
        navigateToSession("", true);
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
    navigateToSession("");
    setMessages([]);
    setInput("");
    setAttachments([]);
    setPendingQuestion(null);
    setQuestionAnswers({});
    setCustomQuestionAnswers({});
    setError("");
    setShowSlashMenu(false);
    setShowModeMenu(false);
    setMobileSessionsOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }
  async function uploadFiles(files: FileList | File[] | null) {
    if (!files?.length || uploading) return;
    const selected = Array.from(files).slice(0, 10 - attachments.length);
    if (!selected.length) {
      setError("每条消息最多添加 10 个附件");
      return;
    }
    const oversized = selected.find((file) => file.size > MAX_UPLOAD_SIZE);
    if (oversized) {
      setError(`${oversized.name} 超过 500MB，无法上传`);
      return;
    }
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      selected.forEach((file) => form.append("files", file));
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
  function containsDraggedFiles(event: React.DragEvent) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }
  function onComposerDragEnter(event: React.DragEvent<HTMLFormElement>) {
    if (!containsDraggedFiles(event) || busy || uploading) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setDraggingFiles(true);
  }
  function onComposerDragLeave(event: React.DragEvent<HTMLFormElement>) {
    if (!containsDraggedFiles(event)) return;
    event.preventDefault();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setDraggingFiles(false);
  }
  function onComposerDrop(event: React.DragEvent<HTMLFormElement>) {
    if (!containsDraggedFiles(event)) return;
    event.preventDefault();
    fileDragDepthRef.current = 0;
    setDraggingFiles(false);
    if (!busy && !uploading) void uploadFiles(event.dataTransfer.files);
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
  async function copyResponse(content: string, messageId: string) {
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(content);
      else {
        const copyTarget = document.createElement("textarea");
        copyTarget.value = content;
        copyTarget.style.position = "fixed";
        copyTarget.style.opacity = "0";
        document.body.appendChild(copyTarget);
        copyTarget.select();
        document.execCommand("copy");
        copyTarget.remove();
      }
      setCopiedMessageId(messageId);
      window.setTimeout(
        () =>
          setCopiedMessageId((current) =>
            current === messageId ? "" : current,
          ),
        1600,
      );
    } catch {
      setError("复制失败，请手动选择内容复制");
    }
  }
  function retryResponse(messageIndex: number) {
    if (busy) return;
    const userMessage = messages
      .slice(0, messageIndex)
      .reverse()
      .find((message) => message.role === "user");
    if (!userMessage?.content.trim()) return;
    setInput(userMessage.content);
    autoScrollRef.current = true;
    requestAnimationFrame(() => composerFormRef.current?.requestSubmit());
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
    const mention = file.path.includes(" ")
      ? `@"${file.path}"`
      : `@${file.path}`;
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
      navigateToSession(id);
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
        question?: PendingQuestion;
        metrics?: ResponseMetrics;
      }) => {
        if (evt.type === "model" && evt.model) setCurrentModel(evt.model);
        if (evt.type === "question" && evt.question) {
          setPendingQuestion(evt.question);
          setQuestionAnswers({});
          setCustomQuestionAnswers({});
          setShowModeMenu(false);
          setShowSlashMenu(false);
          setShowMentionMenu(false);
        }
        if (evt.type === "metrics" && evt.metrics)
          setMessages((items) =>
            items.map((message) =>
              message.id === assistantMessageId
                ? { ...message, metrics: evt.metrics }
                : message,
            ),
          );
        if (evt.type === "delta" && evt.text)
          setMessages((items) =>
            items.map((message) =>
              message.id === assistantMessageId
                ? { ...message, content: message.content + evt.text }
                : message,
            ),
          );
        if (evt.type === "replace_answer")
          setMessages((items) =>
            items.map((message) =>
              message.id === assistantMessageId
                ? { ...message, content: evt.text || "" }
                : message,
            ),
          );
        if (evt.type === "activity" && evt.activity)
          setMessages((items) => {
            if (evt.activity?.toolUseId) {
              const existingIndex = items.findIndex((message) => {
                const existing = parseActivity(message);
                return (
                  existing?.kind === "tool" &&
                  existing.toolUseId === evt.activity?.toolUseId
                );
              });
              if (existingIndex >= 0) {
                const next = [...items];
                next[existingIndex] = {
                  ...next[existingIndex],
                  content: JSON.stringify(evt.activity),
                };
                return next;
              }
            }
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
      setMessages((items) =>
        items.filter(
          (message) =>
            message.id !== assistantMessageId || Boolean(message.content),
        ),
      );
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
  const lastActivityEntry = messages.reduce<{
    index: number;
    activity: Activity | null;
  }>(
    (current, message, index) => {
      const parsed = parseActivity(message);
      return parsed ? { index, activity: parsed } : current;
    },
    { index: -1, activity: null },
  );
  const lastActivityIndex = lastActivityEntry.index;
  const lastActivity = lastActivityEntry.activity;
  const conversationPhase = busy
    ? lastActivity?.kind === "tool" && lastActivity.output == null
      ? { label: "Running", detail: activityDisplayLabel(lastActivity) }
      : { label: "Thinking", detail: "Claude is working" }
    : null;
  return (
    <div
      className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
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
            className="sidebar-collapse"
            title="收起侧边栏"
            aria-label="收起侧边栏"
            onClick={() => setSidebarCollapsed(true)}
          >
            <FontAwesomeIcon icon={faTableColumns} />
          </button>
          <button
            type="button"
            className="sidebar-close"
            aria-label="关闭历史会话"
            onClick={() => setMobileSessionsOpen(false)}
          >
            <FontAwesomeIcon icon={faXmark} />
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
              >
                <a
                  className="session-link"
                  href={`/sessions/${encodeURIComponent(s.id)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    autoScrollRef.current = true;
                    navigateToSession(s.id);
                    setMobileSessionsOpen(false);
                  }}
                >
                  {s.title}
                </a>
                <button
                  aria-label={`删除 ${s.title}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    await api("/sessions/" + s.id, { method: "DELETE" });
                    if (active === s.id) {
                      navigateToSession("", true);
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
              window.history.replaceState(null, "", "/");
              location.reload();
            }}
          >
            退出
          </button>
        </footer>
      </aside>
      {!sidebarCollapsed && (
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
              const next = Math.max(
                220,
                Math.min(520, current + direction * step),
              );
              localStorage.setItem("claude-ui-sidebar-width", String(next));
              return next;
            });
          }}
        >
          <span />
        </div>
      )}
      <section className="chat">
        <header>
          <button
            type="button"
            className="mobile-header-button menu-button"
            aria-label="打开历史会话"
            aria-expanded={mobileSessionsOpen}
            onClick={() => setMobileSessionsOpen(true)}
          >
            <FontAwesomeIcon icon={faBars} />
          </button>
          {sidebarCollapsed && (
            <button
              type="button"
              className="desktop-sidebar-open"
              title="展开侧边栏"
              aria-label="展开侧边栏"
              onClick={() => setSidebarCollapsed(false)}
            >
              <FontAwesomeIcon icon={faTableColumns} />
            </button>
          )}
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
              return (
                <ActivityCard
                  activity={activity}
                  inProgress={
                    busy &&
                    i === lastActivityIndex &&
                    (activity.kind === "thinking" ||
                      (activity.kind === "tool" && activity.output == null))
                  }
                  key={m.id || i}
                />
              );
            }
            if (m.role === "metrics") return null;
            const messageKey = m.id || `assistant-${i}`;
            const streamingThisMessage =
              m.role === "assistant" && busy && i === messages.length - 1;
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
                  {m.role === "assistant" &&
                    m.content &&
                    !streamingThisMessage && (
                      <div className="response-actions" aria-label="回复操作">
                        {m.metrics && (
                          <ResponseMetricsLabel metrics={m.metrics} />
                        )}
                        <button
                          type="button"
                          title="复制回复"
                          aria-label="复制回复"
                          onClick={() =>
                            void copyResponse(m.content, messageKey)
                          }
                        >
                          <FontAwesomeIcon
                            icon={
                              copiedMessageId === messageKey ? faCheck : faCopy
                            }
                          />
                          <span>
                            {copiedMessageId === messageKey ? "已复制" : "复制"}
                          </span>
                        </button>
                        <button
                          type="button"
                          title="重试此问题"
                          aria-label="重试此问题"
                          disabled={busy}
                          onClick={() => retryResponse(i)}
                        >
                          <FontAwesomeIcon icon={faRotateRight} />
                          <span>重试</span>
                        </button>
                      </div>
                    )}
                </div>
              </article>
            );
          })}
          {conversationPhase && (
            <div
              className="conversation-live-status"
              role="status"
              aria-live="polite"
            >
              <span className="live-status-spinner" aria-hidden="true" />
              <strong>{conversationPhase.label}</strong>
              <span className="live-status-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <small>{conversationPhase.detail}</small>
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </div>
        <form
          className={`composer${draggingFiles ? " dragging-files" : ""}`}
          ref={composerFormRef}
          onSubmit={send}
          onDragEnter={onComposerDragEnter}
          onDragOver={(event) => {
            if (!containsDraggedFiles(event) || busy || uploading) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          {draggingFiles && (
            <div className="composer-drop-overlay" aria-hidden="true">
              <FontAwesomeIcon icon={faCloudArrowUp} />
              <b>松开以上传</b>
              <span>支持文件和图片，单个最大 500MB</span>
            </div>
          )}
          {pendingQuestion && (
            <SubmitAnswerPanel
              pending={pendingQuestion}
              answers={questionAnswers}
              customAnswers={customQuestionAnswers}
              busy={busy}
              onToggle={(questionIndex, label, multiSelect) =>
                setQuestionAnswers((current) => {
                  const selected = current[questionIndex] || [];
                  return {
                    ...current,
                    [questionIndex]: multiSelect
                      ? selected.includes(label)
                        ? selected.filter((item) => item !== label)
                        : [...selected, label]
                      : [label],
                  };
                })
              }
              onCustomAnswer={(questionIndex, value) =>
                setCustomQuestionAnswers((current) => ({
                  ...current,
                  [questionIndex]: value,
                }))
              }
              onDismiss={() => setPendingQuestion(null)}
              onSubmit={() => {
                const response = pendingQuestion.questions
                  .map((question, index) => {
                    const selections = questionAnswers[index] || [];
                    const custom = customQuestionAnswers[index]?.trim();
                    const answer = [
                      ...selections,
                      ...(custom ? [custom] : []),
                    ].join(", ");
                    return `${question.question}\n${answer}`;
                  })
                  .join("\n\n");
                setPendingQuestion(null);
                setQuestionAnswers({});
                setCustomQuestionAnswers({});
                setInput(response);
                requestAnimationFrame(() =>
                  composerFormRef.current?.requestSubmit(),
                );
              }}
            />
          )}
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
                <div className="slash-empty">
                  {slashItemsLoading
                    ? "正在扫描 Commands 和 Skills…"
                    : "没有匹配项"}
                </div>
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
                  {workspaceFilesLoaded
                    ? "没有匹配的文件"
                    : "无法读取工作区文件"}
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
                inputHighlightRef.current.scrollTop =
                  event.currentTarget.scrollTop;
                inputHighlightRef.current.scrollLeft =
                  event.currentTarget.scrollLeft;
              }}
              onChange={(e) => {
                const value = e.target.value;
                setInput(value);
                const hasSlash = /(?:^|\s)\/[^\s]*$/.test(value);
                const hasMention = /(?:^|\s)@[^\s@]*$/.test(value);
                setShowSlashMenu(hasSlash);
                setShowMentionMenu(hasMention);
                if (hasMention) void loadWorkspaceFiles();
                if (hasSlash) void refreshSlashItems();
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
                if (e.key === "Enter" && (e.shiftKey || e.ctrlKey)) {
                  e.preventDefault();
                  const start = e.currentTarget.selectionStart;
                  const end = e.currentTarget.selectionEnd;
                  const next = `${input.slice(0, start)}\n${input.slice(end)}`;
                  setInput(next);
                  requestAnimationFrame(() => {
                    const cursor = start + 1;
                    textareaRef.current?.setSelectionRange(cursor, cursor);
                  });
                  return;
                }
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (!files.length || busy || uploading) return;
                event.preventDefault();
                void uploadFiles(files);
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
                  void refreshSlashItems();
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

function SubmitAnswerPanel({
  pending,
  answers,
  customAnswers,
  busy,
  onToggle,
  onCustomAnswer,
  onDismiss,
  onSubmit,
}: {
  pending: PendingQuestion;
  answers: Record<number, string[]>;
  customAnswers: Record<number, string>;
  busy: boolean;
  onToggle: (
    questionIndex: number,
    label: string,
    multiSelect: boolean,
  ) => void;
  onCustomAnswer: (questionIndex: number, value: string) => void;
  onDismiss: () => void;
  onSubmit: () => void;
}) {
  const complete = pending.questions.every(
    (_question, index) =>
      Boolean(answers[index]?.length) || Boolean(customAnswers[index]?.trim()),
  );
  return (
    <section className="submit-answer-panel" aria-label="Claude 需要你的回答">
      <header>
        <div>
          <span className="answer-status-dot" aria-hidden="true" />
          <b>Claude needs your input</b>
        </div>
        <button
          type="button"
          className="answer-dismiss"
          onClick={onDismiss}
          aria-label="关闭"
        >
          ×
        </button>
      </header>
      <div className="answer-questions">
        {pending.questions.map((question, questionIndex) => (
          <fieldset key={`${pending.toolUseId}-${questionIndex}`}>
            <legend>
              {question.header && <small>{question.header}</small>}
              <span>{question.question}</span>
            </legend>
            {question.options?.length ? (
              <div className="answer-options">
                {question.options.map((option) => {
                  const selected =
                    answers[questionIndex]?.includes(option.label) || false;
                  return (
                    <button
                      type="button"
                      className={selected ? "selected" : ""}
                      aria-pressed={selected}
                      key={option.label}
                      onClick={() =>
                        onToggle(
                          questionIndex,
                          option.label,
                          Boolean(question.multiSelect),
                        )
                      }
                    >
                      <span
                        className={
                          question.multiSelect
                            ? "answer-checkbox"
                            : "answer-radio"
                        }
                      >
                        {selected && <i />}
                      </span>
                      <span>
                        <b>{option.label}</b>
                        {option.description && (
                          <small>{option.description}</small>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <input
              type="text"
              value={customAnswers[questionIndex] || ""}
              onChange={(event) =>
                onCustomAnswer(questionIndex, event.target.value)
              }
              placeholder={
                question.options?.length
                  ? "Other answer (optional)"
                  : "Type your answer…"
              }
            />
          </fieldset>
        ))}
      </div>
      <footer>
        <span>
          {busy ? "等待 Claude 完成当前步骤…" : "提交后将继续当前会话"}
        </span>
        <button
          type="button"
          className="answer-submit"
          disabled={busy || !complete}
          onClick={onSubmit}
        >
          Submit answer
        </button>
      </footer>
    </section>
  );
}

function formatTokenCount(value: number) {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000)
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function ResponseMetricsLabel({ metrics }: { metrics: ResponseMetrics }) {
  const totalTokens = metrics.inputTokens + metrics.outputTokens;
  const details = [
    `耗时：${formatDuration(metrics.durationMs)}`,
    `输入：${metrics.inputTokens.toLocaleString()} tokens`,
    `输出：${metrics.outputTokens.toLocaleString()} tokens`,
    metrics.cacheReadTokens
      ? `缓存读取：${metrics.cacheReadTokens.toLocaleString()} tokens`
      : "",
    metrics.cacheCreationTokens
      ? `缓存写入：${metrics.cacheCreationTokens.toLocaleString()} tokens`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className="response-metrics" title={details}>
      <span>{formatDuration(metrics.durationMs)}</span>
      <i aria-hidden="true" />
      <span>{formatTokenCount(totalTokens)} tokens</span>
    </span>
  );
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
  return (
    <>
      {parts}
      {value.endsWith("\n") ? "\u200b" : null}
    </>
  );
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
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return faFileCode;
  if (extension === "py") return faFileCode;
  if (["html", "htm", "vue", "svelte"].includes(extension)) return faFileCode;
  if (["css", "scss", "sass", "less"].includes(extension)) return faPalette;
  if (["md", "mdx", "markdown"].includes(extension)) return faFileLines;
  if (["json", "jsonc", "yaml", "yml", "toml", "xml"].includes(extension))
    return faSliders;
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(
      extension,
    )
  )
    return faFileImage;
  if (extension === "pdf") return faFilePdf;
  if (["doc", "docx", "odt", "rtf", "txt"].includes(extension))
    return faFileLines;
  if (["csv", "xls", "xlsx", "parquet"].includes(extension)) return faFileExcel;
  if (["zip", "tar", "gz", "tgz", "rar", "7z"].includes(extension))
    return faFileZipper;
  if (["sh", "bash", "zsh", "fish", "ps1"].includes(extension))
    return faTerminal;
  if (["sql", "db", "sqlite", "sqlite3"].includes(extension)) return faDatabase;
  if (
    ["mp3", "wav", "ogg", "m4a", "flac", "mp4", "mov", "webm"].includes(
      extension,
    )
  )
    return faFileVideo;
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return faBox;
  if (lower === "makefile" || lower === "justfile") return faGear;
  if (lower === ".env" || lower.startsWith(".env.")) return faKey;
  return faFile;
}

function WorkspaceFileRow({ file }: { file: WorkspaceFile }) {
  const iconType = fileTypeIcon(file.name);
  return (
    <div
      className="workspace-file"
      title={`${file.path} · ${formatFileSize(file.size)}`}
    >
      <span className="workspace-file-icon" aria-hidden="true">
        <FontAwesomeIcon icon={iconType} />
      </span>
      <span>{file.name}</span>
      <small>{formatFileSize(file.size)}</small>
    </div>
  );
}

function ActivityCard({
  activity,
  inProgress = false,
}: {
  activity: Activity;
  inProgress?: boolean;
}) {
  const title = activityDisplayTitle(activity);
  const icon =
    activity.kind === "thinking"
      ? "✦"
      : activity.kind === "status"
        ? "◌"
        : activity.isError
          ? "×"
          : activity.kind === "tool" && activity.output != null
            ? "✓"
            : activity.kind === "tool_result"
              ? "✓"
              : "⌘";
  return (
    <details
      className={`activity-card ${activity.kind} ${activity.isError ? "failed" : ""} ${inProgress ? "in-progress" : ""}`}
    >
      <summary>
        <span className="activity-icon">{icon}</span>
        <span className="activity-label">
          <strong>{title.keyword}</strong>
          {title.description && (
            <span className="activity-description">{title.description}</span>
          )}
          {inProgress && activity.kind === "tool" && (
            <span className="activity-running">
              Running<span aria-hidden="true">…</span>
            </span>
          )}
        </span>
        {(activity.detail || activity.output != null) && (
          <small aria-label="展开详情">&gt;</small>
        )}
      </summary>
      {(activity.detail || activity.output != null) && (
        <ActivityDetail activity={activity} />
      )}
    </details>
  );
}

function ActivityDetail({ activity }: { activity: Activity }) {
  if (activity.kind === "thinking") {
    return (
      <div className="thinking-markdown">
        <ReactMarkdown>{activity.detail || ""}</ReactMarkdown>
      </div>
    );
  }
  if (activity.kind === "tool") {
    return (
      <div className="activity-detail tool-io">
        <section>
          <b>IN</b>
          <pre>{formatActivityInput(activity)}</pre>
        </section>
        {activity.output != null && (
          <section className={activity.isError ? "io-error" : ""}>
            <b>OUT</b>
            <pre>{activity.output || "(no output)"}</pre>
          </section>
        )}
      </div>
    );
  }
  return <pre>{activity.detail}</pre>;
}

function activityDisplayLabel(activity: Activity) {
  if (activity.kind !== "tool") return activity.label;
  try {
    const input = JSON.parse(activity.detail || "{}") as Record<
      string,
      unknown
    >;
    const name = activity.toolName || activity.label;
    const compact = (value: unknown) => {
      const text = String(value || "")
        .replace(/\s+/g, " ")
        .trim();
      return text.length > 140 ? `${text.slice(0, 139)}…` : text;
    };
    const withValue = (label: string, value: unknown) => {
      const text = compact(value);
      return text ? `${label} ${text}` : label;
    };
    if (name === "Read")
      return withValue("Read", input.file_path || input.path);
    if (["Write", "Edit", "MultiEdit"].includes(name))
      return withValue(name, input.file_path || input.path);
    if (name === "Bash")
      return withValue("Bash", input.description || input.command);
    if (name === "Agent" || name === "Task")
      return withValue(
        "Agent",
        input.description || input.subagent_type || input.prompt,
      );
    if (name === "Glob" || name === "Grep")
      return withValue(name, input.pattern);
    if (name === "WebFetch") return withValue(name, input.url);
    if (name === "WebSearch") return withValue(name, input.query);
    if (name === "Skill") return withValue(name, input.skill || input.name);
    if (name === "mcp__ui__ask_user") return "Ask user";
    return activity.label;
  } catch {
    return activity.label;
  }
}

function activityDisplayTitle(activity: Activity) {
  const label = activityDisplayLabel(activity);
  if (activity.kind !== "tool") return { keyword: label, description: "" };
  const rawName = activity.toolName || activity.label.split(" ")[0];
  const keyword =
    rawName === "Task"
      ? "Agent"
      : rawName === "mcp__ui__ask_user"
        ? "Ask user"
        : rawName;
  const description = label.startsWith(`${keyword} `)
    ? label.slice(keyword.length + 1)
    : label === keyword
      ? ""
      : label;
  return { keyword, description };
}

function formatActivityInput(activity: Activity) {
  try {
    const input = JSON.parse(activity.detail || "{}") as Record<
      string,
      unknown
    >;
    const name = activity.toolName || activity.label.split(" ")[0];
    if (name === "Bash" && input.command != null) return String(input.command);
    if (name === "Read") {
      const fields = [
        input.file_path || input.path,
        input.offset != null ? `offset: ${input.offset}` : "",
        input.limit != null ? `limit: ${input.limit}` : "",
      ].filter(Boolean);
      return fields.join("\n");
    }
    if ((name === "Agent" || name === "Task") && input.prompt != null)
      return String(input.prompt);
    return JSON.stringify(input, null, 2);
  } catch {
    return activity.detail || "";
  }
}
createRoot(document.getElementById("root")!).render(<App />);
