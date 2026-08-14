import React, {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBox,
  faAnglesLeft,
  faAnglesRight,
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
  faEnvelope,
  faUser,
  faUsers,
  faRightFromBracket,
  faChevronUp,
  faCloudArrowUp,
  faArrowDown,
  faGear,
  faKey,
  faListCheck,
  faPalette,
  faPenToSquare,
  faRotateRight,
  faSliders,
  faStar,
  faTerminal,
  faTrashCan,
  faWandMagicSparkles,
  faXmark,
  faHand,
} from "@fortawesome/free-solid-svg-icons";
import ReactMarkdown, { WorkspaceMentionText } from "./MarkdownMessage";
import type { OpenWorkspaceFile } from "./WorkspaceEditor";
import "./styles.css";
import "./chat-layout.css";
import "./markdown.css";
import "./activity.css";
import "./composer.css";
import "./workspace-editor.css";
import "./minimax-theme.css";
type Session = {
  id: string;
  title: string;
  updated_at: string;
  favorite: 0 | 1;
  username: string;
};
type Activity = {
  kind: "status" | "thinking" | "narration" | "tool" | "tool_result";
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
  created_at?: string;
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
type PublishedPage = {
  file_path: string;
  kind: "file" | "folder";
  url: string;
};
type PublishableWorkspaceEntry = {
  path: string;
  kind: "file" | "folder";
};
type FileClipboard = { file: WorkspaceFile; operation: "copy" | "cut" };
type FileContextMenu = {
  x: number;
  y: number;
  file?: WorkspaceFile;
  directory?: string;
};
type PendingWorkspaceEntry = {
  kind: "file" | "folder";
  directory: string;
};
type WorkspaceRenameTarget = {
  name: string;
  path: string;
  kind: "file" | "folder";
};
type QuestionOption = { label: string; description?: string };
type ClaudeQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
};
type PendingQuestion = { toolUseId: string; questions: ClaudeQuestion[] };
type PendingRegistration = {
  id: string;
  username: string;
  email: string;
  created_at: string;
  approval_status: "pending" | "approved" | "rejected";
  reviewed_at: string | null;
};
type AdminUser = {
  id: string;
  username: string;
  email: string;
  created_at: string;
  approved: 0 | 1;
  approval_status: "pending" | "approved" | "rejected" | null;
};
type FileTreeNode = {
  name: string;
  path: string;
  directories: FileTreeNode[];
  files: WorkspaceFile[];
};
const loadWorkspaceEditor = () => import("./WorkspaceEditor");
const WorkspaceEditor = lazy(loadWorkspaceEditor);
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;
const IMAGE_ATTACHMENT_PATTERN = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;
function workspacePreviewUrl(filePath: string, prefix = "") {
  return `/api/workspace/preview/${[prefix, filePath]
    .filter(Boolean)
    .join("/")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}
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
    description: "自动判断并执行所需工具",
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
    description: "自动接受文件编辑",
  },
];
type SlashItem = { name: string; description: string };
const DESKTOP_SIDEBAR_RAIL_WIDTH = 56;
function localId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function parseActivity(message: Message) {
  if (message.role !== "activity") return null;
  try {
    const activity = JSON.parse(message.content) as Activity;
    if (
      activity.kind === "thinking" &&
      activity.toolUseId?.startsWith("narration-")
    )
      return { ...activity, kind: "narration" as const };
    return activity;
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
  // Claude confirms a tool-use message only after the tool block has already
  // streamed. Move its narration back in front of the contiguous tool cards so
  // historical sessions preserve the semantic order: narration -> tool.
  for (let index = 0; index < merged.length; index += 1) {
    if (parseActivity(merged[index])?.kind !== "narration") continue;
    let target = index;
    while (target > 0 && parseActivity(merged[target - 1])?.kind === "tool")
      target -= 1;
    if (target === index) continue;
    const [narration] = merged.splice(index, 1);
    merged.splice(target, 0, narration);
  }
  return merged;
}
async function api(url: string, options?: RequestInit) {
  const method = (options?.method || "GET").toUpperCase();
  let r: Response | undefined;
  let lastError: unknown;
  const attempts = method === "GET" ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt)
      await new Promise((resolve) =>
        window.setTimeout(resolve, attempt === 1 ? 250 : 750),
      );
    try {
      r = await fetch("/api" + url, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      break;
    } catch (requestError) {
      lastError = requestError;
    }
  }
  if (!r)
    throw new Error(
      lastError instanceof Error && lastError.message
        ? lastError.message
        : "连接服务器失败，请稍后重试",
    );
  if (!r.ok)
    throw new Error((await r.json().catch(() => ({}))).error || "请求失败");
  return r.status === 204 ? null : r.json();
}
function uploadForm(
  url: string,
  form: FormData,
  onProgress: (percent: number) => void,
) {
  return new Promise<unknown>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.responseType = "json";
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable)
        onProgress(
          Math.min(100, Math.round((event.loaded / event.total) * 100)),
        );
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve(request.response);
        return;
      }
      reject(new Error(request.response?.error || "上传失败"));
    });
    request.addEventListener("error", () => reject(new Error("上传失败")));
    request.addEventListener("abort", () => reject(new Error("上传已取消")));
    request.send(form);
  });
}
function Login({ onDone, appName }: { onDone: () => void; appName: string }) {
  const [register, setRegister] = useState(false),
    [username, setUsername] = useState(""),
    [email, setEmail] = useState(""),
    [loginIdentifier, setLoginIdentifier] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      const result = await api("/auth/" + (register ? "register" : "login"), {
        method: "POST",
        body: JSON.stringify(
          register
            ? { username, email, password }
            : { identifier: loginIdentifier, password },
        ),
      });
      if (register && result?.pending) {
        setNotice(result.message || "注册申请已提交，请等待管理员审批");
        setRegister(false);
        setUsername("");
        setEmail("");
        setPassword("");
        return;
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="login">
      <form onSubmit={submit}>
        <div className="brand">✦ {appName}</div>
        <h1>{register ? "创建账号" : "欢迎回来"}</h1>
        <p>让灵感、代码与智能协作在此汇流</p>
        {register && (
          <label>
            用户名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              pattern="[a-z0-9][a-z0-9_-]*"
              minLength={2}
              maxLength={32}
              required
            />
          </label>
        )}
        {register ? (
          <label>
            邮箱
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>
        ) : (
          <label>
            用户名或邮箱
            <input
              type="text"
              value={loginIdentifier}
              onChange={(e) => setLoginIdentifier(e.target.value)}
              autoComplete="username"
              placeholder="输入用户名或邮箱"
              required
            />
          </label>
        )}
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={register ? "new-password" : "current-password"}
            minLength={6}
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        {notice && <div className="login-notice">{notice}</div>}
        <button>{register ? "提交注册申请" : "登录"}</button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setRegister(!register);
            setError("");
            setNotice("");
          }}
        >
          {register ? "已有账号？登录" : "没有账号？注册"}
        </button>
      </form>
    </main>
  );
}
function App() {
  const defaultSidebarWidth = () =>
    Math.max(180, Math.min(520, Math.round(window.innerWidth * 0.15)));
  const defaultWorkspaceWidth = () =>
    Math.max(360, Math.round(window.innerWidth * 0.6));
  const initialSidebarWidth = () => {
    const saved = Number(localStorage.getItem("claude-ui-sidebar-width"));
    return Number.isFinite(saved) && saved >= 180 && saved <= 520
      ? saved
      : defaultSidebarWidth();
  };
  const [me, setMe] = useState<
      | {
          email: string;
          username: string;
          created_at: string;
          isRoot: boolean;
        }
      | null
      | undefined
    >(),
    [appName, setAppName] = useState("CloudInk"),
    [sessions, setSessions] = useState<Session[]>([]),
    [active, setActive] = useState(sessionIdFromLocation),
    [messages, setMessages] = useState<Message[]>([]),
    [input, setInput] = useState(""),
    [mode, setMode] = useState<ExecutionMode>("auto"),
    [currentModel, setCurrentModel] = useState("CLI default"),
    [attachments, setAttachments] = useState<Attachment[]>([]),
    [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]),
    [workspaceDirectories, setWorkspaceDirectories] = useState<string[]>([]),
    [workspaceFilesLoaded, setWorkspaceFilesLoaded] = useState(false),
    [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false),
    [publishedPages, setPublishedPages] = useState<Record<string, string>>({}),
    [openWorkspaceFiles, setOpenWorkspaceFiles] = useState<OpenWorkspaceFile[]>(
      [],
    ),
    [activeWorkspacePath, setActiveWorkspacePath] = useState(""),
    [savingWorkspacePath, setSavingWorkspacePath] = useState(""),
    [showMentionMenu, setShowMentionMenu] = useState(false),
    [showSlashMenu, setShowSlashMenu] = useState(false),
    [slashSelectedIndex, setSlashSelectedIndex] = useState(0),
    [mentionSelectedIndex, setMentionSelectedIndex] = useState(0),
    [dynamicCommands, setDynamicCommands] = useState<SlashItem[]>([]),
    [dynamicSkills, setDynamicSkills] = useState<SlashItem[]>([]),
    [slashItemsLoading, setSlashItemsLoading] = useState(false),
    [showModeMenu, setShowModeMenu] = useState(false),
    [sidebarView, setSidebarView] = useState<"sessions" | "files">("sessions"),
    [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth),
    [workspaceWidth, setWorkspaceWidth] = useState(() => {
      const saved = Number(localStorage.getItem("claude-ui-workspace-width"));
      return Number.isFinite(saved) && saved >= 360
        ? saved
        : defaultWorkspaceWidth();
    }),
    [fileContextMenu, setFileContextMenu] = useState<FileContextMenu | null>(
      null,
    ),
    [fileClipboard, setFileClipboard] = useState<FileClipboard | null>(null),
    [pendingWorkspaceEntry, setPendingWorkspaceEntry] =
      useState<PendingWorkspaceEntry | null>(null),
    [pendingWorkspaceRename, setPendingWorkspaceRename] =
      useState<WorkspaceRenameTarget | null>(null),
    [workspaceNameSaving, setWorkspaceNameSaving] = useState(false),
    [workspaceNameError, setWorkspaceNameError] = useState(""),
    [workspaceRenameSaving, setWorkspaceRenameSaving] = useState(false),
    [workspaceRenameError, setWorkspaceRenameError] = useState(""),
    [workspaceNotice, setWorkspaceNotice] = useState(""),
    [workspaceUploadDirectory, setWorkspaceUploadDirectory] = useState(""),
    [workspaceDropDirectory, setWorkspaceDropDirectory] = useState<
      string | null
    >(null),
    [draggingWorkspaceFiles, setDraggingWorkspaceFiles] = useState(false),
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
    [favoriteUpdatingId, setFavoriteUpdatingId] = useState(""),
    [expandedRootUsers, setExpandedRootUsers] = useState<Set<string>>(
      new Set(),
    ),
    [pendingRegistrations, setPendingRegistrations] = useState<
      PendingRegistration[]
    >([]),
    [showApprovalPanel, setShowApprovalPanel] = useState(false),
    [accountMenuOpen, setAccountMenuOpen] = useState(false),
    [accountPanel, setAccountPanel] = useState<
      "profile" | "users" | "password" | null
    >(null),
    [adminUsers, setAdminUsers] = useState<AdminUser[]>([]),
    [selectedAdminUserId, setSelectedAdminUserId] = useState(""),
    [newPassword, setNewPassword] = useState(""),
    [passwordSaving, setPasswordSaving] = useState(false),
    [accountNotice, setAccountNotice] = useState(""),
    [approvalUpdatingId, setApprovalUpdatingId] = useState(""),
    [mobileSessionsOpen, setMobileSessionsOpen] = useState(false),
    [uploading, setUploading] = useState(false),
    [uploadProgress, setUploadProgress] = useState<number | null>(null),
    [uploadTarget, setUploadTarget] = useState<"composer" | "workspace" | null>(
      null,
    ),
    [uploadLabel, setUploadLabel] = useState(""),
    [draggingFiles, setDraggingFiles] = useState(false),
    [showScrollToBottom, setShowScrollToBottom] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceFileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modeButtonRef = useRef<HTMLButtonElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashButtonRef = useRef<HTMLButtonElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const accountPanelRef = useRef<HTMLElement>(null);
  const approvalPanelRef = useRef<HTMLElement>(null);
  const adminUserPopoverRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const skipMessageLoadForRef = useRef("");
  const responseAbortRef = useRef<AbortController | null>(null);
  const resizingSidebarRef = useRef(false);
  const resizingWorkspaceRef = useRef(false);
  const fileDragDepthRef = useRef(0);
  const slashItemsRequestRef = useRef(0);
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
  const slashMenuItems = [...filteredCommands, ...filteredSkills];
  const activeMode =
    executionModes.find((option) => option.value === mode) || executionModes[0];
  const activeSession = sessions.find((session) => session.id === active);
  const viewingForeignSession = Boolean(
    me?.isRoot && activeSession && activeSession.username !== me.username,
  );
  const pendingRegistrationCount = pendingRegistrations.filter(
    (registration) => registration.approval_status === "pending",
  ).length;
  const load = () => api("/sessions").then(setSessions);
  async function refreshPendingRegistrations() {
    const result = (await api("/admin/registrations")) as {
      users: PendingRegistration[];
    };
    setPendingRegistrations(result.users || []);
  }
  async function openAccountPanel(panel: "profile" | "users" | "password") {
    setAccountMenuOpen(false);
    setShowApprovalPanel(false);
    setSelectedAdminUserId("");
    setAccountPanel(panel);
    setAccountNotice("");
    if (panel === "users") {
      const result = (await api("/admin/users")) as { users: AdminUser[] };
      setAdminUsers(result.users || []);
    }
  }
  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setAccountNotice("");
    setPasswordSaving(true);
    try {
      await api("/me/password", {
        method: "POST",
        body: JSON.stringify({ newPassword }),
      });
      setNewPassword("");
      setAccountNotice("密码修改成功");
    } catch (passwordError) {
      setAccountNotice((passwordError as Error).message);
    } finally {
      setPasswordSaving(false);
    }
  }
  async function reviewRegistration(id: string, approve: boolean) {
    if (approvalUpdatingId) return;
    setApprovalUpdatingId(id);
    setError("");
    try {
      await api(`/admin/registrations/${id}${approve ? "/approve" : ""}`, {
        method: approve ? "POST" : "DELETE",
      });
      await refreshPendingRegistrations();
      if (approve) {
        setWorkspaceFilesLoaded(false);
        if (sidebarView === "files") void loadWorkspaceFiles(true);
      }
    } catch (reviewError) {
      setError((reviewError as Error).message);
    } finally {
      setApprovalUpdatingId("");
    }
  }
  async function toggleSessionFavorite(session: Session) {
    if (favoriteUpdatingId) return;
    const favorite: 0 | 1 = session.favorite ? 0 : 1;
    const previous = sessions;
    setFavoriteUpdatingId(session.id);
    setSessions((current) =>
      current
        .map((item) => (item.id === session.id ? { ...item, favorite } : item))
        .sort(
          (a, b) =>
            b.favorite - a.favorite || b.updated_at.localeCompare(a.updated_at),
        ),
    );
    try {
      await api(`/sessions/${session.id}/favorite`, {
        method: "POST",
        body: JSON.stringify({ favorite: Boolean(favorite) }),
      });
      await load();
    } catch (favoriteError) {
      setSessions(previous);
      setError(`收藏失败：${(favoriteError as Error).message}`);
    } finally {
      setFavoriteUpdatingId("");
    }
  }
  async function refreshSlashItems() {
    const requestId = ++slashItemsRequestRef.current;
    setDynamicCommands([]);
    setDynamicSkills([]);
    setSlashItemsLoading(true);
    try {
      const result = (await api("/slash-items")) as {
        commands: SlashItem[];
        skills: SlashItem[];
      };
      if (requestId !== slashItemsRequestRef.current) return;
      setDynamicCommands(result.commands);
      setDynamicSkills(result.skills);
    } catch (loadError) {
      if (requestId !== slashItemsRequestRef.current) return;
      setError((loadError as Error).message);
    } finally {
      if (requestId === slashItemsRequestRef.current)
        setSlashItemsLoading(false);
    }
  }
  function navigateToSession(id: string, replace = false) {
    const url = id ? `/sessions/${encodeURIComponent(id)}` : "/";
    window.history[replace ? "replaceState" : "pushState"](null, "", url);
    setActive(id);
  }
  useEffect(() => {
    void api("/public-config")
      .then((config) => {
        if (typeof config.appName === "string" && config.appName.trim())
          setAppName(config.appName.trim());
      })
      .catch(() => undefined);
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
    document.title = appName;
  }, [appName]);
  useEffect(() => {
    if (!me || workspaceFilesLoaded || workspaceFilesLoading) return;
    void loadWorkspaceFiles();
  }, [me, workspaceFilesLoaded, workspaceFilesLoading]);
  useEffect(() => {
    if (!accountMenuOpen && !accountPanel && !showApprovalPanel) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        accountMenuRef.current?.contains(target) ||
        accountTriggerRef.current?.contains(target) ||
        accountPanelRef.current?.contains(target) ||
        approvalPanelRef.current?.contains(target) ||
        adminUserPopoverRef.current?.contains(target)
      )
        return;
      setAccountMenuOpen(false);
      setAccountPanel(null);
      setShowApprovalPanel(false);
      setSelectedAdminUserId("");
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [accountMenuOpen, accountPanel, showApprovalPanel]);
  useEffect(() => {
    if (!me?.isRoot) return;
    const refresh = () =>
      void refreshPendingRegistrations().catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [me?.isRoot]);
  useEffect(() => {
    localStorage.setItem("claude-ui-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem("claude-ui-workspace-width", String(workspaceWidth));
  }, [workspaceWidth]);
  useEffect(() => {
    if (!fileContextMenu) return;
    const close = () => setFileContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
    };
  }, [fileContextMenu]);
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
    setSlashSelectedIndex(0);
  }, [slashQuery, showSlashMenu, dynamicCommands, dynamicSkills]);
  useEffect(() => {
    setMentionSelectedIndex(0);
  }, [mentionQuery, showMentionMenu, workspaceFiles]);
  useEffect(() => {
    if (!showSlashMenu) return;
    slashMenuRef.current
      ?.querySelector<HTMLElement>(`[data-menu-index="${slashSelectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [showSlashMenu, slashSelectedIndex]);
  useEffect(() => {
    if (!showMentionMenu) return;
    document
      .querySelector<HTMLElement>(
        `.mention-menu [data-menu-index="${mentionSelectedIndex}"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [showMentionMenu, mentionSelectedIndex]);
  useEffect(() => {
    if (!active || !me) return;
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
  }, [active, me]);
  useEffect(() => {
    if (!active || !me) return;
    let disposed = false;
    let timer: number | undefined;
    const syncBackgroundRun = async () => {
      if (responseAbortRef.current) {
        timer = window.setTimeout(syncBackgroundRun, 2000);
        return;
      }
      try {
        const run = (await api(`/sessions/${active}/run`)) as {
          running: boolean;
        };
        if (disposed) return;
        setBusy(run.running);
        if (run.running) {
          const items = (await api(
            `/sessions/${active}/messages`,
          )) as Message[];
          if (!disposed) setMessages(mergeActivityMessages(items));
        }
      } catch {
        // The normal session-loading effect handles missing or inaccessible
        // sessions. A transient status request must not interrupt the chat.
      }
      if (!disposed) timer = window.setTimeout(syncBackgroundRun, 2000);
    };
    void syncBackgroundRun();
    return () => {
      disposed = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [active, me]);
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
    setShowScrollToBottom(false);
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
  function scrollMessagesToBottom() {
    const container = messagesRef.current;
    if (!container) return;
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    container.style.scrollBehavior = "auto";
    container.scrollTop = container.scrollHeight;
    window.setTimeout(() => {
      if (!container.isConnected) return;
      container.scrollTop = container.scrollHeight;
      container.style.removeProperty("scroll-behavior");
    }, 250);
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
    setUploadTarget("composer");
    setUploadProgress(0);
    setUploadLabel(
      selected.length === 1 ? selected[0].name : `${selected.length} 个文件`,
    );
    setError("");
    try {
      const form = new FormData();
      selected.forEach((file) => form.append("files", file));
      const result = (await uploadForm(
        "/api/files",
        form,
        setUploadProgress,
      )) as {
        files: Attachment[];
      };
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
      setUploadProgress(null);
      setUploadTarget(null);
      setUploadLabel("");
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
    if (busy || viewingForeignSession) return;
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
      const publicationsRequest = (
        api("/workspace/publications") as Promise<{ pages: PublishedPage[] }>
      ).catch(() => null);
      const result = (await api("/workspace/files")) as {
        files: WorkspaceFile[];
        directories: string[];
      };
      setWorkspaceFiles(result.files);
      setWorkspaceDirectories(result.directories || []);
      setWorkspaceFilesLoaded(true);
      void publicationsRequest.then((publications) => {
        if (!publications) return;
        setPublishedPages(
          Object.fromEntries(
            publications.pages.map((page) => [page.file_path, page.url]),
          ),
        );
      });
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setWorkspaceFilesLoading(false);
    }
  }
  function showWorkspaceFiles() {
    setSidebarView("files");
    setSidebarCollapsed(false);
    void loadWorkspaceFiles();
    // Give the small directory response and React paint priority. The heavier
    // CodeMirror chunk can warm in the background after the sidebar is ready.
    window.setTimeout(() => void loadWorkspaceEditor(), 600);
  }
  async function refreshWorkspaceFiles() {
    setWorkspaceFilesLoaded(false);
    await loadWorkspaceFiles(true);
  }
  async function createWorkspaceEntry(name: string) {
    const pending = pendingWorkspaceEntry;
    const normalizedName = name.trim();
    if (!pending) return;
    if (!normalizedName) {
      setWorkspaceNameError("名称不能为空");
      return;
    }
    setWorkspaceNameSaving(true);
    setWorkspaceNameError("");
    try {
      await api("/workspace/entry", {
        method: "POST",
        body: JSON.stringify({
          path: pending.directory
            ? `${pending.directory}/${normalizedName}`
            : normalizedName,
          kind: pending.kind,
        }),
      });
      setPendingWorkspaceEntry(null);
      await refreshWorkspaceFiles();
    } catch (entryError) {
      setWorkspaceNameError((entryError as Error).message);
    } finally {
      setWorkspaceNameSaving(false);
    }
  }
  function beginWorkspaceRename(target: WorkspaceRenameTarget) {
    setPendingWorkspaceEntry(null);
    setWorkspaceNameError("");
    setWorkspaceRenameError("");
    setPendingWorkspaceRename(target);
  }
  async function renameWorkspaceFile(name: string) {
    const target = pendingWorkspaceRename;
    const normalizedName = name.trim();
    if (!target) return;
    if (!normalizedName) {
      setWorkspaceRenameError("名称不能为空");
      return;
    }
    if (normalizedName === target.name) {
      setPendingWorkspaceRename(null);
      setWorkspaceRenameError("");
      return;
    }
    if (workspaceRenameSaving) return;
    setWorkspaceRenameSaving(true);
    setWorkspaceRenameError("");
    try {
      const result = (await api("/workspace/rename", {
        method: "POST",
        body: JSON.stringify({
          path: target.path,
          name: normalizedName,
          kind: target.kind,
        }),
      })) as { path: string; name: string };
      if (target.kind === "file") {
        setOpenWorkspaceFiles((current) =>
          current.map((openFile) =>
            openFile.path === target.path
              ? { ...openFile, ...result }
              : openFile,
          ),
        );
        if (activeWorkspacePath === target.path)
          setActiveWorkspacePath(result.path);
      }
      setPendingWorkspaceRename(null);
      await refreshWorkspaceFiles();
    } catch (renameError) {
      const message = (renameError as Error).message;
      setWorkspaceRenameError(
        /failed to fetch|networkerror|load failed/i.test(message)
          ? `无法连接 ${window.location.origin}，请刷新页面后重试`
          : message,
      );
    } finally {
      setWorkspaceRenameSaving(false);
    }
  }
  async function deleteWorkspaceEntry(target: {
    path: string;
    kind: "file" | "folder";
  }) {
    try {
      await api(`/workspace/entry?path=${encodeURIComponent(target.path)}`, {
        method: "DELETE",
      });
      const remaining = openWorkspaceFiles.filter(
        (item) =>
          item.path !== target.path &&
          !(
            target.kind === "folder" && item.path.startsWith(`${target.path}/`)
          ),
      );
      setOpenWorkspaceFiles(remaining);
      if (
        activeWorkspacePath === target.path ||
        (target.kind === "folder" &&
          activeWorkspacePath.startsWith(`${target.path}/`))
      )
        setActiveWorkspacePath(remaining[0]?.path || "");
      if (
        fileClipboard?.file.path === target.path ||
        (target.kind === "folder" &&
          fileClipboard?.file.path.startsWith(`${target.path}/`))
      )
        setFileClipboard(null);
      await refreshWorkspaceFiles();
    } catch (deleteError) {
      setError((deleteError as Error).message);
    }
  }
  async function copyText(value: string) {
    if (navigator.clipboard?.writeText)
      return navigator.clipboard.writeText(value);
    const copyTarget = document.createElement("textarea");
    copyTarget.value = value;
    copyTarget.style.position = "fixed";
    copyTarget.style.opacity = "0";
    document.body.appendChild(copyTarget);
    copyTarget.select();
    document.execCommand("copy");
    copyTarget.remove();
  }
  function showWorkspaceNotice(message: string) {
    setWorkspaceNotice(message);
    window.setTimeout(
      () =>
        setWorkspaceNotice((current) => (current === message ? "" : current)),
      2600,
    );
  }
  async function publishWorkspacePage(target: PublishableWorkspaceEntry) {
    try {
      const result = (await api("/workspace/publish", {
        method: "POST",
        body: JSON.stringify(target),
      })) as { path: string; url: string };
      setPublishedPages((current) => ({
        ...current,
        [result.path]: result.url,
      }));
      try {
        await copyText(`${window.location.origin}${result.url}`);
        showWorkspaceNotice("发布成功，公开链接已复制到剪贴板");
      } catch {
        showWorkspaceNotice("发布成功，可从右键菜单复制或打开公开链接");
      }
    } catch (publishError) {
      setError(`发布失败：${(publishError as Error).message}`);
    }
  }
  async function copyPublishedPageLink(target: { path: string }) {
    const url = publishedPages[target.path];
    if (!url) return;
    try {
      await copyText(`${window.location.origin}${url}`);
      showWorkspaceNotice("公开链接已复制到剪贴板");
    } catch {
      setError("复制失败，请手动打开链接后复制地址");
    }
  }
  async function unpublishWorkspacePage(target: { path: string }) {
    try {
      await api(`/workspace/publish?path=${encodeURIComponent(target.path)}`, {
        method: "DELETE",
      });
      setPublishedPages((current) => {
        const next = { ...current };
        delete next[target.path];
        return next;
      });
      showWorkspaceNotice("已取消发布，原公开链接不再可访问");
    } catch (publishError) {
      setError(`取消发布失败：${(publishError as Error).message}`);
    }
  }
  async function pasteWorkspaceFile(directory = "") {
    if (!fileClipboard) return;
    try {
      const result = (await api("/workspace/paste", {
        method: "POST",
        body: JSON.stringify({
          source: fileClipboard.file.path,
          directory,
          operation: fileClipboard.operation,
        }),
      })) as { path: string; source: string; operation: "copy" | "cut" };
      if (fileClipboard.operation === "cut") {
        setOpenWorkspaceFiles((current) =>
          current.map((file) =>
            file.path === result.source
              ? {
                  ...file,
                  path: result.path,
                  name: result.path.split("/").pop() || file.name,
                }
              : file,
          ),
        );
        if (activeWorkspacePath === result.source)
          setActiveWorkspacePath(result.path);
        setFileClipboard(null);
      }
      await refreshWorkspaceFiles();
    } catch (pasteError) {
      setError((pasteError as Error).message);
    }
  }
  async function uploadWorkspaceFiles(
    files: FileList | File[] | null,
    directory = "",
  ) {
    if (!files?.length || uploading) return;
    const selected = Array.from(files).slice(0, 10);
    const oversized = selected.find((file) => file.size > MAX_UPLOAD_SIZE);
    if (oversized) return setError(`${oversized.name} 超过 500MB，无法上传`);
    setUploading(true);
    setUploadTarget("workspace");
    setUploadProgress(0);
    setUploadLabel(
      selected.length === 1 ? selected[0].name : `${selected.length} 个文件`,
    );
    try {
      const form = new FormData();
      selected.forEach((file) => form.append("files", file));
      await uploadForm(
        `/api/files?directory=${encodeURIComponent(directory)}`,
        form,
        setUploadProgress,
      );
      await refreshWorkspaceFiles();
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setUploading(false);
      setUploadProgress(null);
      setUploadTarget(null);
      setUploadLabel("");
      if (workspaceFileInputRef.current)
        workspaceFileInputRef.current.value = "";
      setDraggingWorkspaceFiles(false);
      setWorkspaceDropDirectory(null);
    }
  }
  async function openWorkspaceFile(file: WorkspaceFile) {
    void loadWorkspaceEditor();
    setMobileSessionsOpen(false);
    setActiveWorkspacePath(file.path);
    if (openWorkspaceFiles.some((openFile) => openFile.path === file.path))
      return;
    setOpenWorkspaceFiles((current) => [
      ...current,
      { ...file, content: "", savedContent: "", loading: true },
    ]);
    try {
      const loaded = (await api(
        `/workspace/file?path=${encodeURIComponent(file.path)}`,
      )) as WorkspaceFile & { content: string };
      setOpenWorkspaceFiles((current) =>
        current.map((openFile) =>
          openFile.path === file.path
            ? {
                ...openFile,
                ...loaded,
                savedContent: loaded.content,
                loading: false,
              }
            : openFile,
        ),
      );
    } catch (openError) {
      setOpenWorkspaceFiles((current) =>
        current.map((openFile) =>
          openFile.path === file.path
            ? {
                ...openFile,
                loading: false,
                error: (openError as Error).message,
              }
            : openFile,
        ),
      );
    }
  }
  function openWorkspacePath(filePath: string) {
    const file = workspaceFiles.find((item) => item.path === filePath);
    if (file) void openWorkspaceFile(file);
  }
  function updateWorkspaceFile(filePath: string, content: string) {
    setOpenWorkspaceFiles((current) =>
      current.map((file) =>
        file.path === filePath ? { ...file, content } : file,
      ),
    );
  }
  async function saveWorkspaceFile(filePath: string) {
    const file = openWorkspaceFiles.find((item) => item.path === filePath);
    if (!file || file.loading || file.error) return;
    setSavingWorkspacePath(filePath);
    try {
      const result = (await api("/workspace/file", {
        method: "PUT",
        body: JSON.stringify({ path: file.path, content: file.content }),
      })) as { size: number };
      setOpenWorkspaceFiles((current) =>
        current.map((item) =>
          item.path === filePath
            ? { ...item, size: result.size, savedContent: item.content }
            : item,
        ),
      );
      setWorkspaceFiles((current) =>
        current.map((item) =>
          item.path === filePath ? { ...item, size: result.size } : item,
        ),
      );
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSavingWorkspacePath("");
    }
  }
  function closeWorkspaceFile(filePath: string) {
    const index = openWorkspaceFiles.findIndex(
      (file) => file.path === filePath,
    );
    if (index < 0) return;
    const file = openWorkspaceFiles[index];
    if (
      file.content !== file.savedContent &&
      !window.confirm(`${file.name} 有未保存的修改，仍要关闭吗？`)
    )
      return;
    const remaining = openWorkspaceFiles.filter(
      (openFile) => openFile.path !== filePath,
    );
    setOpenWorkspaceFiles(remaining);
    if (activeWorkspacePath === filePath)
      setActiveWorkspacePath(
        remaining[Math.min(index, remaining.length - 1)]?.path || "",
      );
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
    if (viewingForeignSession) {
      setError("其他用户的历史会话为只读模式");
      return;
    }
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
        created_at: new Date().toISOString(),
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
        if (evt.type === "activity" && evt.activity) {
          const incomingActivity = evt.activity;
          setMessages((items) => {
            if (incomingActivity.toolUseId) {
              const existingIndex = items.findIndex((message) => {
                const existing = parseActivity(message);
                return existing?.toolUseId === incomingActivity.toolUseId;
              });
              if (existingIndex >= 0) {
                const next = [...items];
                next[existingIndex] = {
                  ...next[existingIndex],
                  content: JSON.stringify(incomingActivity),
                };
                return next;
              }
            }
            const assistantIndex = items.findIndex(
              (message) => message.id === assistantMessageId,
            );
            if (assistantIndex < 0) return items;
            let insertionIndex = assistantIndex;
            if (incomingActivity.kind === "narration") {
              while (
                insertionIndex > 0 &&
                parseActivity(items[insertionIndex - 1])?.kind === "tool"
              )
                insertionIndex -= 1;
            }
            return [
              ...items.slice(0, insertionIndex),
              {
                id: localId("activity"),
                role: "activity",
                content: JSON.stringify(incomingActivity),
              },
              ...items.slice(insertionIndex),
            ];
          });
        }
        if (evt.type === "error")
          throw new Error(evt.error || "CloudInk 请求失败");
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
  async function stopResponse() {
    if (!active) return;
    try {
      await api(`/sessions/${active}/stop`, { method: "POST" });
      responseAbortRef.current?.abort();
      responseAbortRef.current = null;
      setBusy(false);
      await load().catch(() => undefined);
    } catch (stopError) {
      setError((stopError as Error).message);
    }
  }
  if (me === undefined) return <div className="center">加载中…</div>;
  if (!me) return <Login appName={appName} onDone={() => location.reload()} />;
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
      : { label: "Thinking", detail: "CloudInk is working" }
    : null;
  const userInitial =
    Array.from(me.username.trim())[0]?.toLocaleUpperCase() || "U";
  const sessionGroups = Array.from(
    sessions.reduce((groups, session) => {
      const entries = groups.get(session.username) || [];
      entries.push(session);
      groups.set(session.username, entries);
      return groups;
    }, new Map<string, Session[]>()),
  );
  const renderSession = (session: Session) => {
    const owned = session.username === me.username;
    return (
      <div
        className={"session " + (session.id === active ? "active" : "")}
        key={session.id}
      >
        <a
          className="session-link"
          href={`/sessions/${encodeURIComponent(session.id)}`}
          onClick={(event) => {
            event.preventDefault();
            autoScrollRef.current = true;
            navigateToSession(session.id);
            setMobileSessionsOpen(false);
          }}
        >
          {session.title}
        </a>
        {owned && (
          <span className="session-actions">
            <button
              type="button"
              className={`session-action favorite${session.favorite ? " active" : ""}`}
              aria-label={`${session.favorite ? "取消收藏" : "收藏"} ${session.title}`}
              aria-pressed={Boolean(session.favorite)}
              title={session.favorite ? "取消收藏" : "收藏"}
              disabled={favoriteUpdatingId === session.id}
              onClick={(event) => {
                event.stopPropagation();
                void toggleSessionFavorite(session);
              }}
            >
              <FontAwesomeIcon icon={faStar} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="session-action delete"
              aria-label={`删除 ${session.title}`}
              title="删除"
              onClick={async (event) => {
                event.stopPropagation();
                await api("/sessions/" + session.id, { method: "DELETE" });
                if (active === session.id) {
                  navigateToSession("", true);
                  setMessages([]);
                }
                await load();
              }}
            >
              <FontAwesomeIcon icon={faTrashCan} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
    );
  };
  return (
    <div
      className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${openWorkspaceFiles.length ? " workspace-open" : ""}`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--workspace-width": `${workspaceWidth}px`,
        } as React.CSSProperties
      }
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
          <div className="brand sidebar-brand" title={appName}>
            <span className="sidebar-brand-mark" aria-hidden="true">
              ✦
            </span>
            <span className="sidebar-brand-name">{appName}</span>
          </div>
          <button
            type="button"
            className="sidebar-collapse"
            title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <FontAwesomeIcon
              icon={sidebarCollapsed ? faAnglesRight : faAnglesLeft}
            />
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
        <button className="new" title="新对话" onClick={create}>
          <span className="new-icon" aria-hidden="true">
            +
          </span>
          <span className="new-label">新对话</span>
        </button>
        <div className="sidebar-tabs" role="tablist" aria-label="侧栏内容">
          <button
            type="button"
            role="tab"
            aria-selected={sidebarView === "sessions"}
            className={sidebarView === "sessions" ? "active" : ""}
            title="对话"
            onClick={() => {
              setSidebarView("sessions");
              setSidebarCollapsed(false);
            }}
          >
            <FontAwesomeIcon icon={faComments} aria-hidden="true" />
            <span className="sidebar-tab-label">对话</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sidebarView === "files"}
            className={sidebarView === "files" ? "active" : ""}
            title="文件"
            onPointerEnter={() => void loadWorkspaceEditor()}
            onClick={showWorkspaceFiles}
          >
            <FontAwesomeIcon icon={faFolderTree} aria-hidden="true" />
            <span className="sidebar-tab-label">文件</span>
          </button>
        </div>
        {sidebarView === "sessions" ? (
          <nav aria-label="历史对话">
            {me.isRoot
              ? sessionGroups.map(([username, userSessions]) => (
                  <details
                    className="root-session-group"
                    key={username}
                    open={expandedRootUsers.has(username)}
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setExpandedRootUsers((current) => {
                        const next = new Set(current);
                        if (open) next.add(username);
                        else next.delete(username);
                        return next;
                      });
                    }}
                  >
                    <summary>
                      <span className="root-session-chevron" aria-hidden="true">
                        &gt;
                      </span>
                      <FontAwesomeIcon icon={faFolder} aria-hidden="true" />
                      <span>{username}</span>
                      <small>{userSessions.length}</small>
                    </summary>
                    <div className="root-session-list">
                      {userSessions.map(renderSession)}
                    </div>
                  </details>
                ))
              : sessions.map(renderSession)}
          </nav>
        ) : (
          <div
            className={`workspace-browser${draggingWorkspaceFiles ? " dragging-files" : ""}`}
            role="tabpanel"
            onContextMenu={(event) => {
              event.preventDefault();
              setFileContextMenu({ x: event.clientX, y: event.clientY });
            }}
            onDragEnter={(event) => {
              if (!Array.from(event.dataTransfer.types).includes("Files"))
                return;
              event.preventDefault();
              setDraggingWorkspaceFiles(true);
              setWorkspaceDropDirectory("");
            }}
            onDragOver={(event) => {
              if (!Array.from(event.dataTransfer.types).includes("Files"))
                return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              if (event.target === event.currentTarget)
                setWorkspaceDropDirectory("");
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setDraggingWorkspaceFiles(false);
                setWorkspaceDropDirectory(null);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              void uploadWorkspaceFiles(
                event.dataTransfer.files,
                workspaceDropDirectory || "",
              );
            }}
          >
            <input
              ref={workspaceFileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) =>
                void uploadWorkspaceFiles(
                  event.target.files,
                  workspaceUploadDirectory,
                )
              }
            />
            <div className="workspace-browser-heading">
              <span title={me.username}>
                {me.isRoot ? "~/workspaces" : `~/${me.username}`}
              </span>
              <button
                type="button"
                title="刷新文件目录"
                aria-label="刷新文件目录"
                onClick={() => {
                  void loadWorkspaceFiles(true);
                }}
              >
                ↻
              </button>
            </div>
            {uploadTarget === "workspace" && uploadProgress != null && (
              <div className="workspace-upload-progress" role="status">
                <span title={uploadLabel}>{uploadLabel}</span>
                <b>{uploadProgress}%</b>
                <div className="upload-progress-track">
                  <i style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
            )}
            {workspaceFilesLoading &&
            !workspaceFilesLoaded &&
            !workspaceFiles.length &&
            !workspaceDirectories.length ? (
              <div className="workspace-browser-empty">正在读取文件目录…</div>
            ) : workspaceFiles.length ||
              workspaceDirectories.length ||
              pendingWorkspaceEntry ? (
              <WorkspaceFileTree
                files={workspaceFiles}
                directories={workspaceDirectories}
                pendingEntry={pendingWorkspaceEntry}
                pendingRename={pendingWorkspaceRename}
                entrySaving={workspaceNameSaving}
                entryError={workspaceNameError}
                renameSaving={workspaceRenameSaving}
                renameError={workspaceRenameError}
                clipboard={fileClipboard}
                dropDirectory={workspaceDropDirectory}
                activePath={activeWorkspacePath}
                onOpenFile={(file) => void openWorkspaceFile(file)}
                onCreateEntry={(name) => void createWorkspaceEntry(name)}
                onCancelEntry={() => {
                  setPendingWorkspaceEntry(null);
                  setWorkspaceNameError("");
                }}
                onRename={(name) => void renameWorkspaceFile(name)}
                onCancelRename={() => {
                  setPendingWorkspaceRename(null);
                  setWorkspaceRenameError("");
                }}
                onContextMenu={(event, file) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setFileContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    file,
                  });
                }}
                onDirectoryContextMenu={(event, directory) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setFileContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    directory,
                  });
                }}
                onDropTarget={(event, directory) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "copy";
                  setDraggingWorkspaceFiles(true);
                  setWorkspaceDropDirectory(directory);
                }}
                onDropFiles={(event, directory) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void uploadWorkspaceFiles(
                    event.dataTransfer.files,
                    directory,
                  );
                }}
              />
            ) : (
              <div className="workspace-browser-empty">工作区暂无文件</div>
            )}
            {draggingWorkspaceFiles && uploadTarget !== "workspace" && (
              <div className="workspace-drop-overlay">
                上传到 {workspaceDropDirectory || "工作区根目录"}
              </div>
            )}
          </div>
        )}
        {me.isRoot && showApprovalPanel && (
          <section
            ref={approvalPanelRef}
            className="root-approval-panel"
            aria-label="注册审批"
          >
            <header>
              <div>
                <b>Messages</b>
                <small>注册审批与历史记录</small>
              </div>
              <button
                type="button"
                aria-label="关闭注册审批"
                onClick={() => setShowApprovalPanel(false)}
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </header>
            <div className="root-approval-list">
              {pendingRegistrations.length ? (
                pendingRegistrations.map((registration) => (
                  <article key={registration.id}>
                    <span className="approval-user-icon" aria-hidden="true">
                      {Array.from(registration.username)[0]?.toUpperCase() ||
                        "U"}
                    </span>
                    <div>
                      <b>{registration.username}</b>
                      <span>{registration.email}</span>
                      <small>
                        {new Date(registration.created_at).toLocaleString()}
                      </small>
                    </div>
                    {registration.approval_status === "pending" ? (
                      <footer>
                        <button
                          type="button"
                          className="reject"
                          disabled={approvalUpdatingId === registration.id}
                          onClick={() =>
                            void reviewRegistration(registration.id, false)
                          }
                        >
                          拒绝
                        </button>
                        <button
                          type="button"
                          className="approve"
                          disabled={approvalUpdatingId === registration.id}
                          onClick={() =>
                            void reviewRegistration(registration.id, true)
                          }
                        >
                          通过
                        </button>
                      </footer>
                    ) : (
                      <footer className="approval-history">
                        <span className={registration.approval_status}>
                          {registration.approval_status === "approved"
                            ? "已通过"
                            : "已拒绝"}
                        </span>
                        {registration.reviewed_at && (
                          <time dateTime={registration.reviewed_at}>
                            {new Date(
                              registration.reviewed_at,
                            ).toLocaleString()}
                          </time>
                        )}
                      </footer>
                    )}
                  </article>
                ))
              ) : (
                <div className="root-approval-empty">暂无审批记录</div>
              )}
            </div>
          </section>
        )}
        {accountPanel && (
          <section
            ref={accountPanelRef}
            className="account-side-panel"
            aria-label="账户设置"
          >
            <header>
              <b>
                {accountPanel === "profile"
                  ? "个人资料"
                  : accountPanel === "users"
                    ? "用户资料"
                    : "修改密码"}
              </b>
              <button
                type="button"
                aria-label="关闭账户设置"
                onClick={() => setAccountPanel(null)}
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </header>
            {accountPanel === "profile" && (
              <div className="account-profile">
                <span className="account-profile-icon">{userInitial}</span>
                <dl>
                  <div>
                    <dt>用户名</dt>
                    <dd>{me.username}</dd>
                  </div>
                  <div>
                    <dt>邮箱</dt>
                    <dd>{me.email}</dd>
                  </div>
                  <div>
                    <dt>角色</dt>
                    <dd>{me.isRoot ? "Root 管理员" : "普通用户"}</dd>
                  </div>
                  <div>
                    <dt>注册时间</dt>
                    <dd>{new Date(me.created_at).toLocaleString()}</dd>
                  </div>
                </dl>
              </div>
            )}
            {accountPanel === "users" && (
              <div className="account-users-list">
                {adminUsers.map((user) => (
                  <article key={user.id}>
                    <button
                      type="button"
                      className="account-user-summary"
                      aria-expanded={selectedAdminUserId === user.id}
                      onClick={() => setSelectedAdminUserId(user.id)}
                    >
                      <span>{Array.from(user.username)[0]?.toUpperCase()}</span>
                      <b>{user.username}</b>
                      <FontAwesomeIcon icon={faChevronUp} rotation={90} />
                    </button>
                  </article>
                ))}
              </div>
            )}
            {accountPanel === "password" && (
              <form className="account-password-form" onSubmit={changePassword}>
                <label>
                  新密码
                  <input
                    type="password"
                    value={newPassword}
                    minLength={8}
                    onChange={(event) => setNewPassword(event.target.value)}
                    required
                  />
                </label>
                {accountNotice && <p>{accountNotice}</p>}
                <button disabled={passwordSaving}>
                  {passwordSaving ? "保存中…" : "保存新密码"}
                </button>
              </form>
            )}
          </section>
        )}
        {accountPanel === "users" &&
          selectedAdminUserId &&
          (() => {
            const user = adminUsers.find(
              (item) => item.id === selectedAdminUserId,
            );
            if (!user) return null;
            return (
              <section
                ref={adminUserPopoverRef}
                className="account-user-popover"
                aria-label={`${user.username} 用户详情`}
              >
                <header>
                  <div>
                    <span>
                      {Array.from(user.username)[0]?.toUpperCase() || "U"}
                    </span>
                    <b>{user.username}</b>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭用户详情"
                    onClick={() => setSelectedAdminUserId("")}
                  >
                    <FontAwesomeIcon icon={faXmark} />
                  </button>
                </header>
                <dl className="account-user-details">
                  <div>
                    <dt>邮箱</dt>
                    <dd>{user.email}</dd>
                  </div>
                  <div>
                    <dt>账号状态</dt>
                    <dd>
                      {user.approved
                        ? "正常"
                        : user.approval_status === "rejected"
                          ? "已拒绝"
                          : "待审批"}
                    </dd>
                  </div>
                  <div>
                    <dt>注册时间</dt>
                    <dd>{new Date(user.created_at).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>密码</dt>
                    <dd>••••••••（bcrypt 加密，无法查看明文）</dd>
                  </div>
                </dl>
              </section>
            );
          })()}
        {accountMenuOpen && (
          <div
            ref={accountMenuRef}
            className="sidebar-account-menu"
            role="menu"
          >
            <button
              type="button"
              onClick={() => void openAccountPanel("profile")}
            >
              <FontAwesomeIcon icon={faUser} />
              个人资料
            </button>
            {me.isRoot && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    setAccountPanel(null);
                    setSelectedAdminUserId("");
                    setShowApprovalPanel(true);
                    void refreshPendingRegistrations().catch(() => undefined);
                  }}
                >
                  <FontAwesomeIcon icon={faEnvelope} />
                  Messages
                  {pendingRegistrationCount > 0 && (
                    <span>{pendingRegistrationCount}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void openAccountPanel("users")}
                >
                  <FontAwesomeIcon icon={faUsers} />
                  用户资料
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void openAccountPanel("password")}
            >
              <FontAwesomeIcon icon={faKey} />
              修改密码
            </button>
            <button
              type="button"
              className="logout"
              onClick={async () => {
                await api("/auth/logout", { method: "POST" });
                window.history.replaceState(null, "", "/");
                location.reload();
              }}
            >
              <FontAwesomeIcon icon={faRightFromBracket} />
              退出登录
            </button>
          </div>
        )}
        <footer>
          <button
            ref={accountTriggerRef}
            type="button"
            className="sidebar-account-trigger"
            title={me.email}
            aria-label={`当前用户 ${me.username}`}
            aria-expanded={accountMenuOpen}
            onClick={() => {
              setSidebarCollapsed(false);
              setAccountPanel(null);
              setShowApprovalPanel(false);
              setSelectedAdminUserId("");
              setAccountMenuOpen((open) => !open);
            }}
          >
            <span className="sidebar-user-icon" aria-hidden="true">
              {userInitial}
            </span>
            <span className="sidebar-user-name">{me.username}</span>
            {me.isRoot && pendingRegistrationCount > 0 && (
              <span className="sidebar-account-badge">
                {pendingRegistrationCount}
              </span>
            )}
            <FontAwesomeIcon
              className="sidebar-account-chevron"
              icon={faChevronUp}
            />
          </button>
        </footer>
      </aside>
      {!sidebarCollapsed && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="调整侧边栏宽度"
          aria-orientation="vertical"
          aria-valuemin={180}
          aria-valuemax={520}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onDoubleClick={() => {
            const next = defaultSidebarWidth();
            setSidebarWidth(next);
            localStorage.setItem("claude-ui-sidebar-width", String(next));
          }}
          onPointerDown={(event) => {
            resizingSidebarRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.classList.add("resizing-sidebar");
          }}
          onPointerMove={(event) => {
            if (!resizingSidebarRef.current) return;
            const maximum = Math.min(520, window.innerWidth - 360);
            setSidebarWidth(Math.max(180, Math.min(maximum, event.clientX)));
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
                180,
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
      {openWorkspaceFiles.length > 0 && (
        <Suspense
          fallback={
            <div className="workspace-editor-loading">正在加载编辑器…</div>
          }
        >
          <WorkspaceEditor
            files={openWorkspaceFiles}
            activePath={activeWorkspacePath}
            savingPath={savingWorkspacePath}
            onActivate={setActiveWorkspacePath}
            onChange={updateWorkspaceFile}
            onSave={(filePath) => void saveWorkspaceFile(filePath)}
            onClose={closeWorkspaceFile}
            onOpenSidebar={() => setMobileSessionsOpen(true)}
          />
        </Suspense>
      )}
      {openWorkspaceFiles.length > 0 && (
        <div
          className="workspace-resizer"
          role="separator"
          aria-label="调整 Workspace 和对话区域宽度"
          aria-orientation="vertical"
          tabIndex={0}
          onDoubleClick={() => {
            const next = defaultWorkspaceWidth();
            setWorkspaceWidth(next);
            localStorage.setItem("claude-ui-workspace-width", String(next));
          }}
          onPointerDown={(event) => {
            resizingWorkspaceRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.classList.add("resizing-workspace");
          }}
          onPointerMove={(event) => {
            if (!resizingWorkspaceRef.current) return;
            const sidebarOffset = sidebarCollapsed
              ? DESKTOP_SIDEBAR_RAIL_WIDTH
              : sidebarWidth;
            setWorkspaceWidth(
              Math.max(
                360,
                Math.min(
                  window.innerWidth - sidebarOffset - 280,
                  event.clientX - sidebarOffset,
                ),
              ),
            );
          }}
          onPointerUp={(event) => {
            resizingWorkspaceRef.current = false;
            event.currentTarget.releasePointerCapture(event.pointerId);
            document.body.classList.remove("resizing-workspace");
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setWorkspaceWidth((current) =>
              Math.max(360, current + (event.key === "ArrowRight" ? 20 : -20)),
            );
          }}
        />
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
          <div className="chat-heading">
            {sessions.find((s) => s.id === active)?.title || "新对话"}
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
            const isNearBottom = distanceFromBottom < 96;
            autoScrollRef.current = isNearBottom;
            setShowScrollToBottom(!isNearBottom);
          }}
        >
          {messages.length === 0 && (
            <div className="empty">
              <b>今天想构建什么？</b>
              <span>
                直接描述你的任务，CloudInk
                可以读取、编辑并运行独立工作区中的代码。
              </span>
            </div>
          )}
          {messages.map((m, i) => {
            if (m.role === "activity") {
              const activity = parseActivity(m) || {
                kind: "status" as const,
                label: m.content,
              };
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
            const messageKey = m.id || `${m.role}-${i}`;
            const streamingThisMessage =
              m.role === "assistant" && busy && i === messages.length - 1;
            return (
              <article className={m.role} key={m.id || i}>
                <div className="bubble">
                  {m.role === "assistant" ? (
                    <ReactMarkdown
                      streaming={busy && i === messages.length - 1}
                      workspacePaths={workspaceFiles.map((file) => file.path)}
                      onOpenWorkspaceFile={openWorkspacePath}
                    >
                      {m.content || "▍"}
                    </ReactMarkdown>
                  ) : (
                    <WorkspaceMentionText
                      workspacePaths={workspaceFiles.map((file) => file.path)}
                      onOpenWorkspaceFile={openWorkspacePath}
                    >
                      {m.content}
                    </WorkspaceMentionText>
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
                          disabled={busy || viewingForeignSession}
                          onClick={() => retryResponse(i)}
                        >
                          <FontAwesomeIcon icon={faRotateRight} />
                          <span>重试</span>
                        </button>
                        {m.created_at && <MessageTime value={m.created_at} />}
                      </div>
                    )}
                </div>
                {m.role === "user" && (
                  <div className="response-actions user-message-actions">
                    <button
                      type="button"
                      title="复制消息"
                      aria-label="复制消息"
                      onClick={() => void copyResponse(m.content, messageKey)}
                    >
                      <FontAwesomeIcon
                        icon={copiedMessageId === messageKey ? faCheck : faCopy}
                      />
                      <span>
                        {copiedMessageId === messageKey ? "已复制" : "复制"}
                      </span>
                    </button>
                    {m.created_at && <MessageTime value={m.created_at} />}
                  </div>
                )}
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
          {showScrollToBottom && (
            <button
              type="button"
              className="scroll-to-bottom"
              aria-label="跳转到最新消息"
              title="跳转到最新消息"
              onClick={scrollMessagesToBottom}
            >
              <FontAwesomeIcon icon={faArrowDown} />
            </button>
          )}
          {draggingFiles && uploadTarget !== "composer" && (
            <div className="composer-drop-overlay" aria-hidden="true">
              <FontAwesomeIcon icon={faCloudArrowUp} />
              <b>松开以上传</b>
              <span>支持文件和图片，单个最大 500MB</span>
            </div>
          )}
          {uploadTarget === "composer" && uploadProgress != null && (
            <div className="composer-upload-progress" role="status">
              <span
                className="upload-progress-ring"
                style={
                  { "--upload-progress": uploadProgress } as React.CSSProperties
                }
                aria-label={`上传进度 ${uploadProgress}%`}
              >
                <i>{uploadProgress}</i>
              </span>
              <span className="composer-upload-copy">
                <b title={uploadLabel}>{uploadLabel}</b>
                <small>正在上传到工作区</small>
              </span>
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
                <small>控制工具调用和文件修改方式</small>
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
            <div
              className="slash-menu"
              ref={slashMenuRef}
              role="listbox"
              id="composer-slash-menu"
              aria-label="Commands 和 Skills"
            >
              {filteredCommands.length > 0 && (
                <div className="slash-menu-heading">
                  <span>Commands</span>
                  <small>管理当前会话和上下文</small>
                </div>
              )}
              {filteredCommands.map((command, index) => (
                <button
                  type="button"
                  role="option"
                  id={`slash-option-${index}`}
                  aria-selected={slashSelectedIndex === index}
                  data-menu-index={index}
                  className={
                    slashSelectedIndex === index ? "keyboard-active" : ""
                  }
                  key={command.name}
                  onMouseEnter={() => setSlashSelectedIndex(index)}
                  onClick={() => insertSlashCommand(command.name)}
                >
                  <code>{command.name}</code>
                  <span>{command.description}</span>
                </button>
              ))}
              {filteredSkills.length > 0 && (
                <div className="slash-menu-heading">
                  <span>Skills</span>
                  <small>调用专业工作流</small>
                </div>
              )}
              {filteredSkills.map((skill, index) => {
                const menuIndex = filteredCommands.length + index;
                return (
                  <button
                    type="button"
                    role="option"
                    id={`slash-option-${menuIndex}`}
                    aria-selected={slashSelectedIndex === menuIndex}
                    data-menu-index={menuIndex}
                    className={
                      slashSelectedIndex === menuIndex ? "keyboard-active" : ""
                    }
                    key={skill.name}
                    onMouseEnter={() => setSlashSelectedIndex(menuIndex)}
                    onClick={() => insertSlashCommand(skill.name)}
                  >
                    <code>{skill.name}</code>
                    <span>{skill.description}</span>
                  </button>
                );
              })}
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
            <div
              className="mention-menu"
              role="listbox"
              id="composer-mention-menu"
              aria-label="工作区文件"
            >
              <div className="mention-menu-heading">
                <span>工作区文件</span>
                <small>输入文件名或路径进行搜索</small>
              </div>
              {workspaceFilesLoading ? (
                <div className="mention-empty">正在读取工作区…</div>
              ) : filteredWorkspaceFiles.length ? (
                filteredWorkspaceFiles.map((file, index) => (
                  <button
                    type="button"
                    role="option"
                    id={`mention-option-${index}`}
                    aria-selected={mentionSelectedIndex === index}
                    data-menu-index={index}
                    className={
                      mentionSelectedIndex === index ? "keyboard-active" : ""
                    }
                    key={file.path}
                    title={file.path}
                    onMouseEnter={() => setMentionSelectedIndex(index)}
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
          {attachments.length > 0 && (
            <div className="attachment-list" aria-label="已上传附件">
              {attachments.map((attachment) => {
                const image = IMAGE_ATTACHMENT_PATTERN.test(attachment.name);
                return (
                  <div
                    className={`attachment-chip${image ? " image" : ""}`}
                    key={attachment.path}
                    title={attachment.name}
                  >
                    {image ? (
                      <img
                        src={workspacePreviewUrl(
                          attachment.path,
                          me.isRoot ? me.username : "",
                        )}
                        alt={attachment.name}
                      />
                    ) : (
                      <span className="attachment-file-icon">📎</span>
                    )}
                    <span className="attachment-name">{attachment.name}</span>
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
                  </div>
                );
              })}
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
                if (hasSlash && !showSlashMenu) void refreshSlashItems();
                if (hasSlash || hasMention) setShowModeMenu(false);
                if (hasSlash) setShowMentionMenu(false);
                if (hasMention) setShowSlashMenu(false);
              }}
              onKeyDown={(e) => {
                const menuItems = showSlashMenu
                  ? slashMenuItems
                  : showMentionMenu
                    ? filteredWorkspaceFiles
                    : [];
                if (
                  (showSlashMenu || showMentionMenu) &&
                  (e.key === "ArrowDown" || e.key === "ArrowUp")
                ) {
                  e.preventDefault();
                  if (!menuItems.length) return;
                  const direction = e.key === "ArrowDown" ? 1 : -1;
                  if (showSlashMenu)
                    setSlashSelectedIndex(
                      (current) =>
                        (current + direction + menuItems.length) %
                        menuItems.length,
                    );
                  else
                    setMentionSelectedIndex(
                      (current) =>
                        (current + direction + menuItems.length) %
                        menuItems.length,
                    );
                  return;
                }
                if (
                  e.key === "Enter" &&
                  !e.nativeEvent.isComposing &&
                  (showSlashMenu || showMentionMenu)
                ) {
                  e.preventDefault();
                  if (!menuItems.length) return;
                  if (showSlashMenu) {
                    const item = slashMenuItems[slashSelectedIndex];
                    if (item) insertSlashCommand(item.name);
                  } else {
                    const file = filteredWorkspaceFiles[mentionSelectedIndex];
                    if (file) insertFileMention(file);
                  }
                  return;
                }
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
              placeholder={
                viewingForeignSession
                  ? `正在查看 ${activeSession?.username} 的历史会话（只读）`
                  : "向 CloudInk 描述任务…"
              }
              disabled={viewingForeignSession}
            />
          </div>
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
                disabled={
                  viewingForeignSession ||
                  busy ||
                  uploading ||
                  attachments.length >= 10
                }
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
                disabled={viewingForeignSession || busy}
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
                disabled={viewingForeignSession || busy}
                aria-label="CloudInk 执行模式"
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
                  viewingForeignSession ||
                  uploading ||
                  (!busy && !input.trim() && !attachments.length)
                }
                aria-label={busy ? "中止回答" : "发送消息"}
                title={busy ? "中止回答" : "发送消息"}
                onClick={busy ? () => void stopResponse() : undefined}
              >
                {busy ? <span className="stop-icon" /> : "↑"}
              </button>
            </div>
          </div>
        </form>
      </section>
      {workspaceNotice && (
        <div className="workspace-notice" role="status" aria-live="polite">
          {workspaceNotice}
        </div>
      )}
      {fileContextMenu && (
        <div
          className="file-context-menu"
          role="menu"
          style={{
            left: Math.min(fileContextMenu.x, window.innerWidth - 200),
            top: Math.min(fileContextMenu.y, window.innerHeight - 360),
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setFileContextMenu(null)}
        >
          {fileContextMenu.file ? (
            <>
              <button
                role="menuitem"
                onClick={() => void openWorkspaceFile(fileContextMenu.file!)}
              >
                Open
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  beginWorkspaceRename({
                    ...fileContextMenu.file!,
                    kind: "file",
                  })
                }
              >
                Rename
              </button>
              <button
                role="menuitem"
                className="danger"
                onClick={() =>
                  void deleteWorkspaceEntry({
                    path: fileContextMenu.file!.path,
                    kind: "file",
                  })
                }
              >
                Delete
              </button>
              <hr />
              <button
                role="menuitem"
                onClick={() =>
                  setFileClipboard({
                    file: fileContextMenu.file!,
                    operation: "cut",
                  })
                }
              >
                Cut
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  setFileClipboard({
                    file: fileContextMenu.file!,
                    operation: "copy",
                  })
                }
              >
                Copy
              </button>
              <button
                role="menuitem"
                disabled={!fileClipboard}
                onClick={() =>
                  void pasteWorkspaceFile(
                    fileContextMenu
                      .file!.path.split("/")
                      .slice(0, -1)
                      .join("/"),
                  )
                }
              >
                Paste
              </button>
              <a
                role="menuitem"
                href={`/api/workspace/download?path=${encodeURIComponent(fileContextMenu.file.path)}`}
                download
              >
                Download
              </a>
              {/\.html?$/i.test(fileContextMenu.file.path) && (
                <>
                  <hr />
                  {publishedPages[fileContextMenu.file.path] ? (
                    <>
                      <button
                        role="menuitem"
                        onClick={() =>
                          void copyPublishedPageLink(fileContextMenu.file!)
                        }
                      >
                        Copy published link
                      </button>
                      <a
                        role="menuitem"
                        href={publishedPages[fileContextMenu.file.path]}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open published page
                      </a>
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={() =>
                          void unpublishWorkspacePage(fileContextMenu.file!)
                        }
                      >
                        Unpublish
                      </button>
                    </>
                  ) : (
                    <button
                      role="menuitem"
                      onClick={() =>
                        void publishWorkspacePage({
                          path: fileContextMenu.file!.path,
                          kind: "file",
                        })
                      }
                    >
                      Publish webpage
                    </button>
                  )}
                </>
              )}
              <hr />
              <button
                role="menuitem"
                onClick={() =>
                  setPendingWorkspaceEntry({
                    kind: "file",
                    directory: fileContextMenu
                      .file!.path.split("/")
                      .slice(0, -1)
                      .join("/"),
                  })
                }
              >
                New File
              </button>
            </>
          ) : (
            <>
              {fileContextMenu.directory && (
                <>
                  <button
                    role="menuitem"
                    onClick={() =>
                      beginWorkspaceRename({
                        path: fileContextMenu.directory!,
                        name: fileContextMenu.directory!.split("/").pop()!,
                        kind: "folder",
                      })
                    }
                  >
                    Rename
                  </button>
                  <button
                    role="menuitem"
                    className="danger"
                    onClick={() =>
                      void deleteWorkspaceEntry({
                        path: fileContextMenu.directory!,
                        kind: "folder",
                      })
                    }
                  >
                    Delete
                  </button>
                  {publishedPages[fileContextMenu.directory] ? (
                    <>
                      <button
                        role="menuitem"
                        onClick={() =>
                          void copyPublishedPageLink({
                            path: fileContextMenu.directory!,
                          })
                        }
                      >
                        Copy published link
                      </button>
                      <a
                        role="menuitem"
                        href={publishedPages[fileContextMenu.directory]}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open published site
                      </a>
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={() =>
                          void unpublishWorkspacePage({
                            path: fileContextMenu.directory!,
                          })
                        }
                      >
                        Unpublish
                      </button>
                    </>
                  ) : (
                    <button
                      role="menuitem"
                      onClick={() =>
                        void publishWorkspacePage({
                          path: fileContextMenu.directory!,
                          kind: "folder",
                        })
                      }
                    >
                      Publish folder as website
                    </button>
                  )}
                  <hr />
                </>
              )}
              <button
                role="menuitem"
                disabled={!fileClipboard}
                onClick={() =>
                  void pasteWorkspaceFile(fileContextMenu.directory || "")
                }
              >
                Paste
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  setPendingWorkspaceEntry({
                    kind: "file",
                    directory: fileContextMenu.directory || "",
                  })
                }
              >
                New File
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  setPendingWorkspaceEntry({
                    kind: "folder",
                    directory: fileContextMenu.directory || "",
                  })
                }
              >
                New Folder
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setWorkspaceUploadDirectory(fileContextMenu.directory || "");
                  requestAnimationFrame(() =>
                    workspaceFileInputRef.current?.click(),
                  );
                }}
              >
                Upload
              </button>
            </>
          )}
        </div>
      )}
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
    <section className="submit-answer-panel" aria-label="CloudInk 需要你的回答">
      <header>
        <div>
          <span className="answer-status-dot" aria-hidden="true" />
          <b>CloudInk needs your input</b>
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
          {busy ? "等待 CloudInk 完成当前步骤…" : "提交后将继续当前会话"}
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

function MessageTime({ value }: { value: string }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time
      className="message-time"
      dateTime={value}
      title={date.toLocaleString("zh-CN")}
    >
      {date
        .toLocaleString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
        .replaceAll("/", "-")}
    </time>
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

function buildFileTree(
  files: WorkspaceFile[],
  directories: string[],
): FileTreeNode {
  const root: FileTreeNode = {
    name: "",
    path: "",
    directories: [],
    files: [],
  };
  const ensureDirectory = (directoryPath: string) => {
    const parts = directoryPath.split("/").filter(Boolean);
    let node = root;
    for (const part of parts) {
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
    return node;
  };
  directories.forEach(ensureDirectory);
  for (const file of files) {
    const parts = file.path.split("/");
    const node = ensureDirectory(parts.slice(0, -1).join("/"));
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

function WorkspaceFileTree({
  files,
  directories,
  pendingEntry,
  pendingRename,
  entrySaving,
  entryError,
  renameSaving,
  renameError,
  clipboard,
  dropDirectory,
  activePath,
  onOpenFile,
  onCreateEntry,
  onCancelEntry,
  onRename,
  onCancelRename,
  onContextMenu,
  onDirectoryContextMenu,
  onDropTarget,
  onDropFiles,
}: {
  files: WorkspaceFile[];
  directories: string[];
  pendingEntry: PendingWorkspaceEntry | null;
  pendingRename: WorkspaceRenameTarget | null;
  entrySaving: boolean;
  entryError: string;
  renameSaving: boolean;
  renameError: string;
  clipboard: FileClipboard | null;
  dropDirectory: string | null;
  activePath: string;
  onOpenFile: (file: WorkspaceFile) => void;
  onCreateEntry: (name: string) => void;
  onCancelEntry: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onContextMenu: (event: React.MouseEvent, file: WorkspaceFile) => void;
  onDirectoryContextMenu: (event: React.MouseEvent, directory: string) => void;
  onDropTarget: (event: React.DragEvent, directory: string) => void;
  onDropFiles: (event: React.DragEvent, directory: string) => void;
}) {
  const root = buildFileTree(files, directories);
  const treeRef = useRef<HTMLDivElement>(null);
  const itemPositionsRef = useRef<Map<string, DOMRect>>(new Map());
  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const previousPositions = itemPositionsRef.current;
    const nextPositions = new Map<string, DOMRect>();
    tree
      .querySelectorAll<HTMLElement>("[data-workspace-tree-path]")
      .forEach((item) => {
        const path = item.dataset.workspaceTreePath;
        if (!path) return;
        const nextPosition = item.getBoundingClientRect();
        nextPositions.set(path, nextPosition);
        if (reduceMotion || !nextPosition.width || !nextPosition.height) return;
        const previousPosition = previousPositions.get(path);
        if (!previousPosition) {
          if (previousPositions.size)
            item.animate(
              [
                { opacity: 0, transform: "translateY(-5px)" },
                { opacity: 1, transform: "translateY(0)" },
              ],
              { duration: 180, easing: "ease-out" },
            );
          return;
        }
        const offset = previousPosition.top - nextPosition.top;
        if (Math.abs(offset) < 1) return;
        item.animate(
          [
            { transform: `translateY(${offset}px)` },
            { transform: "translateY(0)" },
          ],
          { duration: 190, easing: "cubic-bezier(0.2, 0.75, 0.25, 1)" },
        );
      });
    itemPositionsRef.current = nextPositions;
  }, [files, directories]);
  return (
    <div className="file-tree" ref={treeRef}>
      {pendingEntry?.directory === "" && (
        <WorkspaceNewEntry
          entry={pendingEntry}
          onCreate={onCreateEntry}
          onCancel={onCancelEntry}
          saving={entrySaving}
          error={entryError}
        />
      )}
      {root.directories.map((directory) => (
        <WorkspaceDirectory
          key={directory.path}
          node={directory}
          activePath={activePath}
          pendingEntry={pendingEntry}
          pendingRename={pendingRename}
          entrySaving={entrySaving}
          entryError={entryError}
          renameSaving={renameSaving}
          renameError={renameError}
          clipboard={clipboard}
          dropDirectory={dropDirectory}
          onOpenFile={onOpenFile}
          onCreateEntry={onCreateEntry}
          onCancelEntry={onCancelEntry}
          onRename={onRename}
          onCancelRename={onCancelRename}
          onContextMenu={onContextMenu}
          onDirectoryContextMenu={onDirectoryContextMenu}
          onDropTarget={onDropTarget}
          onDropFiles={onDropFiles}
        />
      ))}
      {root.files.map((file) => (
        <WorkspaceFileRow
          key={file.path}
          file={file}
          active={file.path === activePath}
          renaming={pendingRename?.path === file.path}
          clipboardOperation={
            clipboard?.file.path === file.path ? clipboard.operation : null
          }
          onOpenFile={onOpenFile}
          onRename={onRename}
          onCancelRename={onCancelRename}
          nameSaving={renameSaving}
          nameError={renameError}
          onContextMenu={onContextMenu}
          onDropTarget={onDropTarget}
          onDropFiles={onDropFiles}
        />
      ))}
    </div>
  );
}

function WorkspaceNewEntry({
  entry,
  onCreate,
  onCancel,
  saving,
  error,
}: {
  entry: PendingWorkspaceEntry;
  onCreate: (name: string) => void;
  onCancel: () => void;
  saving: boolean;
  error: string;
}) {
  const [name, setName] = useState("");
  return (
    <div className="workspace-entry-wrap">
      <div
        className="workspace-new-entry"
        title={
          entry.directory ? `创建于 ${entry.directory}` : "创建于工作区根目录"
        }
      >
        <span className="workspace-file-icon" aria-hidden="true">
          <FontAwesomeIcon icon={entry.kind === "folder" ? faFolder : faFile} />
        </span>
        <input
          autoFocus
          disabled={saving}
          value={name}
          aria-label={entry.kind === "folder" ? "新文件夹名称" : "新文件名称"}
          placeholder={entry.kind === "folder" ? "文件夹名称" : "文件名称"}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            } else if (event.key === "Enter") {
              event.preventDefault();
              onCreate(name);
            }
          }}
        />
        <span className="workspace-entry-actions">
          <button
            type="button"
            disabled={saving}
            aria-label="保存名称"
            onClick={() => onCreate(name)}
          >
            <FontAwesomeIcon icon={faCheck} />
          </button>
          <button
            type="button"
            disabled={saving}
            aria-label="取消命名"
            onClick={onCancel}
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </span>
      </div>
      {saving ? (
        <small className="workspace-entry-status">正在创建…</small>
      ) : (
        error && <small className="workspace-entry-error">{error}</small>
      )}
    </div>
  );
}

function WorkspaceDirectory({
  node,
  activePath,
  pendingEntry,
  pendingRename,
  entrySaving,
  entryError,
  renameSaving,
  renameError,
  clipboard,
  dropDirectory,
  onOpenFile,
  onCreateEntry,
  onCancelEntry,
  onRename,
  onCancelRename,
  onContextMenu,
  onDirectoryContextMenu,
  onDropTarget,
  onDropFiles,
}: {
  node: FileTreeNode;
  activePath: string;
  pendingEntry: PendingWorkspaceEntry | null;
  pendingRename: WorkspaceRenameTarget | null;
  entrySaving: boolean;
  entryError: string;
  renameSaving: boolean;
  renameError: string;
  clipboard: FileClipboard | null;
  dropDirectory: string | null;
  onOpenFile: (file: WorkspaceFile) => void;
  onCreateEntry: (name: string) => void;
  onCancelEntry: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onContextMenu: (event: React.MouseEvent, file: WorkspaceFile) => void;
  onDirectoryContextMenu: (event: React.MouseEvent, directory: string) => void;
  onDropTarget: (event: React.DragEvent, directory: string) => void;
  onDropFiles: (event: React.DragEvent, directory: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={`file-directory${dropDirectory === node.path ? " drop-target" : ""}`}
      data-workspace-tree-path={`directory:${node.path}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      {pendingRename?.kind === "folder" && pendingRename.path === node.path ? (
        <WorkspaceRenameEntry
          target={pendingRename}
          iconType={faFolder}
          onRename={onRename}
          onCancel={onCancelRename}
          saving={renameSaving}
          error={renameError}
        />
      ) : (
        <summary
          title={node.path}
          onContextMenu={(event) => onDirectoryContextMenu(event, node.path)}
          onDragEnter={(event) => onDropTarget(event, node.path)}
          onDragOver={(event) => onDropTarget(event, node.path)}
          onDrop={(event) => onDropFiles(event, node.path)}
        >
          <span className="directory-chevron">›</span>
          <span className="directory-icon" aria-hidden="true">
            <FontAwesomeIcon icon={faFolder} />
          </span>
          <span>{node.name}</span>
        </summary>
      )}
      <div className="file-directory-children">
        {pendingEntry?.directory === node.path && (
          <WorkspaceNewEntry
            entry={pendingEntry}
            onCreate={onCreateEntry}
            onCancel={onCancelEntry}
            saving={entrySaving}
            error={entryError}
          />
        )}
        {node.directories.map((directory) => (
          <WorkspaceDirectory
            key={directory.path}
            node={directory}
            activePath={activePath}
            pendingEntry={pendingEntry}
            pendingRename={pendingRename}
            entrySaving={entrySaving}
            entryError={entryError}
            renameSaving={renameSaving}
            renameError={renameError}
            clipboard={clipboard}
            dropDirectory={dropDirectory}
            onOpenFile={onOpenFile}
            onCreateEntry={onCreateEntry}
            onCancelEntry={onCancelEntry}
            onRename={onRename}
            onCancelRename={onCancelRename}
            onContextMenu={onContextMenu}
            onDirectoryContextMenu={onDirectoryContextMenu}
            onDropTarget={onDropTarget}
            onDropFiles={onDropFiles}
          />
        ))}
        {node.files.map((file) => (
          <WorkspaceFileRow
            key={file.path}
            file={file}
            active={file.path === activePath}
            renaming={pendingRename?.path === file.path}
            clipboardOperation={
              clipboard?.file.path === file.path ? clipboard.operation : null
            }
            onOpenFile={onOpenFile}
            onRename={onRename}
            onCancelRename={onCancelRename}
            nameSaving={renameSaving}
            nameError={renameError}
            onContextMenu={onContextMenu}
            onDropTarget={onDropTarget}
            onDropFiles={onDropFiles}
          />
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

function WorkspaceFileRow({
  file,
  active,
  renaming,
  clipboardOperation,
  onOpenFile,
  onRename,
  onCancelRename,
  nameSaving,
  nameError,
  onContextMenu,
  onDropTarget,
  onDropFiles,
}: {
  file: WorkspaceFile;
  active: boolean;
  renaming: boolean;
  clipboardOperation: "copy" | "cut" | null;
  onOpenFile: (file: WorkspaceFile) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  nameSaving: boolean;
  nameError: string;
  onContextMenu: (event: React.MouseEvent, file: WorkspaceFile) => void;
  onDropTarget: (event: React.DragEvent, directory: string) => void;
  onDropFiles: (event: React.DragEvent, directory: string) => void;
}) {
  const iconType = fileTypeIcon(file.name);
  if (renaming)
    return (
      <WorkspaceRenameEntry
        target={{ ...file, kind: "file" }}
        iconType={iconType}
        onRename={onRename}
        onCancel={onCancelRename}
        saving={nameSaving}
        error={nameError}
      />
    );
  return (
    <button
      type="button"
      className={`workspace-file${active ? " active" : ""}${clipboardOperation ? ` clipboard-${clipboardOperation}` : ""}`}
      data-workspace-tree-path={`file:${file.path}`}
      title={`${file.path} · ${formatFileSize(file.size)}`}
      onClick={() => onOpenFile(file)}
      onContextMenu={(event) => onContextMenu(event, file)}
      onDragEnter={(event) =>
        onDropTarget(event, file.path.split("/").slice(0, -1).join("/"))
      }
      onDragOver={(event) =>
        onDropTarget(event, file.path.split("/").slice(0, -1).join("/"))
      }
      onDrop={(event) =>
        onDropFiles(event, file.path.split("/").slice(0, -1).join("/"))
      }
    >
      <span className="workspace-file-icon" aria-hidden="true">
        <FontAwesomeIcon icon={iconType} />
      </span>
      <span>{file.name}</span>
      <small>{formatFileSize(file.size)}</small>
    </button>
  );
}

function WorkspaceRenameEntry({
  target,
  iconType,
  onRename,
  onCancel,
  saving,
  error,
}: {
  target: WorkspaceRenameTarget;
  iconType: ReturnType<typeof fileTypeIcon>;
  onRename: (name: string) => void;
  onCancel: () => void;
  saving: boolean;
  error: string;
}) {
  const [name, setName] = useState(target.name);
  return (
    <div className="workspace-entry-wrap">
      <div className="workspace-new-entry workspace-rename-entry">
        <span className="workspace-file-icon" aria-hidden="true">
          <FontAwesomeIcon icon={iconType} />
        </span>
        <input
          autoFocus
          disabled={saving}
          aria-label={`重命名 ${target.name}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => {
            const extensionIndex =
              target.kind === "file" ? target.name.lastIndexOf(".") : -1;
            event.currentTarget.setSelectionRange(
              0,
              extensionIndex > 0 ? extensionIndex : target.name.length,
            );
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            } else if (event.key === "Enter") {
              event.preventDefault();
              onRename(name);
            }
          }}
        />
        <span className="workspace-entry-actions">
          <button
            type="button"
            disabled={saving}
            aria-label="保存名称"
            onClick={() => onRename(name)}
          >
            <FontAwesomeIcon icon={faCheck} />
          </button>
          <button
            type="button"
            disabled={saving}
            aria-label="取消重命名"
            onClick={onCancel}
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </span>
      </div>
      {saving ? (
        <small className="workspace-entry-status">正在保存…</small>
      ) : (
        error && <small className="workspace-entry-error">{error}</small>
      )}
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
  if (activity.kind === "narration") {
    return (
      <div className="activity-narration">
        <span className="activity-icon" aria-hidden="true">
          ✦
        </span>
        <div className="activity-narration-content">
          <ReactMarkdown>{activity.detail || ""}</ReactMarkdown>
        </div>
      </div>
    );
  }
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
const rootElement = document.getElementById("root")!;
const reactRoot = import.meta.hot?.data.reactRoot ?? createRoot(rootElement);
if (import.meta.hot) import.meta.hot.data.reactRoot = reactRoot;
reactRoot.render(<App />);
