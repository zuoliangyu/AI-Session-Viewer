import { memo, useCallback, useMemo, useState } from "react";
import {
  MessageCircleQuestion,
  CornerDownRight,
  GitBranch,
  Loader2,
  Check,
} from "lucide-react";
import type { DisplayMessage } from "../../types";
import { cleanMessageText, formatTime } from "./utils";
import { buildMessageTree, getUserMessageId, type ThreadDisplayNode } from "./threading";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../services/api";

interface ThreadSummaryViewProps {
  messages: DisplayMessage[];
  source: string;
  onSelect: (userMsgId: string, replyMsgId: string | null) => void;
  /** Required for fork-action ("回复此处")。Pass through from MessagesPage. */
  filePath?: string;
  projectPath?: string;
}

interface UserThreadItem {
  userMsgId: string;
  replyMsgId: string | null;
  question: string;
  questionPreview: string;
  timestamp: string | null;
  replyPreview: string;
  replyModel: string | null;
  replyTimestamp: string | null;
  hasTool: boolean;
  parentUserMsgId: string | null;
  depth: number;
  /** Number of direct child user nodes — show a small badge if >0 */
  branchCount: number;
}

const QUESTION_PREVIEW_LIMIT = 200;
const REPLY_PREVIEW_LIMIT = 220;

function extractTextForPreview(message: DisplayMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(cleanMessageText(block.text));
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

/** Find the first assistant descendant (DFS preorder) under a user node. */
function findFirstAssistantReply(node: ThreadDisplayNode): {
  message: DisplayMessage;
  hasTool: boolean;
} | null {
  for (const child of node.children) {
    if (child.message.role === "assistant") {
      const hasTool = child.message.content.some(
        (b) => b.type === "tool_use" || b.type === "function_call",
      );
      return { message: child.message, hasTool };
    }
    const deeper = findFirstAssistantReply(child);
    if (deeper) return deeper;
  }
  return null;
}

/** Walk the entire tree and emit user nodes in preorder, tagging each with
 *  its closest user ancestor (parentUserMsgId) and depth in the user-only
 *  tree. */
function flattenUserTree(roots: ThreadDisplayNode[]): UserThreadItem[] {
  const out: UserThreadItem[] = [];

  // Pre-pass: count how many direct user-children each user has, by walking
  // the tree and bookkeeping the nearest-user-ancestor at every level.
  const branchCounts = new Map<string, number>();

  function walk(node: ThreadDisplayNode, parentUserMsgId: string | null, userDepth: number) {
    let nextParentUserMsgId = parentUserMsgId;
    let nextUserDepth = userDepth;

    if (node.message.role === "user") {
      const userMsgId = getUserMessageId(node.message, node.originalIndex);
      const rawQuestion = extractTextForPreview(node.message);
      const reply = findFirstAssistantReply(node);
      const replyMsg = reply?.message ?? null;
      const replyText = replyMsg ? extractTextForPreview(replyMsg) : "";

      out.push({
        userMsgId,
        replyMsgId: replyMsg?.uuid ?? null,
        question: rawQuestion,
        questionPreview: limit(firstLine(rawQuestion), QUESTION_PREVIEW_LIMIT),
        timestamp: node.message.timestamp ? formatTime(node.message.timestamp) : null,
        replyPreview: replyText
          ? limit(replyText, REPLY_PREVIEW_LIMIT)
          : reply?.hasTool
            ? "（仅包含工具调用）"
            : replyMsg
              ? "（回复为空）"
              : "（尚无回复）",
        replyModel: replyMsg?.model ?? null,
        replyTimestamp: replyMsg?.timestamp ? formatTime(replyMsg.timestamp) : null,
        hasTool: reply?.hasTool ?? false,
        parentUserMsgId,
        depth: userDepth,
        branchCount: 0,
      });

      if (parentUserMsgId) {
        branchCounts.set(parentUserMsgId, (branchCounts.get(parentUserMsgId) ?? 0) + 1);
      }

      nextParentUserMsgId = userMsgId;
      nextUserDepth = userDepth + 1;
    }

    for (const child of node.children) {
      walk(child, nextParentUserMsgId, nextUserDepth);
    }
  }

  for (const root of roots) {
    walk(root, null, 0);
  }

  for (const item of out) {
    item.branchCount = branchCounts.get(item.userMsgId) ?? 0;
  }

  return out;
}

export const ThreadSummaryView = memo(function ThreadSummaryView({
  messages,
  source,
  onSelect,
  filePath,
  projectPath,
}: ThreadSummaryViewProps) {
  const { roots, isThreaded } = useMemo(() => buildMessageTree(messages), [messages]);
  const items = useMemo(() => flattenUserTree(roots), [roots]);
  const assistantName = source === "codex" ? "Codex" : "Claude";

  const terminalShell = useAppStore((state) => state.terminalShell);
  const refreshInBackground = useAppStore((state) => state.refreshInBackground);
  const [forkingMsgId, setForkingMsgId] = useState<string | null>(null);
  const [forkSuccessMsgId, setForkSuccessMsgId] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const canFork = Boolean(filePath && projectPath);

  const handleFork = useCallback(
    async (userMsgId: string) => {
      if (!filePath || !projectPath) return;
      setForkError(null);
      setForkingMsgId(userMsgId);
      try {
        await api.forkAndResume(source, filePath, userMsgId, projectPath, terminalShell);
        setForkSuccessMsgId(userMsgId);
        setTimeout(() => setForkSuccessMsgId(null), 1800);
        void refreshInBackground();
      } catch (err) {
        setForkError(err instanceof Error ? err.message : String(err));
      } finally {
        setForkingMsgId(null);
      }
    },
    [filePath, projectPath, refreshInBackground, source, terminalShell],
  );

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
        <span>
          共 {items.length} 条提问
          {isThreaded && "（按父子关系展示）"}
        </span>
        <span>点击任意一条跳转 · "回复此处"从该消息分叉新会话</span>
      </div>

      {forkError && (
        <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          分叉失败：{forkError}
          <button
            onClick={() => setForkError(null)}
            className="ml-2 opacity-70 hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}

      {items.map((item, index) => {
        const isForking = forkingMsgId === item.userMsgId;
        const isForkSucceeded = forkSuccessMsgId === item.userMsgId;
        const indent = Math.min(item.depth, 4);

        return (
          <div
            key={item.userMsgId}
            className="relative"
            style={{ paddingLeft: `${indent * 1.25}rem` }}
          >
            {item.parentUserMsgId && (
              <span
                aria-hidden
                className="absolute left-2 top-0 h-full border-l border-dashed border-border"
                style={{ left: `${(indent - 1) * 1.25 + 0.5}rem` }}
              />
            )}
            <button
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
                {item.parentUserMsgId && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                    回复上一条
                  </span>
                )}
                {item.branchCount > 1 && (
                  <span
                    className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-600 dark:text-amber-400"
                    title="此消息后存在多个分叉"
                  >
                    {item.branchCount} 条分叉
                  </span>
                )}
                {canFork && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleFork(item.userMsgId);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        void handleFork(item.userMsgId);
                      }
                    }}
                    className={`ml-auto inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                      isForkSucceeded
                        ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "border-border bg-background hover:border-primary hover:text-primary"
                    } ${isForking ? "opacity-60" : ""}`}
                    title="从此条消息分叉新会话并在终端打开"
                  >
                    {isForking ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : isForkSucceeded ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <GitBranch className="h-3 w-3" />
                    )}
                    {isForkSucceeded ? "已分叉" : "回复此处"}
                  </span>
                )}
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
          </div>
        );
      })}
    </div>
  );
});
