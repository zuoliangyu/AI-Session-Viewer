import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { memo, useMemo } from "react";
import {
  MessageCircleQuestion,
  CornerDownRight,
  GitBranch,
  Loader2,
} from "lucide-react";
import type { QuestionIndexEntry } from "../../types";
import { formatTime } from "./utils";
import { useAppStore } from "../../stores/appStore";
import { useSessionFork } from "./useSessionFork";

interface ThreadSummaryViewProps {
  questions: QuestionIndexEntry[];
  source: string;
  onSelect: (messageId: string) => void;
  filePath?: string;
  projectPath?: string;
}

interface UserThreadItem {
  messageId: string;
  messageIndex: number;
  question: string;
  timestamp: string | null;
  replyPreview: string;
  replyModel: string | null;
  replyTimestamp: string | null;
  hasTool: boolean;
  parentMessageId: string | null;
  depth: number;
  branchIndex: number;
  branchCount: number;
}

function flattenQuestionIndex(
  questions: QuestionIndexEntry[],
  timeZone: string,
): UserThreadItem[] {
  const byMessageIndex = new Map(questions.map((question) => [question.messageIndex, question]));
  const childCounts = new Map<number, number>();
  const items: UserThreadItem[] = [];

  for (const question of questions) {
    const parentMessageIndex = question.parentMessageIndex;
    const branchIndex = parentMessageIndex === null
      ? 0
      : childCounts.get(parentMessageIndex) ?? 0;
    if (parentMessageIndex !== null) {
      childCounts.set(parentMessageIndex, branchIndex + 1);
    }

    let depth = 0;
    let ancestor = parentMessageIndex;
    const visited = new Set<number>();
    while (ancestor !== null && !visited.has(ancestor)) {
      visited.add(ancestor);
      const parent = byMessageIndex.get(ancestor);
      if (!parent) break;
      depth += 1;
      ancestor = parent.parentMessageIndex;
    }

    items.push({
      messageId: question.messageId,
      messageIndex: question.messageIndex,
      question: question.preview || t("（用户消息）"),
      timestamp: question.timestamp ? formatTime(question.timestamp, timeZone) : null,
      replyPreview: question.replyPreview,
      replyModel: question.replyModel,
      replyTimestamp: question.replyTimestamp
        ? formatTime(question.replyTimestamp, timeZone)
        : null,
      hasTool: question.hasTool,
      parentMessageId: parentMessageIndex === null
        ? null
        : byMessageIndex.get(parentMessageIndex)?.messageId ?? null,
      depth,
      branchIndex,
      branchCount: 0,
    });
  }

  for (const item of items) {
    item.branchCount = childCounts.get(item.messageIndex) ?? 0;
  }
  return items;
}

export const ThreadSummaryView = memo(function ThreadSummaryView({
  questions,
  source,
  onSelect,
  filePath,
}: ThreadSummaryViewProps) {
  const { t } = useTranslation();
  const timeZone = useAppStore((state) => state.timeZone);
  const items = useMemo(
    () => flattenQuestionIndex(questions, timeZone),
    [questions, timeZone, t],
  );
  const isThreaded = useMemo(
    () => questions.some((question) => question.parentMessageIndex !== null),
    [questions],
  );
  const assistantName = source === "codex" ? "Codex" : source === "omp" ? "Oh My Pi" : source === "grok" ? "Grok" : "Claude";

  const { fork: handleFork, pendingMessageId: forkingMsgId, error: forkError } = useSessionFork(source, filePath);
  const canFork = Boolean(filePath);

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-center text-sm text-muted-foreground">
        {t("当前会话还没有用户提问可供汇总。")}</div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3 px-4 py-6 sm:px-6">
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {t("共")}{items.length} {t("条提问")}{isThreaded && t("（按父子关系展示）")}
        </span>
        <span>
          {canFork ? t("点击提问跳转 · 从此处分叉会保留该轮完整回复") : t("点击任意一条跳转")}
        </span>
      </div>

      {forkError && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t("分叉失败：")}{forkError}
        </div>
      )}

      {items.map((item, index) => {
        const isForking = forkingMsgId === item.messageId;
        const indent = Math.min(item.depth, 4);

        return (
          <div
            key={item.messageId}
            className="relative"
            style={{ paddingLeft: `${indent * 1.25}rem` }}
          >
            {item.parentMessageId && (
              <span
                aria-hidden
                className="absolute top-0 h-full border-l border-dashed border-border"
                style={{ left: `${(indent - 1) * 1.25 + 0.5}rem` }}
              />
            )}
            <div className="rounded-lg border border-border bg-card transition-colors hover:border-primary/50 hover:bg-accent/60">
              <button
                type="button"
                onClick={() => onSelect(item.messageId)}
                className="group w-full px-4 py-3 text-left"
                title={item.question}
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 font-mono text-[11px]">
                    {index + 1}
                  </span>
                  <MessageCircleQuestion className="h-3.5 w-3.5 text-success" />
                  <span>{t("用户提问")}</span>
                  {item.branchCount > 1 && (
                    <span
                      className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] text-warning"
                      title={t("此消息后存在多个分叉")}
                    >
                      {source === "omp" ? t("{{v0}} 条路径", { v0: item.branchCount }) : t("{{v0}} 条分叉", { v0: item.branchCount })}
                    </span>
                  )}
                  {source === "omp" && item.branchIndex > 0 && (
                    <span
                      className="rounded bg-fuchsia-500/15 px-1.5 py-0.5 font-mono text-[10px] text-fuchsia-600 dark:text-fuchsia-400"
                      title={t("此问题由回退到同一父节点后创建")}
                    >
                      {t("回退分支")}</span>
                  )}
                </div>
                <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-sm font-medium text-foreground">
                  {item.question}
                </p>
                <div className="mt-2 flex items-start gap-2 rounded-md bg-muted/30 px-3 py-2">
                  <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{assistantName} {t("回复")}</span>
                      {item.replyModel && (
                        <span className="rounded bg-background px-1.5 py-0.5 font-mono">
                          {item.replyModel}
                        </span>
                      )}
                      {item.replyTimestamp && <span>· {item.replyTimestamp}</span>}
                      {item.hasTool && (
                        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">
                          {t("含工具调用")}</span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {item.replyPreview || t("尚无可见回复")}
                    </p>
                  </div>
                </div>
              </button>
              {canFork && (
                <div className="border-t border-border px-4 py-2">
                  <button
                    type="button"
                    onClick={() => void handleFork(item.messageId)}
                    disabled={forkingMsgId !== null || /^user-\d+$/.test(item.messageId)}
                    className={`inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] transition-colors hover:border-primary hover:text-primary disabled:opacity-60`}
                    title={t("保留此轮完整回复，分叉为新会话")}
                  >
                    {isForking ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <GitBranch className="h-3 w-3" />
                    )}
                    {t("从此处分叉")}</button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});
