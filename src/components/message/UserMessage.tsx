import type { DisplayMessage } from "../../types";
import { Copy, Check } from "lucide-react";
import { useState } from "react";
import { formatTime, cleanMessageText } from "./utils";
import { MarkdownContent } from "./MarkdownContent";

interface Props {
  message: DisplayMessage;
  showTimestamp: boolean;
}

export function UserMessage({ message, showTimestamp }: Props) {
  const [copied, setCopied] = useState(false);
  const hasTextContent = message.content.some((b) => b.type === "text");

  const handleCopy = () => {
    const text = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => cleanMessageText(b.text))
      .join("\n\n")
      .trim();
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%]">
        {(showTimestamp && message.timestamp) || hasTextContent ? (
          <div className="flex items-center justify-end gap-2 mb-1">
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
              <div key={i} className="bg-primary/10 rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
                <MarkdownContent
                  content={cleanMessageText(block.text)}
                  className="prose prose-sm max-w-none p-0 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
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
}
