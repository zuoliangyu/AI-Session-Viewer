import { memo, useMemo, useState } from "react";
import type { DisplayMessage } from "../../types";
import { Copy, Check } from "lucide-react";
import { formatTime, cleanMessageText } from "./utils";
import { MarkdownContent } from "./MarkdownContent";

interface Props {
  message: DisplayMessage;
  showTimestamp: boolean;
  threadHint?: string | null;
  layout?: "default" | "thread";
}

const MARKDOWN_CLASS_NAME = "prose prose-sm max-w-none p-0 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";

export const UserMessage = memo(function UserMessage({
  message,
  showTimestamp,
  threadHint,
  layout = "default",
}: Props) {
  const [copied, setCopied] = useState(false);
  const textContent = useMemo(
    () => message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => cleanMessageText(block.text))
      .filter(Boolean),
    [message.content]
  );
  const hasTextContent = textContent.length > 0;
  const copyText = useMemo(
    () => textContent.join("\n\n").trim(),
    [textContent]
  );

  const handleCopy = () => {
    if (!copyText) return;
    navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isThreadLayout = layout === "thread";

  return (
    <div className={`flex ${isThreadLayout ? "justify-start" : "justify-end"}`}>
      <div className={isThreadLayout ? "w-full" : "max-w-[85%]"}>
        {threadHint && (
          <div className={`mb-1 text-[11px] text-muted-foreground ${isThreadLayout ? "text-left" : "text-right"}`}>
            {threadHint}
          </div>
        )}
        {(showTimestamp && message.timestamp) || hasTextContent ? (
          <div className={`mb-1 flex items-center gap-2 ${isThreadLayout ? "justify-start" : "justify-end"}`}>
            {showTimestamp && message.timestamp && (
              <span className="text-xs text-muted-foreground">
                {formatTime(message.timestamp)}
              </span>
            )}
            {hasTextContent && (
              <button
                onClick={handleCopy}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title="复制消息"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-green-500" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    复制文本
                  </>
                )}
              </button>
            )}
          </div>
        ) : null}
        {message.content.map((block, i) => {
          if (block.type === "text") {
            return (
              <div key={i} className="rounded-2xl bg-primary/10 px-4 py-2.5 text-sm leading-relaxed">
                <MarkdownContent
                  content={cleanMessageText(block.text)}
                  className={MARKDOWN_CLASS_NAME}
                />
              </div>
            );
          }
          if (block.type === "tool_result") {
            return (
              <div
                key={i}
                className={`mt-2 text-xs rounded-md p-3 font-mono overflow-x-auto ${
                  block.isError
                    ? "bg-destructive/10 text-destructive border border-destructive/20"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                <pre className="whitespace-pre-wrap break-all">
                  {block.content.length > 2000
                    ? block.content.slice(0, 2000) + "\n... (truncated)"
                    : block.content}
                </pre>
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}, (prevProps, nextProps) => (
  prevProps.message === nextProps.message &&
  prevProps.showTimestamp === nextProps.showTimestamp &&
  prevProps.threadHint === nextProps.threadHint &&
  prevProps.layout === nextProps.layout
));
