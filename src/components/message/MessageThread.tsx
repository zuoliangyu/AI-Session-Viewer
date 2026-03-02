import { useState } from "react";
import type { DisplayMessage } from "../../types";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ToolOutputMessage } from "./ToolOutputMessage";
import { useAppStore } from "../../stores/appStore";
import { Star, GitFork, Play, Loader2 } from "lucide-react";
import { api } from "../../services/api";

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

export function MessageThread({ messages, source, showTimestamp, showModel, sessionId, projectId, filePath, sessionTitle, projectName, projectPath }: MessageThreadProps) {
  const { addBookmark, removeBookmark, isBookmarked, bookmarks, terminalShell, refreshInBackground } = useAppStore();
  const [forkingMsgId, setForkingMsgId] = useState<string | null>(null);
  const [forkSuccessMsgId, setForkSuccessMsgId] = useState<string | null>(null);

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
      // Refresh sessions in background
      refreshInBackground();
    } catch (err) {
      console.error("Failed to fork session:", err);
    } finally {
      setForkingMsgId(null);
    }
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

  return (
    <div className="max-w-3xl mx-auto py-6 px-6 space-y-6">
      {messages.map((msg, i) => {
        if (msg.role === "user") {
          const msgId = msg.uuid || `user-${i}`;
          const bookmarked = sessionId ? isBookmarked(sessionId, msgId) : false;
          const canFork = showActionButtons && msg.uuid;
          const canResume = showActionButtons && sessionId;
          const isForking = forkingMsgId === msgId;
          const isForkSuccess = forkSuccessMsgId === msgId;
          return (
            <div key={msgId} data-user-msg-id={msgId} className="group/bookmark flex items-start justify-end gap-1.5">
              <div className="min-w-0">
                <UserMessage message={msg} showTimestamp={showTimestamp} />
              </div>
              <div className="flex flex-col gap-0.5 shrink-0">
                {canResume && (
                  <button
                    onClick={handleResumeFromMessage}
                    className="mt-1 p-1 rounded transition-all text-muted-foreground opacity-0 group-hover/bookmark:opacity-100 hover:text-primary"
                    title="在终端中恢复此会话"
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                )}
                {canFork && (
                  <button
                    onClick={() => handleFork(msgId)}
                    disabled={isForking}
                    className={`p-1 rounded transition-all ${
                      isForkSuccess
                        ? "text-green-500 opacity-100"
                        : isForking
                          ? "text-muted-foreground opacity-100"
                          : "text-muted-foreground opacity-0 group-hover/bookmark:opacity-100 hover:text-primary"
                    }`}
                    title="从此处分叉新会话"
                  >
                    {isForking ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <GitFork className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}
                {sessionId && (
                  <button
                    onClick={() => handleToggleBookmark(msg, msgId)}
                    className={`p-1 rounded transition-all ${
                      bookmarked
                        ? "text-yellow-500 opacity-100"
                        : "text-muted-foreground opacity-0 group-hover/bookmark:opacity-100 hover:text-yellow-500"
                    }`}
                    title={bookmarked ? "取消收藏" : "收藏此消息"}
                  >
                    <Star className={`w-3.5 h-3.5 ${bookmarked ? "fill-current" : ""}`} />
                  </button>
                )}
              </div>
            </div>
          );
        }
        if (msg.role === "tool") {
          return <ToolOutputMessage key={msg.uuid || i} message={msg} showTimestamp={showTimestamp} />;
        }
        return <AssistantMessage key={msg.uuid || i} message={msg} source={source} showTimestamp={showTimestamp} showModel={showModel} />;
      })}
    </div>
  );
}
