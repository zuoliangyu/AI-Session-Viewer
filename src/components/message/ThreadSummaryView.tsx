import { memo, useMemo } from "react";
import { MessageCircleQuestion, CornerDownRight } from "lucide-react";
import type { DisplayMessage } from "../../types";
import { cleanMessageText, formatTime } from "./utils";
import { getUserMessageId } from "./threading";

interface ThreadSummaryViewProps {
  messages: DisplayMessage[];
  source: string;
  onSelect: (userMsgId: string, replyMsgId: string | null) => void;
}

interface ThreadItem {
  userMsgId: string;
  replyMsgId: string | null;
  question: string;
  questionPreview: string;
  timestamp: string | null;
  replyPreview: string;
  replyModel: string | null;
  replyTimestamp: string | null;
  hasTool: boolean;
}

const QUESTION_PREVIEW_LIMIT = 200;
const REPLY_PREVIEW_LIMIT = 220;

function extractTextForPreview(message: DisplayMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(cleanMessageText(block.text));
    } else if (block.type === "thinking" || block.type === "reasoning") {
      continue;
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function firstLine(value: string): string {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[0] || value.trim();
}

function limit(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trim()}…`;
}

function buildThreadItems(messages: DisplayMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    const rawQuestion = extractTextForPreview(msg);
    if (!rawQuestion) continue;

    let replyMsgId: string | null = null;
    let replyText = "";
    let replyModel: string | null = null;
    let replyTimestamp: string | null = null;
    let hasTool = false;

    for (let j = i + 1; j < messages.length; j += 1) {
      const next = messages[j];
      if (next.role === "user") break;
      if (next.role !== "assistant") continue;

      const replyContent = extractTextForPreview(next);
      if (!replyMsgId) {
        replyMsgId = next.uuid || `assistant-${j}`;
        replyModel = next.model ?? null;
        replyTimestamp = next.timestamp ?? null;
      }
      if (!replyText && replyContent) {
        replyText = replyContent;
      }
      if (!hasTool) {
        hasTool = next.content.some(
          (block) => block.type === "tool_use" || block.type === "function_call"
        );
      }
      if (replyText) break;
    }

    const userMsgId = getUserMessageId(msg, i);
    items.push({
      userMsgId,
      replyMsgId,
      question: rawQuestion,
      questionPreview: limit(firstLine(rawQuestion), QUESTION_PREVIEW_LIMIT),
      timestamp: msg.timestamp ? formatTime(msg.timestamp) : null,
      replyPreview: replyText
        ? limit(replyText, REPLY_PREVIEW_LIMIT)
        : hasTool
          ? "（仅包含工具调用）"
          : replyMsgId
            ? "（回复为空）"
            : "（尚无回复）",
      replyModel,
      replyTimestamp: replyTimestamp ? formatTime(replyTimestamp) : null,
      hasTool,
    });
  }

  return items;
}

export const ThreadSummaryView = memo(function ThreadSummaryView({
  messages,
  source,
  onSelect,
}: ThreadSummaryViewProps) {
  const items = useMemo(() => buildThreadItems(messages), [messages]);
  const assistantName = source === "codex" ? "Codex" : "Claude";

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-center text-sm text-muted-foreground">
        当前会话还没有用户提问可供汇总。
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3 px-4 py-6 sm:px-6">
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>共 {items.length} 条提问</span>
        <span>点击任意一条跳转到对应回复</span>
      </div>
      {items.map((item, index) => (
        <button
          key={item.userMsgId}
          type="button"
          onClick={() => onSelect(item.userMsgId, item.replyMsgId)}
          className="group w-full rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/50 hover:bg-accent/60"
          title={item.question}
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 font-mono text-[11px]">
              {index + 1}
            </span>
            <MessageCircleQuestion className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>用户提问</span>
            {item.timestamp && <span>· {item.timestamp}</span>}
          </div>
          <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-sm font-medium text-foreground">
            {item.questionPreview}
          </p>
          <div className="mt-2 flex items-start gap-2 rounded-md bg-muted/30 px-3 py-2">
            <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>{assistantName} 回复</span>
                {item.replyModel && (
                  <span className="rounded bg-background px-1.5 py-0.5 font-mono">
                    {item.replyModel}
                  </span>
                )}
                {item.replyTimestamp && <span>· {item.replyTimestamp}</span>}
                {item.hasTool && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">
                    含工具调用
                  </span>
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {item.replyPreview}
              </p>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});
