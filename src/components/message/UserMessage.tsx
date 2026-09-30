import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { memo, useMemo, useState } from "react";
import type { DisplayMessage } from "../../types";
import { Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import { formatTime, cleanMessageText, copyTextToClipboard } from "./utils";
import { MarkdownContent } from "./MarkdownContent";
import { useExpandAllControl } from "../common/ExpandAllContext";
import { getQuestionHue } from "./questionPalette";
import { useAppStore } from "../../stores/appStore";

interface Props {
  message: DisplayMessage;
  showTimestamp: boolean;
  threadHint?: string | null;
  layout?: "default" | "thread";
  /** 0-based ordinal of this user question in the session. Drives the per-question
   *  color (bubble tint + ribbon) so adjacent questions stay visually distinct in
   *  long conversations. -1 / undefined falls back to the default primary tint. */
  questionIndex?: number;
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
  questionIndex,
  replyCount = 0,
  repliesExpanded,
  onToggleReplies,
}: Props) {
  const { t } = useTranslation();
  const timeZone = useAppStore((state) => state.timeZone);
  const [copied, setCopied] = useState(false);
  const { expanded, setExpanded } = useExpandAllControl(true, { followGlobal: true });
  const hue = useMemo(
    () => (questionIndex !== undefined && questionIndex >= 0 ? getQuestionHue(questionIndex) : null),
    [questionIndex]
  );
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
    return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw || t("（用户消息）");
  }, [textContent, copyText, t]);
  const isShortPreview = previewText.length <= 12;

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
      ? t("展开提问与 {{v0}} 条回复", { v0: replyCount })
      : t("折叠提问与 {{v0}} 条回复", { v0: replyCount })
    : expanded
      ? t("折叠此消息")
      : t("展开此消息");

  return (
    <div className="flex justify-start">
      <div className="w-full">
        {threadHint && (
          <div className={`mb-1 text-[11px] text-muted-foreground ${isThreadLayout ? "text-left" : "text-right"}`}>
            {threadHint}
          </div>
        )}
        {!expanded ? (
          <button
            onClick={handleExpandFromPreview}
            className={`group items-center gap-2 rounded-lg border border-transparent px-3 py-2 text-left text-sm text-foreground/85 transition-colors hover:bg-accent ${
              isShortPreview ? "inline-flex" : "flex w-full max-w-full"
            } ${hue ? "border-border/40 bg-muted/40" : "border-primary/30 bg-primary/5"}`}
            title={foldTitle}
          >
            {hue && questionIndex !== undefined && (
              <span
                className={`inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full px-1 font-mono text-[10px] text-white ${hue.swatch}`}
              >
                {questionIndex + 1}
              </span>
            )}
            <ChevronDown className="w-3.5 h-3.5 shrink-0 -rotate-90 transition-transform group-hover:rotate-0" />
            <span className={isShortPreview ? "whitespace-nowrap text-left" : "min-w-0 flex-1 truncate text-left"}>
              {previewText}
            </span>
            {hasReplyControl && (
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${hue ? `${hue.bubbleBg} ${hue.text}` : "bg-primary/15 text-primary"}`}>
                {replyCount} {t("条回复")}</span>
            )}
          </button>
        ) : (
          <div
            className={`relative overflow-hidden rounded-lg px-4 py-3 text-sm leading-relaxed ${
              hue ? "bg-muted/40 border-l-2 border-primary/30" : "bg-primary/10"
            }`}
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              {hue && questionIndex !== undefined && (
                <span
                  className={`inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 font-mono text-[10px] text-white ${hue.swatch}`}
                  title={t("第 {{v0}} 个提问", { v0: questionIndex + 1 })}
                >
                  {questionIndex + 1}
                </span>
              )}
              <span className={`text-[11px] font-medium ${hue ? hue.text : "text-primary/80"}`}>{t("用户")}</span>
              {showTimestamp && message.timestamp && (
                <span className="text-[11px] text-muted-foreground">
                  {formatTime(message.timestamp, timeZone)}
                </span>
              )}
              {hasReplyControl && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${hue ? `${hue.previewBg} ${hue.text}` : "bg-primary/15 text-primary"}`}>
                  {replyCount} {t("条回复")}</span>
              )}
              <div className="ml-auto flex items-center gap-1">
                {hasCopyContent && (
                  <button
                    onClick={handleCopy}
                    className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border/60 bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    title={hasTextContent ? t("复制全部内容") : t("复制 Tool Result")}
                  >
                    {copied ? (
                      <>
                        <Check className="w-3 h-3 text-success" />
                        {t("已复制")}</>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        {t("复制")}</>
                    )}
                  </button>
                )}
                <button
                  onClick={handleToggleAll}
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border/60 bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  title={foldTitle}
                >
                  <ChevronUp className="w-3 h-3" />
                  {t("折叠")}</button>
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
  prevProps.questionIndex === nextProps.questionIndex &&
  prevProps.replyCount === nextProps.replyCount &&
  prevProps.repliesExpanded === nextProps.repliesExpanded &&
  prevProps.onToggleReplies === nextProps.onToggleReplies
));
