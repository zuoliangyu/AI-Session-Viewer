import { memo, useMemo, useState } from "react";
import type { DisplayMessage } from "../../types";
import { Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import { formatTime, cleanMessageText, copyTextToClipboard } from "./utils";
import { MarkdownContent } from "./MarkdownContent";
import { useExpandAllControl } from "../common/ExpandAllContext";

interface Props {
  message: DisplayMessage;
  showTimestamp: boolean;
  threadHint?: string | null;
  layout?: "default" | "thread";
  /** Replies attached to this user message (assistant + tool messages). When provided
   *  with a toggle callback, the bubble's fold button will collapse them too. */
  replyCount?: number;
  repliesExpanded?: boolean;
  onToggleReplies?: (next: boolean) => void;
}

const MARKDOWN_CLASS_NAME = "prose prose-sm max-w-none p-0 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";

export const UserMessage = memo(function UserMessage({
  message,
  showTimestamp,
  threadHint,
  layout = "default",
  replyCount = 0,
  repliesExpanded,
  onToggleReplies,
}: Props) {
  const [copied, setCopied] = useState(false);
  const { expanded, setExpanded } = useExpandAllControl(true);
  const textContent = useMemo(
    () => message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => cleanMessageText(block.text))
      .filter(Boolean),
    [message.content]
  );
  const hasTextContent = textContent.length > 0;
  // Copy everything that is rendered visually — text blocks AND tool_result content —
  // so the copy button does not silently drop parts of the message.
  const copyText = useMemo(() => {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        const cleaned = cleanMessageText(block.text);
        if (cleaned) parts.push(cleaned);
      } else if (block.type === "tool_result") {
        if (block.content) parts.push(block.content);
      }
    }
    return parts.join("\n\n").trim();
  }, [message.content]);
  const hasCopyContent = copyText.length > 0;
  const previewText = useMemo(() => {
    const raw = (textContent.join("\n\n") || copyText).replace(/\s+/g, " ").trim();
    return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw || "（用户消息）";
  }, [textContent, copyText]);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!copyText) return;
    const ok = await copyTextToClipboard(copyText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const hasReplyControl = replyCount > 0 && typeof onToggleReplies === "function";
  const repliesEffectivelyExpanded = hasReplyControl ? repliesExpanded !== false : true;
  const allCollapsed = !expanded && (!hasReplyControl || !repliesEffectivelyExpanded);

  const handleToggleAll = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = allCollapsed; // when fully collapsed, expand; otherwise collapse all
    setExpanded(next);
    if (hasReplyControl && onToggleReplies) {
      onToggleReplies(next);
    }
  };

  const handleExpandFromPreview = () => {
    setExpanded(true);
    if (hasReplyControl && onToggleReplies && !repliesEffectivelyExpanded) {
      onToggleReplies(true);
    }
  };

  const isThreadLayout = layout === "thread";
  const foldTitle = hasReplyControl
    ? allCollapsed
      ? `展开提问与 ${replyCount} 条回复`
      : `折叠提问与 ${replyCount} 条回复`
    : expanded
      ? "折叠此消息"
      : "展开此消息";

  return (
    <div className={`flex ${isThreadLayout ? "justify-start" : "justify-end"}`}>
      <div className={isThreadLayout ? "w-full" : "max-w-[85%]"}>
        {threadHint && (
          <div className={`mb-1 text-[11px] text-muted-foreground ${isThreadLayout ? "text-left" : "text-right"}`}>
            {threadHint}
          </div>
        )}
        {!expanded ? (
          <button
            onClick={handleExpandFromPreview}
            className={`group flex w-full items-center gap-2 rounded-2xl border border-dashed border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground hover:bg-primary/10 transition-colors ${isThreadLayout ? "text-left" : "text-left"}`}
            title={foldTitle}
          >
            <ChevronDown className="w-3.5 h-3.5 shrink-0 -rotate-90 transition-transform group-hover:rotate-0" />
            <span className="flex-1 truncate text-left">{previewText}</span>
            {hasReplyControl && (
              <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
                {replyCount} 条回复
              </span>
            )}
          </button>
        ) : (
          <div className="rounded-2xl bg-primary/10 px-4 py-2.5 text-sm leading-relaxed">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-medium text-primary/80">用户</span>
              {showTimestamp && message.timestamp && (
                <span className="text-[11px] text-muted-foreground">
                  {formatTime(message.timestamp)}
                </span>
              )}
              {hasReplyControl && (
                <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                  {replyCount} 条回复
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                {hasCopyContent && (
                  <button
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    title={hasTextContent ? "复制全部内容" : "复制 Tool Result"}
                  >
                    {copied ? (
                      <>
                        <Check className="w-3 h-3 text-green-500" />
                        已复制
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        复制
                      </>
                    )}
                  </button>
                )}
                <button
                  onClick={handleToggleAll}
                  className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  title={foldTitle}
                >
                  <ChevronUp className="w-3 h-3" />
                  折叠
                </button>
              </div>
            </div>
            {message.content.map((block, i) => {
              if (block.type === "text") {
                return (
                  <MarkdownContent
                    key={i}
                    content={cleanMessageText(block.text)}
                    className={MARKDOWN_CLASS_NAME}
                  />
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
        )}
      </div>
    </div>
  );
}, (prevProps, nextProps) => (
  prevProps.message === nextProps.message &&
  prevProps.showTimestamp === nextProps.showTimestamp &&
  prevProps.threadHint === nextProps.threadHint &&
  prevProps.layout === nextProps.layout &&
  prevProps.replyCount === nextProps.replyCount &&
  prevProps.repliesExpanded === nextProps.repliesExpanded &&
  prevProps.onToggleReplies === nextProps.onToggleReplies
));
