import { useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import rehypeMathjax from 'rehype-mathjax/browser';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export default function MarkdownMessage({ children }: { children: string; remarkPlugins?: unknown[] }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mathJax = (window as typeof window & {
      MathJax?: { typesetClear?: (nodes: Element[]) => void; typesetPromise?: (nodes: Element[]) => Promise<void> };
    }).MathJax;
    if (!rootRef.current || !mathJax?.typesetPromise) return;
    mathJax.typesetClear?.([rootRef.current]);
    void mathJax.typesetPromise([rootRef.current]);
  }, [children]);

  return (
    <div className="markdown-content" ref={rootRef}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeMathjax]}
      >
        {children}
      </Markdown>
    </div>
  );
}
