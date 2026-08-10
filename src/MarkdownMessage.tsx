import { Component, useEffect, useRef, type ReactNode } from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeMathjax from "rehype-mathjax/browser";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

function RenderedMarkdown({
  children,
  streaming,
}: {
  children: string;
  streaming: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (streaming) return;
    const root = rootRef.current;
    const mathJax = (
      window as typeof window & {
        MathJax?: {
          typesetClear?: (nodes: Element[]) => void;
          typesetPromise?: (nodes: Element[]) => Promise<void>;
        };
      }
    ).MathJax;
    if (!root || !mathJax?.typesetPromise) return;
    mathJax.typesetClear?.([root]);
    void mathJax.typesetPromise([root]).catch(() => undefined);
  }, [children, streaming]);

  return (
    <div className="markdown-content" ref={rootRef}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
          rehypeMathjax,
        ]}
      >
        {children}
      </Markdown>
    </div>
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

export default function MarkdownMessage({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  return (
    <MarkdownErrorBoundary content={children}>
      <RenderedMarkdown streaming={streaming}>{children}</RenderedMarkdown>
    </MarkdownErrorBoundary>
  );
}
