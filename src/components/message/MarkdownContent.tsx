import { Children, isValidElement, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { cleanMessageText, wrapAsciiArt } from "./utils";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

const DEFAULT_CLASS_NAME = "p-3 prose prose-sm max-w-none text-xs leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const LONG_MARKDOWN_CHAR_THRESHOLD = 24000;
const LONG_MARKDOWN_LINE_THRESHOLD = 600;
const DEFER_HIGHLIGHT_CHAR_THRESHOLD = 2000;
const DEFER_HIGHLIGHT_LINE_THRESHOLD = 120;

function getLineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

function shouldStartInPlainText(content: string): boolean {
  return (
    content.length >= LONG_MARKDOWN_CHAR_THRESHOLD ||
    getLineCount(content) >= LONG_MARKDOWN_LINE_THRESHOLD
  );
}

function shouldDeferHighlight(code: string): boolean {
  return (
    code.length >= DEFER_HIGHLIGHT_CHAR_THRESHOLD ||
    getLineCount(code) >= DEFER_HIGHLIGHT_LINE_THRESHOLD
  );
}

function DeferredCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const deferredByDefault = shouldDeferHighlight(code);
  const [highlightEnabled, setHighlightEnabled] = useState(!deferredByDefault);
  const lineCount = useMemo(() => getLineCount(code), [code]);

  useEffect(() => {
    setHighlightEnabled(!deferredByDefault);
  }, [code, deferredByDefault]);

  if (!highlightEnabled) {
    return (
      <div
        data-asv-code-block="true"
        className="overflow-hidden rounded-md border border-border bg-muted/20"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          <span className="truncate">
            {language} · {lineCount} 行 · {code.length} 字符
          </span>
          <button
            type="button"
            onClick={() => setHighlightEnabled(true)}
            className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent"
          >
            启用高亮
          </button>
        </div>
        <pre className="max-h-[32rem] overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-words text-foreground">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <div data-asv-code-block="true">
      <SyntaxHighlighter
        style={oneDark}
        language={language}
        PreTag="div"
        className="rounded text-[11px] !mt-1.5 !mb-1.5"
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

function MarkdownCode({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const match = /language-(\w+)/.exec(className || "");
  const codeStr = String(children).replace(/\n$/, "");

  if (match) {
    return <DeferredCodeBlock code={codeStr} language={match[1]} />;
  }

  return (
    <code className="bg-muted px-1 py-0.5 rounded text-[11px] font-mono">
      {children}
    </code>
  );
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const childArray = Children.toArray(children);
  const onlyChild = childArray.length === 1 ? childArray[0] : null;
  const childProps = onlyChild && isValidElement(onlyChild)
    ? onlyChild.props as { ["data-asv-code-block"]?: string }
    : null;

  if (childProps?.["data-asv-code-block"]) {
    return <div className="not-prose my-1.5">{onlyChild}</div>;
  }

  return (
    <div className="not-prose my-1.5">
      <pre className="rounded-md bg-muted border border-border p-3 text-xs font-mono overflow-x-auto [&>code]:bg-transparent [&>code]:p-0 [&>code]:rounded-none">
        {children}
      </pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS = {
  code: MarkdownCode,
  pre: MarkdownPre,
  table({ children }: { children?: ReactNode }) {
    return (
      <div className="overflow-x-auto my-2">
        <table className="min-w-full text-xs border-collapse border border-border rounded">
          {children}
        </table>
      </div>
    );
  },
  th({ children }: { children?: ReactNode }) {
    return (
      <th className="bg-muted/50 px-3 py-1.5 text-left text-xs font-medium border border-border">
        {children}
      </th>
    );
  },
  td({ children }: { children?: ReactNode }) {
    return (
      <td className="px-3 py-1.5 text-xs border border-border">
        {children}
      </td>
    );
  },
};

export const MarkdownContent = memo(function MarkdownContent({ content, className }: MarkdownContentProps) {
  const normalizedContent = useMemo(
    () => wrapAsciiArt(cleanMessageText(content)),
    [content]
  );
  const oversizedMarkdown = useMemo(
    () => shouldStartInPlainText(normalizedContent),
    [normalizedContent]
  );
  const [renderMarkdown, setRenderMarkdown] = useState(!oversizedMarkdown);

  useEffect(() => {
    setRenderMarkdown(!oversizedMarkdown);
  }, [normalizedContent, oversizedMarkdown]);

  if (!renderMarkdown) {
    return (
      <div className={className ?? DEFAULT_CLASS_NAME}>
        <div className="not-prose overflow-hidden rounded-md border border-border bg-muted/20">
          <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
            <span className="truncate">
              内容较长，默认使用纯文本预览以减少首屏卡顿
            </span>
            <button
              type="button"
              onClick={() => setRenderMarkdown(true)}
              className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent"
            >
              渲染 Markdown
            </button>
          </div>
          <pre className="max-h-[32rem] overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-words text-foreground">
            {normalizedContent}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className={className ?? DEFAULT_CLASS_NAME}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}, (prevProps, nextProps) => (
  prevProps.content === nextProps.content &&
  prevProps.className === nextProps.className
));
