import {
  Component,
  Fragment,
  memo,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeMathjax from "rehype-mathjax/browser";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { resolveWorkspaceLink } from "./workspace-links";

const BASE_PATH = import.meta.env.BASE_URL;
let mathJaxLoader: Promise<void> | undefined;

function containsMath(content: string) {
  return /(?:\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(^|[^\\])\$[^$\n]+\$)/m.test(
    content,
  );
}

function loadMathJax() {
  if (window.MathJax?.typesetPromise) return Promise.resolve();
  if (mathJaxLoader) return mathJaxLoader;
  mathJaxLoader = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-cloudink-mathjax="true"]',
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = `${BASE_PATH}mathjax/tex-chtml.js`;
    script.defer = true;
    script.dataset.cloudinkMathjax = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("MathJax 加载失败"));
    document.head.appendChild(script);
  });
  return mathJaxLoader;
}

declare global {
  interface Window {
    MathJax?: {
      typesetClear?: (nodes: Element[]) => void;
      typesetPromise?: (nodes: Element[]) => Promise<void>;
    };
  }
}

function RenderedMarkdown({
  children,
  streaming,
  workspacePaths,
  onOpenWorkspaceFile,
}: {
  children: string;
  streaming: boolean;
  workspacePaths: string[];
  onOpenWorkspaceFile?: (path: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (streaming || !containsMath(children)) return;
    const root = rootRef.current;
    if (!root) return;
    void loadMathJax()
      .then(() => {
        window.MathJax?.typesetClear?.([root]);
        return window.MathJax?.typesetPromise?.([root]);
      })
      .catch(() => undefined);
  }, [children, streaming]);

  return (
    <div className="markdown-content" ref={rootRef}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
          rehypeMathjax,
        ]}
        components={{
          a: ({ href, children: content, ...props }) => {
            const path = resolveWorkspaceLink(href, workspacePaths);
            if (!path || !onOpenWorkspaceFile)
              return (
                <a href={href} {...props}>
                  {content}
                </a>
              );
            return (
              <a
                href={href}
                {...props}
                title={`在 Workspace 中打开 ${path}`}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenWorkspaceFile(path);
                }}
              >
                {content}
              </a>
            );
          },
          p: ({ children: content }) => (
            <p>
              {linkWorkspaceMentions(
                content,
                workspacePaths,
                onOpenWorkspaceFile,
              )}
            </p>
          ),
          li: ({ children: content }) => (
            <li>
              {linkWorkspaceMentions(
                content,
                workspacePaths,
                onOpenWorkspaceFile,
              )}
            </li>
          ),
          td: ({ children: content }) => (
            <td>
              {linkWorkspaceMentions(
                content,
                workspacePaths,
                onOpenWorkspaceFile,
              )}
            </td>
          ),
          th: ({ children: content }) => (
            <th>
              {linkWorkspaceMentions(
                content,
                workspacePaths,
                onOpenWorkspaceFile,
              )}
            </th>
          ),
          blockquote: ({ children: content }) => (
            <blockquote>
              {linkWorkspaceMentions(
                content,
                workspacePaths,
                onOpenWorkspaceFile,
              )}
            </blockquote>
          ),
          code: ({ children: content, className }) => {
            const value = String(content).replace(/\n$/, "");
            const path = workspacePathFromToken(value, workspacePaths);
            if (!className && path && onOpenWorkspaceFile)
              return (
                <button
                  type="button"
                  className="workspace-file-mention inline-code"
                  title={`在 Workspace 中打开 ${path}`}
                  onClick={() => onOpenWorkspaceFile(path)}
                >
                  {value}
                </button>
              );
            return <code className={className}>{content}</code>;
          },
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

function workspacePathFromToken(token: string, workspacePaths: string[]) {
  const normalized = token.trim().replace(/^@/, "");
  return workspacePaths.includes(normalized) ? normalized : null;
}

function linkWorkspaceMentions(
  content: ReactNode,
  workspacePaths: string[],
  onOpenWorkspaceFile?: (path: string) => void,
): ReactNode {
  if (!onOpenWorkspaceFile || !workspacePaths.length) return content;
  if (Array.isArray(content))
    return content.map((child, index) => (
      <Fragment key={index}>
        {linkWorkspaceMentions(child, workspacePaths, onOpenWorkspaceFile)}
      </Fragment>
    ));
  if (typeof content !== "string") return content;
  const paths = [...workspacePaths].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(@?(?:${paths.map(escapeRegex).join("|")}))`,
    "g",
  );
  return content.split(pattern).map((part, index) => {
    const path = workspacePathFromToken(part, workspacePaths);
    return path ? (
      <button
        type="button"
        className="workspace-file-mention"
        title={`在 Workspace 中打开 ${path}`}
        onClick={() => onOpenWorkspaceFile(path)}
        key={`${path}-${index}`}
      >
        {part}
      </button>
    ) : (
      part
    );
  });
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function WorkspaceMentionText({
  children,
  workspacePaths,
  onOpenWorkspaceFile,
}: {
  children: string;
  workspacePaths: string[];
  onOpenWorkspaceFile: (path: string) => void;
}) {
  return (
    <>{linkWorkspaceMentions(children, workspacePaths, onOpenWorkspaceFile)}</>
  );
}

class MarkdownErrorBoundary extends Component<
  { content: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: { content: string }) {
    if (this.state.failed && previous.content !== this.props.content)
      this.setState({ failed: false });
  }

  render() {
    if (this.state.failed)
      return <div className="markdown-fallback">{this.props.content}</div>;
    return this.props.children;
  }
}

function MarkdownMessage({
  children,
  streaming = false,
  workspacePaths = [],
  onOpenWorkspaceFile,
}: {
  children: string;
  streaming?: boolean;
  workspacePaths?: string[];
  onOpenWorkspaceFile?: (path: string) => void;
}) {
  return (
    <MarkdownErrorBoundary content={children}>
      <RenderedMarkdown
        streaming={streaming}
        workspacePaths={workspacePaths}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      >
        {children}
      </RenderedMarkdown>
    </MarkdownErrorBoundary>
  );
}

export default memo(
  MarkdownMessage,
  (previous, next) =>
    previous.children === next.children &&
    previous.streaming === next.streaming &&
    previous.workspacePaths === next.workspacePaths,
);
