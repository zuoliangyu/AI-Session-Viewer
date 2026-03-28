import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { DisplayMessage } from "../../types";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ToolOutputMessage } from "./ToolOutputMessage";
import { useAppStore } from "../../stores/appStore";
import { Star, GitFork, Play, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../../services/api";
import { useExpandAllControl } from "../common/ExpandAllContext";
import {
  buildMessageTree,
  getUserMessageId,
  type ThreadDisplayNode,
} from "./threading";

declare const __IS_TAURI__: boolean;

interface MessageThreadProps {
  messages: DisplayMessage[];
  source: string;
  showTimestamp: boolean;
  showModel: boolean;
  sessionId?: string;
  projectId?: string;
  filePath?: string;
  sessionTitle?: string;
  projectName?: string;
  projectPath?: string;
}

function ThreadBranch({
  node,
  depth,
  renderMessage,
}: {
  node: ThreadDisplayNode;
  depth: number;
  renderMessage: (node: ThreadDisplayNode) => ReactNode;
}) {
  const hasChildren = node.children.length > 0;
  const { expanded, setExpanded } = useExpandAllControl(true);
  const branchTitle = node.threadTitle.trim();

  return (
    <div className={depth > 0 ? "ml-2" : ""}>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <div className="flex w-5 shrink-0 justify-center">
          {hasChildren ? (
            <button
              onClick={() => setExpanded(!expanded)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={expanded ? `折叠 ${branchTitle}` : `展开 ${branchTitle}`}
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <span className="h-3.5 w-3.5" />
          )}
        </div>
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground" title={branchTitle}>
            <span>{node.threadTitle}</span>
          </span>
        </div>
      </div>

      <div className="min-w-0">{renderMessage(node)}</div>

      {hasChildren && expanded && (
        <div className="mt-3 space-y-5">
          {node.children.map((child) => (
            <ThreadBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              renderMessage={renderMessage}
            />
          ))}
        </div>
      )}

      {hasChildren && !expanded && (
        <div className="ml-7 mt-2 text-xs text-muted-foreground">
          已折叠 {branchTitle}（{node.children.length} 条后续消息）
        </div>
      )}
    </div>
  );
}

export function MessageThread({
  messages,
  source,
  showTimestamp,
  showModel,
  sessionId,
  projectId,
  filePath,
  sessionTitle,
  projectName,
  projectPath,
}: MessageThreadProps) {
  const {
    addBookmark,
    removeBookmark,
    isBookmarked,
    bookmarks,
    terminalShell,
    refreshInBackground,
  } = useAppStore();
  const [forkingMsgId, setForkingMsgId] = useState<string | null>(null);
  const [forkSuccessMsgId, setForkSuccessMsgId] = useState<string | null>(null);
  const [assistantContextMenu, setAssistantContextMenu] = useState<{
    x: number;
    y: number;
    userMsgId: string;
  } | null>(null);

  useEffect(() => {
    if (!assistantContextMenu) return;

    const closeMenu = () => setAssistantContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAssistantContextMenu(null);
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [assistantContextMenu]);

  const handleToggleBookmark = (msg: DisplayMessage, msgId: string) => {
    if (!sessionId || !projectId || !filePath) return;
    const bookmarked = isBookmarked(sessionId, msgId);
    if (bookmarked) {
      const bm = bookmarks.find(
        (b) => b.sessionId === sessionId && b.messageId === msgId
      );
      if (bm) removeBookmark(bm.id);
    } else {
      const textContent = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      const preview = textContent.slice(0, 100) + (textContent.length > 100 ? "..." : "");
      addBookmark({
        source,
        projectId,
        sessionId,
        filePath,
        messageId: msgId,
        preview,
        sessionTitle: sessionTitle || "",
        projectName: projectName || "",
      });
    }
  };

  const handleFork = async (msgId: string) => {
    if (!filePath || !projectPath || !msgId) return;
    setForkingMsgId(msgId);
    try {
      await api.forkAndResume(source, filePath, msgId, projectPath, terminalShell);
      setForkSuccessMsgId(msgId);
      setTimeout(() => setForkSuccessMsgId(null), 2000);
      refreshInBackground();
    } catch (err) {
      console.error("Failed to fork session:", err);
    } finally {
      setForkingMsgId(null);
    }
  };

  const handleAssistantContextMenu = (
    event: MouseEvent<HTMLDivElement>,
    node: ThreadDisplayNode
  ) => {
    if (!showActionButtons || !node.forkUserMessageId) {
      return;
    }

    event.preventDefault();
    setAssistantContextMenu({
      x: event.clientX,
      y: event.clientY,
      userMsgId: node.forkUserMessageId,
    });
  };

  const handleAssistantFork = async () => {
    if (!assistantContextMenu) {
      return;
    }

    setAssistantContextMenu(null);
    await handleFork(assistantContextMenu.userMsgId);
  };

  const handleResumeFromMessage = async () => {
    if (!sessionId || !projectPath) return;
    try {
      await api.resumeSession(source, sessionId, projectPath, filePath, terminalShell);
    } catch (err) {
      console.error("Failed to resume session:", err);
    }
  };

  const showActionButtons = __IS_TAURI__ && source === "claude";
  const { roots, isThreaded } = buildMessageTree(messages);

  const renderMessage = (node: ThreadDisplayNode) => {
    const msg = node.message;

    if (msg.role === "user") {
      const msgId = getUserMessageId(msg, node.originalIndex);
      const bookmarked = sessionId ? isBookmarked(sessionId, msgId) : false;
      const canFork = showActionButtons && !!msg.uuid;
      const canResume = showActionButtons && !!sessionId;
      const isForking = forkingMsgId === msgId;
      const isForkSuccess = forkSuccessMsgId === msgId;

      return (
        <div
          key={msgId}
          data-user-msg-id={msgId}
          className="group/bookmark flex items-start justify-end gap-1.5"
        >
          <div className="min-w-0">
            <UserMessage
              message={msg}
              showTimestamp={showTimestamp}
              threadHint={
                node.parentSource === "mention" && node.mentionAnchors[0]
                  ? `通过 ${node.mentionAnchors[0]} 挂到该回复`
                  : null
              }
            />
          </div>
          <div className="flex shrink-0 flex-col gap-0.5">
            {canResume && (
              <button
                onClick={handleResumeFromMessage}
                className="mt-1 rounded p-1 text-muted-foreground opacity-0 transition-all group-hover/bookmark:opacity-100 hover:text-primary"
                title="在终端中恢复此会话"
              >
                <Play className="h-3.5 w-3.5" />
              </button>
            )}
            {canFork && (
              <button
                onClick={() => handleFork(msgId)}
                disabled={isForking}
                className={`rounded p-1 transition-all ${
                  isForkSuccess
                    ? "text-green-500 opacity-100"
                    : isForking
                      ? "text-muted-foreground opacity-100"
                      : "text-muted-foreground opacity-0 group-hover/bookmark:opacity-100 hover:text-primary"
                }`}
                title="从此处分叉新会话"
              >
                {isForking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitFork className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            {sessionId && (
              <button
                onClick={() => handleToggleBookmark(msg, msgId)}
                className={`rounded p-1 transition-all ${
                  bookmarked
                    ? "text-yellow-500 opacity-100"
                    : "text-muted-foreground opacity-0 group-hover/bookmark:opacity-100 hover:text-yellow-500"
                }`}
                title={bookmarked ? "取消收藏" : "收藏此消息"}
              >
                <Star className={`h-3.5 w-3.5 ${bookmarked ? "fill-current" : ""}`} />
              </button>
            )}
          </div>
        </div>
      );
    }

    if (msg.role === "tool") {
      return (
        <div key={node.id}>
          <ToolOutputMessage message={msg} showTimestamp={showTimestamp} />
        </div>
      );
    }

    return (
      <div key={node.id}>
        <div onContextMenu={(event) => handleAssistantContextMenu(event, node)}>
          <AssistantMessage
            message={msg}
            source={source}
            showTimestamp={showTimestamp}
            showModel={showModel}
            threadAnchor={node.threadAnchor}
            threadHint={showActionButtons && node.forkUserMessageId ? "右击可从此回复分叉" : null}
          />
        </div>
      </div>
    );
  };

  if (!isThreaded) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        {roots.map((node) => renderMessage(node))}

        {assistantContextMenu && (
          <div
            className="fixed z-50 min-w-[11rem] rounded-lg border border-border bg-popover p-1 shadow-lg"
            style={{
              left: Math.min(assistantContextMenu.x, window.innerWidth - 220),
              top: Math.min(assistantContextMenu.y, window.innerHeight - 80),
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              onClick={handleAssistantFork}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              <GitFork className="h-4 w-4 text-primary" />
              从此回复继续分叉
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
      {roots.map((node) => (
        <ThreadBranch key={node.id} node={node} depth={0} renderMessage={renderMessage} />
      ))}

      {assistantContextMenu && (
        <div
          className="fixed z-50 min-w-[11rem] rounded-lg border border-border bg-popover p-1 shadow-lg"
          style={{
            left: Math.min(assistantContextMenu.x, window.innerWidth - 220),
            top: Math.min(assistantContextMenu.y, window.innerHeight - 80),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            onClick={handleAssistantFork}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            <GitFork className="h-4 w-4 text-primary" />
            从此回复继续分叉
          </button>
        </div>
      )}
    </div>
  );
}
