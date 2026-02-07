import { useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { ArrowLeft, Play, Loader2 } from "lucide-react";
import { MessageThread } from "./MessageThread";
import { resumeSession } from "../../services/tauriApi";

export function MessagesPage() {
  const { encodedName, sessionId } = useParams<{
    encodedName: string;
    sessionId: string;
  }>();
  const navigate = useNavigate();
  const {
    messages,
    messagesLoading,
    messagesHasMore,
    messagesTotal,
    selectSession,
    loadMoreMessages,
    sessions,
    projects,
  } = useAppStore();

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const session = sessions.find((s) => s.sessionId === sessionId);
  const project = projects.find((p) => p.encodedName === encodedName);

  useEffect(() => {
    if (encodedName && sessionId) {
      selectSession(encodedName, sessionId);
    }
  }, [encodedName, sessionId]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current || messagesLoading || !messagesHasMore) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    if (scrollHeight - scrollTop - clientHeight < 200) {
      loadMoreMessages();
    }
  }, [messagesLoading, messagesHasMore, loadMoreMessages]);

  const handleResume = async () => {
    if (!sessionId) return;
    const path =
      session?.projectPath || project?.displayPath;
    if (!path) return;
    try {
      await resumeSession(sessionId, path);
    } catch (err) {
      console.error("Failed to resume session:", err);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-card px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate(`/projects/${encodedName}`)}
            className="p-1 rounded hover:bg-accent transition-colors shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {session?.firstPrompt || sessionId}
            </p>
            <p className="text-xs text-muted-foreground">
              {messagesTotal} 条消息
              {session?.gitBranch && ` · ${session.gitBranch}`}
            </p>
          </div>
        </div>
        <button
          onClick={handleResume}
          className="shrink-0 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-1"
        >
          <Play className="w-3 h-3" />
          Resume
        </button>
      </div>

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {messagesLoading && messages.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            加载消息中...
          </div>
        ) : (
          <>
            <MessageThread messages={messages} />
            {messagesLoading && messages.length > 0 && (
              <div className="flex items-center justify-center py-4 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                加载更多...
              </div>
            )}
            {!messagesHasMore && messages.length > 0 && (
              <div className="text-center py-4 text-xs text-muted-foreground">
                — 会话结束 —
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
