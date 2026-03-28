import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useChatStream } from "../../hooks/useChatStream";
import { ArrowLeft, Play, Copy, Loader2, ArrowDown, ArrowUp, Clock, Cpu, AlertCircle, Tag, Plus, X, Rows3, ChevronsUpDown, Columns2, Rows2 } from "lucide-react";
import { MessageThread } from "./MessageThread";
import { TimelineDots } from "./TimelineDots";
import { ChatInput } from "../chat/ChatInput";
import { StreamingMessage, getLinkedToolUseIds } from "../chat/StreamingMessage";
import { useActiveUserMessage } from "../../hooks/useActiveUserMessage";
import { formatTime } from "./utils";
import { api } from "../../services/api";
import { SessionMetaEditor } from "../session/SessionMetaEditor";
import type { DisplayMessage, SessionIndexEntry } from "../../types";
import { ExpandAllProvider } from "../common/ExpandAllContext";
import { useReplyNotification } from "../../hooks/useReplyNotification";

declare const __IS_TAURI__: boolean;
type MessageSource = "claude" | "codex";
type SplitDirection = "horizontal" | "vertical";

function useHorizontalDragScroll(enabled: boolean) {
  const dragStateRef = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    startScrollLeft: number;
    dragging: boolean;
    suppressClick: boolean;
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    startScrollLeft: 0,
    dragging: false,
    suppressClick: false,
  });
  const restoreStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);

  const stopDragging = useCallback((preserveSuppressClick = false) => {
    const state = dragStateRef.current;
    state.pointerId = null;
    state.startX = 0;
    state.startY = 0;
    state.startScrollLeft = 0;
    state.dragging = false;
    if (!preserveSuppressClick) {
      state.suppressClick = false;
    }

    if (restoreStyleRef.current) {
      document.body.style.cursor = restoreStyleRef.current.cursor;
      document.body.style.userSelect = restoreStyleRef.current.userSelect;
      restoreStyleRef.current = null;
    }
  }, []);

  useEffect(() => stopDragging, [stopDragging]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled || e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    if (
      !target ||
      target.closest(
        "button, a, input, textarea, select, label, summary, [role='button'], [role='link'], [contenteditable='true']"
      )
    ) {
      return;
    }

    const selection = window.getSelection();
    if (selection && selection.type === "Range") {
      return;
    }

    dragStateRef.current.pointerId = e.pointerId;
    dragStateRef.current.startX = e.clientX;
    dragStateRef.current.startY = e.clientY;
    dragStateRef.current.startScrollLeft = e.currentTarget.scrollLeft;
    dragStateRef.current.dragging = false;
    dragStateRef.current.suppressClick = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [enabled]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (state.pointerId !== e.pointerId) return;

    const deltaX = e.clientX - state.startX;
    const deltaY = e.clientY - state.startY;

    if (!state.dragging) {
      if (Math.abs(deltaX) < 6) return;
      if (Math.abs(deltaY) > Math.abs(deltaX)) {
        stopDragging();
        return;
      }

      state.dragging = true;
      state.suppressClick = true;
      restoreStyleRef.current = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
      };
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    }

    e.preventDefault();
    e.currentTarget.scrollLeft = state.startScrollLeft - deltaX;
  }, [stopDragging]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (state.pointerId !== e.pointerId) return;
    stopDragging(state.dragging);
  }, [stopDragging]);

  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current.pointerId !== e.pointerId) return;
    stopDragging();
  }, [stopDragging]);

  const onClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragStateRef.current.suppressClick) return;
    dragStateRef.current.suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
    isEnabled: enabled,
  };
}

export function MessagesPage() {
  const params = useParams();
  const projectId = params.projectId || "";
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const scrollToMessageId = searchParams.get("scrollTo");
  const matchedOnly = searchParams.get("matchedOnly") === "1";

  // Use React Router's wildcard param (already decoded) instead of manual pathname slicing
  const rawFilePath = params["*"] || "";
  const filePath = rawFilePath ? decodeURIComponent(rawFilePath) : "";

  const {
    source,
    messages,
    messagesLoading,
    messagesHasMore,
    messagesTotal,
    selectSession,
    selectProject,
    loadMoreMessages,
    sessions,
    projects,
    searchResults,
    showTimestamp,
    showModel,
    toggleTimestamp,
    toggleModel,
  } = useAppStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [showScrollUp, setShowScrollUp] = useState(false);
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  const prevScrollHeightRef = useRef<number>(0);
  const isLoadingOlderRef = useRef(false);
  const scrolledTargetRef = useRef<string | null>(null);
  const [expandVersion, setExpandVersion] = useState(0);
  const [allExpanded, setAllExpanded] = useState(true);
  const [splitFilePaths, setSplitFilePaths] = useState<string[]>([]);
  const [showSplitPicker, setShowSplitPicker] = useState(false);
  const [splitDirection, setSplitDirection] = useState<SplitDirection>("horizontal");

  // Chat store for inline continue-chat
  const {
    messages: chatMessages,
    isStreaming: chatStreaming,
    error: chatError,
    availableClis,
    detectCli,
    continueExistingChat,
    cancelChat,
    clearChat,
    setProjectPath: setChatProjectPath,
    setModel: setChatModel,
    setSource: setChatSource,
    fetchModelList: fetchChatModelList,
    model: chatModel,
  } = useChatStore();

  const session = sessions.find((s) => s.filePath === filePath);
  const searchHit = searchResults.find((r) => r.filePath === filePath);
  const project = projects.find((p) => p.id === projectId);
  const resolvedSessionId = session?.sessionId || searchHit?.sessionId || null;
  const resolvedSessionTitle =
    session?.alias ||
    session?.firstPrompt ||
    searchHit?.alias ||
    searchHit?.firstPrompt ||
    resolvedSessionId ||
    "Session";

  const chatProjectPath =
    session?.projectPath ||
    session?.cwd ||
    project?.displayPath ||
    (source === "codex" ? searchHit?.projectId : "") ||
    "";

  // Listen for chat stream events
  useChatStream(resolvedSessionId);
  const cliAvailable = availableClis.some((c) => c.cliType === source);
  const [editingSession, setEditingSession] = useState(false);

  // Detect CLI and set chat context on mount
  useEffect(() => {
    detectCli();
  }, [detectCli]);

  // Sync source from appStore into chatStore, then refresh model list
  useEffect(() => {
    setChatSource(source);
    fetchChatModelList();
  }, [source, setChatSource, fetchChatModelList]);

  // Extract the model used in this historical session
  const sessionModel = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].model) {
        return messages[i].model!;
      }
    }
    return null;
  }, [messages]);

  useEffect(() => {
    setChatProjectPath(chatProjectPath);
  }, [chatProjectPath, setChatProjectPath]);

  // Set chat model from the historical session's model when entering a session
  const modelInitRef = useRef<string>("");
  useEffect(() => {
    if (sessionModel && modelInitRef.current !== filePath) {
      modelInitRef.current = filePath;
      setChatModel(sessionModel);
    }
  }, [filePath, sessionModel, setChatModel]);

  // Clear chat state when leaving the page / switching sessions
  useEffect(() => {
    return () => {
      clearChat();
    };
  }, [filePath, clearChat]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    setInitialScrollDone(false);
    scrolledTargetRef.current = null;

    const load = async () => {
      // 从搜索跳转时 sessions 可能持有其他项目数据，需先加载正确的项目会话列表
      if (projectId && !sessions.some(s => s.filePath === filePath)) {
        await selectProject(projectId);
      }
      if (!cancelled) {
        selectSession(filePath);
      }
    };
    load();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    if (!matchedOnly || !scrollToMessageId || messagesLoading) return;
    const found = messages.some((msg) => msg.uuid === scrollToMessageId);
    if (!found && messagesHasMore) {
      loadMoreMessages();
    }
  }, [matchedOnly, scrollToMessageId, messages, messagesHasMore, messagesLoading, loadMoreMessages]);

  // Auto-scroll to bottom on initial load
  useEffect(() => {
    if (!initialScrollDone && messages.length > 0 && !messagesLoading) {
      // If scrollTo param is set, skip auto-scroll to bottom
      if (scrollToMessageId) {
        setInitialScrollDone(true);
        return;
      }
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
        setInitialScrollDone(true);
      });
    }
  }, [messages, messagesLoading, initialScrollDone, scrollToMessageId]);

  // Scroll to specific message when scrollTo param is set
  useEffect(() => {
    if (!scrollToMessageId || !initialScrollDone || messagesLoading) return;
    if (scrolledTargetRef.current === scrollToMessageId) return;
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector(
        `[data-user-msg-id="${scrollToMessageId}"]`
      );
      if (el) {
        scrolledTargetRef.current = scrollToMessageId;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        // Flash highlight
        el.classList.add("ring-2", "ring-yellow-500/50", "rounded-lg");
        setTimeout(() => {
          el.classList.remove("ring-2", "ring-yellow-500/50", "rounded-lg");
        }, 2000);
      }
    });
  }, [scrollToMessageId, initialScrollDone, messagesLoading]);

  // Preserve scroll position after prepending older messages
  useEffect(() => {
    if (isLoadingOlderRef.current && !messagesLoading && containerRef.current) {
      const newScrollHeight = containerRef.current.scrollHeight;
      const addedHeight = newScrollHeight - prevScrollHeightRef.current;
      containerRef.current.scrollTop += addedHeight;
      isLoadingOlderRef.current = false;
    }
  }, [messages, messagesLoading]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;

    // Show scroll-to-bottom when not near bottom
    setShowScrollDown(scrollHeight - scrollTop - clientHeight > 400);
    // Show scroll-to-top when not near top
    setShowScrollUp(scrollTop > 400);

    // Load older messages when scrolling near top
    if (!messagesLoading && messagesHasMore && scrollTop < 200) {
      isLoadingOlderRef.current = true;
      prevScrollHeightRef.current = scrollHeight;
      loadMoreMessages();
    }
  }, [messagesLoading, messagesHasMore, loadMoreMessages]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const scrollToTop = () => {
    containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Timeline dots: extract user message data
  const userDots = useMemo(() => {
    let userIndex = 0;
    return messages
      .map((msg, i) => {
        if (msg.role !== "user") return null;
        const id = msg.uuid || `user-${i}`;
        const textContent = msg.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        const preview = textContent
          ? textContent.slice(0, 50) + (textContent.length > 50 ? "..." : "")
          : "（用户消息）";
        return {
          id,
          index: userIndex++,
          preview,
          timestamp: msg.timestamp ? formatTime(msg.timestamp) : null,
        };
      })
      .filter(Boolean) as Array<{ id: string; index: number; preview: string; timestamp: string | null }>;
  }, [messages]);

  const userMessageIds = useMemo(() => userDots.map((d) => d.id), [userDots]);
  const activeUserMsgId = useActiveUserMessage(containerRef, userMessageIds);

  const handleDotClick = useCallback((id: string) => {
    const el = containerRef.current?.querySelector(`[data-user-msg-id="${id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const displayedMessages = useMemo(() => {
    if (!matchedOnly || !scrollToMessageId) return messages;
    const idx = messages.findIndex((msg) => msg.uuid === scrollToMessageId);
    if (idx === -1) return messages;
    return buildFocusedMessages(messages, idx);
  }, [messages, matchedOnly, scrollToMessageId]);
  const assistantName = assistantNameFromSource(source);

  const latestReply = useMemo(() => {
    if (chatMessages.length > 0) {
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role !== "assistant") continue;
        const firstText = chatMessages[i].content.find((block) => block.type === "text");
        return {
          key: `${chatMessages[i].id}:${chatMessages[i].timestamp}`,
          preview: firstText && "text" in firstText ? firstText.text.slice(0, 80) : "有新回复",
        };
      }
      return null;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "assistant") continue;
      const firstText = messages[i].content.find((block) => block.type === "text");
      return {
        key: `${messages[i].uuid ?? i}:${messages[i].timestamp}`,
        preview: firstText && "text" in firstText ? firstText.text.slice(0, 80) : "有新回复",
      };
    }

    return null;
  }, [messages, chatMessages]);

  useReplyNotification(
    latestReply?.key ?? null,
    `${assistantName} 有新回复`,
    latestReply?.preview || "点击查看最新消息"
  );

  const [copied, setCopied] = useState(false);

  const getResumeCommand = () => {
    if (!resolvedSessionId) return "";
    return source === "claude"
      ? `claude --resume ${resolvedSessionId}`
      : `codex resume ${resolvedSessionId}`;
  };

  const handleCopyCommand = async (e: React.MouseEvent) => {
    e.preventDefault();
    await navigator.clipboard.writeText(getResumeCommand());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const { terminalShell } = useAppStore();

  const [resumeError, setResumeError] = useState<string | null>(null);

  const handleResume = async () => {
    if (!resolvedSessionId) return;
    setResumeError(null);
    if (__IS_TAURI__) {
      const path = session?.projectPath || session?.cwd || project?.displayPath || chatProjectPath;
      if (!path) return;
      try {
        await api.resumeSession(source, resolvedSessionId, path, filePath, terminalShell);
      } catch (err) {
        const msg = typeof err === "string" ? err : String(err);
        setResumeError(msg);
        setTimeout(() => setResumeError(null), 5000);
      }
    } else {
      const cmd = getResumeCommand();
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Auto-scroll when new chat messages arrive
  useEffect(() => {
    if (chatMessages.length > 0 || chatStreaming) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    }
  }, [chatMessages, chatStreaming]);

  const handleSendChat = (prompt: string) => {
    if (!resolvedSessionId) return;
    continueExistingChat(
      resolvedSessionId,
      chatProjectPath,
      prompt,
      chatModel
    );
  };

  const handleSubmitAnswers = useCallback(async (answers: string) => {
    if (!resolvedSessionId || !chatProjectPath) return;
    if (chatStreaming) {
      await cancelChat();
      setTimeout(() => {
        continueExistingChat(resolvedSessionId, chatProjectPath, answers, chatModel);
      }, 150);
      return;
    }
    continueExistingChat(resolvedSessionId, chatProjectPath, answers, chatModel);
  }, [cancelChat, chatModel, chatProjectPath, chatStreaming, continueExistingChat, resolvedSessionId]);

  const availableSplitSessions = sessions.filter(
    (item) => item.filePath !== filePath && !splitFilePaths.includes(item.filePath)
  );
  const isSplitHorizontal = splitFilePaths.length > 0 && splitDirection === "horizontal";
  const splitScrollDrag = useHorizontalDragScroll(isSplitHorizontal);

  return (
    <div className="flex flex-col h-full relative">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-card px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate(`/projects/${encodeURIComponent(projectId)}`)}
            className="p-1 rounded hover:bg-accent transition-colors shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {resolvedSessionTitle}
            </p>
            <p className="text-xs text-muted-foreground">
              {messages.length < messagesTotal
                ? `已加载 ${messages.length} / ${messagesTotal} 条消息`
                : `${messagesTotal} 条消息`}
              {session?.gitBranch && ` · ${session.gitBranch}`}
              {` · ${assistantName}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={toggleTimestamp}
            className={`p-1.5 rounded transition-colors ${
              showTimestamp ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
            title="显示时间"
          >
            <Clock className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={toggleModel}
            className={`p-1.5 rounded transition-colors ${
              showModel ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
            title="显示模型"
          >
            <Cpu className="w-3.5 h-3.5" />
          </button>
          {resolvedSessionId && (
            <button
              onClick={() => setEditingSession(true)}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="编辑标签和别名"
            >
              <Tag className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => setShowSplitPicker((v) => !v)}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="分屏查看其他会话"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          {splitFilePaths.length > 0 && (
            <button
              onClick={() =>
                setSplitDirection((prev) => (prev === "horizontal" ? "vertical" : "horizontal"))
              }
              className={`px-2 py-1.5 rounded text-xs flex items-center gap-1 transition-colors ${
                splitDirection === "horizontal"
                  ? "bg-primary/15 text-primary hover:bg-primary/20"
                  : "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400"
              }`}
              title={splitDirection === "horizontal" ? "切换为上下分屏" : "切换为左右分屏"}
            >
              {splitDirection === "horizontal" ? (
                <>
                  <Columns2 className="w-3.5 h-3.5" />
                  左右分屏
                </>
              ) : (
                <>
                  <Rows2 className="w-3.5 h-3.5" />
                  上下分屏
                </>
              )}
            </button>
          )}
          <button
            onClick={() => {
              setAllExpanded(true);
              setExpandVersion((v) => v + 1);
            }}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="全部展开"
          >
            <Rows3 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              setAllExpanded(false);
              setExpandVersion((v) => v + 1);
            }}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="全部折叠"
          >
            <ChevronsUpDown className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleResume}
            className="ml-1 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-1"
            title={__IS_TAURI__ ? "在终端中恢复此会话" : "复制恢复命令"}
          >
            {__IS_TAURI__ ? (
              <><Play className="w-3 h-3" />Resume</>
            ) : (
              <>
                {copied ? "已复制" : <><Copy className="w-3 h-3" />复制命令</>}
              </>
            )}
          </button>
          {__IS_TAURI__ && (
            <button
              onClick={handleCopyCommand}
              className="px-3 py-1.5 text-xs border border-border text-muted-foreground rounded-md hover:bg-accent hover:text-foreground flex items-center gap-1"
              title="复制恢复命令"
            >
              {copied ? (
                <>已复制</>
              ) : (
                <><Copy className="w-3 h-3" />复制命令</>
              )}
            </button>
          )}
        </div>
      </div>

      {showSplitPicker && availableSplitSessions.length > 0 && (
        <div className="mx-4 mt-2 rounded-lg border border-border bg-card shadow-sm max-w-md">
          <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
            选择要分屏查看的会话
          </div>
          <div className="max-h-56 overflow-y-auto">
            {availableSplitSessions.map((item) => (
              <button
                key={item.filePath}
                onClick={() => {
                  setSplitFilePaths((prev) => [...prev, item.filePath]);
                  setShowSplitPicker(false);
                }}
                className="w-full px-3 py-2 text-left hover:bg-accent transition-colors"
              >
                <div className="text-sm text-foreground truncate">
                  {item.alias || item.firstPrompt || item.sessionId}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {item.messageCount} 条消息
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {matchedOnly && scrollToMessageId && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2 text-sm">
          <span className="text-muted-foreground">当前仅显示匹配消息片段</span>
          <button
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("matchedOnly");
              setSearchParams(next, { replace: true });
            }}
            className="text-primary hover:text-primary/80 transition-colors"
          >
            显示全部消息
          </button>
        </div>
      )}

      {/* Load progress bar — only visible when not all messages are loaded */}
      {messagesHasMore && messages.length < messagesTotal && (
        <div className="h-0.5 bg-muted shrink-0">
          <div
            className="h-full bg-primary/40 transition-all duration-300"
            style={{ width: `${Math.round((messages.length / messagesTotal) * 100)}%` }}
          />
        </div>
      )}

      {/* Resume error toast */}
      {resumeError && (
        <div className="mx-4 mt-2 px-4 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
          {resumeError}
        </div>
      )}

      <ExpandAllProvider value={{ expanded: allExpanded, version: expandVersion }}>
        <div
          className={`flex-1 min-h-0 ${
            isSplitHorizontal ? "overflow-x-auto overflow-y-hidden" : "overflow-y-auto"
          } ${splitScrollDrag.isEnabled ? "cursor-grab" : ""}`}
          onPointerDown={splitScrollDrag.onPointerDown}
          onPointerMove={splitScrollDrag.onPointerMove}
          onPointerUp={splitScrollDrag.onPointerUp}
          onPointerCancel={splitScrollDrag.onPointerCancel}
          onClickCapture={splitScrollDrag.onClickCapture}
        >
          <div
            className={`gap-3 p-3 ${
              isSplitHorizontal
                ? "flex min-h-full min-w-full w-max"
                : "flex min-h-full min-w-0 flex-col"
            }`}
          >
            <div
              className={`flex flex-col rounded-lg border border-border bg-card ${
                splitFilePaths.length === 0
                  ? "min-w-0 flex-1"
                  : isSplitHorizontal
                    ? "w-[min(70vw,64rem)] min-w-[28rem] shrink-0"
                    : "min-h-[28rem] max-h-[70vh] min-w-0 shrink-0"
              }`}
            >
              <div
                ref={containerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto"
              >
                {messagesLoading && messages.length > 0 && messagesHasMore && (
                  <div className="flex items-center justify-center py-4 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    加载更早的消息...
                  </div>
                )}
                {!messagesHasMore && messages.length > 0 && (
                  <div className="text-center py-4 text-xs text-muted-foreground">
                    — 会话开始 —
                  </div>
                )}
                {messagesLoading && messages.length === 0 ? (
                  <div className="flex items-center justify-center h-32 text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" />
                    加载消息中...
                  </div>
                ) : (
                  <MessageThread
                    messages={displayedMessages}
                    source={source}
                    showTimestamp={showTimestamp}
                    showModel={showModel}
                    sessionId={resolvedSessionId ?? undefined}
                    projectId={projectId}
                    filePath={filePath}
                    sessionTitle={resolvedSessionTitle}
                    projectName={project?.shortName || projectId}
                    projectPath={chatProjectPath}
                  />
                )}
                {!messagesLoading && messages.length > 0 && chatMessages.length === 0 && !chatStreaming && (
                  <div className="text-center py-4 text-xs text-muted-foreground">
                    — 会话结束 —
                  </div>
                )}

                {chatMessages.length > 0 && (
                  <ChatMessagesBlock
                    messages={chatMessages}
                    onSubmitAnswers={handleSubmitAnswers}
                  />
                )}
                {chatStreaming && (
                  <div className="max-w-4xl mx-auto px-6">
                    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                      <div className="flex gap-1">
                        <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.3s]" />
                        <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.15s]" />
                        <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" />
                      </div>
                    </div>
                  </div>
                )}
                {chatError && (
                  <div className="max-w-4xl mx-auto px-6">
                    <div className="flex items-center gap-2 py-2 text-sm text-red-400">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      {chatError}
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            </div>

            {splitFilePaths.map((splitPath) => (
              <SplitSessionPane
                key={splitPath}
                source={source}
                filePath={splitPath}
                showTimestamp={showTimestamp}
                showModel={showModel}
                session={sessions.find((item) => item.filePath === splitPath) || null}
                splitDirection={splitDirection}
                onClose={() => setSplitFilePaths((prev) => prev.filter((item) => item !== splitPath))}
              />
            ))}
          </div>
        </div>
      </ExpandAllProvider>

      {/* Chat input */}
      {resolvedSessionId && cliAvailable && (
        <div className="shrink-0">
          <ChatInput
            onSend={handleSendChat}
            onCancel={cancelChat}
            isStreaming={chatStreaming}
            disabled={!chatProjectPath}
          />
        </div>
      )}

      {/* Timeline navigation dots */}
      {userDots.length > 1 && (
        <TimelineDots
          dots={userDots}
          activeId={activeUserMsgId}
          onDotClick={handleDotClick}
        />
      )}

      {/* Scroll buttons */}
      <div className="absolute bottom-20 right-6 flex flex-col gap-2">
        {showScrollUp && (
          <button
            onClick={scrollToTop}
            className="p-2.5 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all hover:scale-105"
            title="跳转到顶部"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        )}
        {showScrollDown && (
          <button
            onClick={scrollToBottom}
            className="p-2.5 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all hover:scale-105"
            title="跳转到底部"
          >
            <ArrowDown className="w-4 h-4" />
          </button>
        )}
      </div>

      {editingSession && resolvedSessionId && (
        <SessionMetaEditor
          sessionId={resolvedSessionId}
          currentAlias={session?.alias || searchHit?.alias || null}
          currentTags={session?.tags || searchHit?.tags || null}
          onClose={() => setEditingSession(false)}
        />
      )}
    </div>
  );
}

function buildFocusedMessages(messages: DisplayMessage[], targetIndex: number): DisplayMessage[] {
  if (targetIndex < 0 || targetIndex >= messages.length) return messages;

  let start = targetIndex;
  let end = targetIndex;
  const target = messages[targetIndex];

  if (target.role !== "user") {
    for (let i = targetIndex - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        start = i;
        break;
      }
    }
  }

  for (let i = targetIndex + 1; i < messages.length; i++) {
    if (messages[i].role === "user") {
      break;
    }
    end = i;
  }

  return messages.slice(start, end + 1);
}

function SplitSessionPane({
  source,
  filePath,
  showTimestamp,
  showModel,
  session,
  splitDirection,
  onClose,
}: {
  source: MessageSource;
  filePath: string;
  showTimestamp: boolean;
  showModel: boolean;
  session: SessionIndexEntry | null;
  splitDirection: SplitDirection;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialScrollDoneRef = useRef(false);
  const requestVersionRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  const isLoadingOlderRef = useRef(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);

  const sessionTitle =
    session?.alias ||
    session?.firstPrompt ||
    session?.sessionId ||
    filePath;

  const loadMessages = useCallback(
    async (nextPage: number, mode: "replace" | "prepend") => {
      const requestVersion = ++requestVersionRef.current;
      setLoading(true);
      if (mode === "replace") {
        setError(null);
      }

      try {
        const result = await api.getMessages(source, filePath, nextPage, 50, true);
        if (requestVersionRef.current !== requestVersion) return;

        setMessages((prev) =>
          mode === "prepend" ? [...result.messages, ...prev] : result.messages
        );
        setPage(nextPage);
        setHasMore(result.hasMore);
        setTotal(result.total);
      } catch (err) {
        if (requestVersionRef.current !== requestVersion) return;
        setError(typeof err === "string" ? err : String(err));
      } finally {
        if (requestVersionRef.current === requestVersion) {
          setLoading(false);
        }
      }
    },
    [filePath, source]
  );

  useEffect(() => {
    initialScrollDoneRef.current = false;
    isLoadingOlderRef.current = false;
    setMessages([]);
    setPage(0);
    setHasMore(false);
    setTotal(0);
    setError(null);
    void loadMessages(0, "replace");

    return () => {
      requestVersionRef.current += 1;
    };
  }, [loadMessages]);

  useEffect(() => {
    if (!initialScrollDoneRef.current && messages.length > 0 && !loading) {
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
        initialScrollDoneRef.current = true;
      });
    }
  }, [loading, messages]);

  useEffect(() => {
    if (isLoadingOlderRef.current && !loading && containerRef.current) {
      const newScrollHeight = containerRef.current.scrollHeight;
      containerRef.current.scrollTop += newScrollHeight - prevScrollHeightRef.current;
      isLoadingOlderRef.current = false;
    }
  }, [loading, messages]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current || loading || !hasMore) return;
    const { scrollTop, scrollHeight } = containerRef.current;
    if (scrollTop < 200) {
      isLoadingOlderRef.current = true;
      prevScrollHeightRef.current = scrollHeight;
      void loadMessages(page + 1, "prepend");
    }
  }, [hasMore, loadMessages, loading, page]);

  return (
    <div
      className={`flex shrink-0 flex-col rounded-lg border border-border bg-card ${
        splitDirection === "horizontal"
          ? "w-[24rem] min-w-[22rem] max-w-[30rem]"
          : "min-h-[24rem] max-h-[56vh] min-w-0"
      }`}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{sessionTitle}</p>
          <p className="text-xs text-muted-foreground">
            只读分屏
            {total > 0 && ` · ${messages.length < total ? `已加载 ${messages.length} / ${total}` : `${total} 条消息`}`}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="关闭分屏"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {loading && messages.length > 0 && hasMore && (
          <div className="flex items-center justify-center py-4 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载更早的消息...
          </div>
        )}

        {!hasMore && messages.length > 0 && (
          <div className="py-4 text-center text-xs text-muted-foreground">
            — 会话开始 —
          </div>
        )}

        {loading && messages.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            加载消息中...
          </div>
        ) : error ? (
          <div className="px-4 py-6 text-sm text-destructive">{error}</div>
        ) : (
          <MessageThread
            messages={messages}
            source={source}
            showTimestamp={showTimestamp}
            showModel={showModel}
          />
        )}

        {!loading && !error && messages.length > 0 && (
          <div className="py-4 text-center text-xs text-muted-foreground">
            — 会话结束 —
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Helper: Chat messages with tool linking ── */

function ChatMessagesBlock({
  messages,
  onSubmitAnswers,
}: {
  messages: import("../../types/chat").ChatMessage[];
  onSubmitAnswers: (answers: string) => void;
}) {
  const { toolResultMap, linkedToolUseIds } = useMemo(() => {
    const resultMap = new Map<string, { content: string; isError: boolean }>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          resultMap.set(block.toolUseId, { content: block.content, isError: block.isError });
        }
      }
    }

    const linkedIds = new Set<string>();
    for (const msg of messages) {
      for (const toolUseId of getLinkedToolUseIds(msg, resultMap)) {
        linkedIds.add(toolUseId);
      }
    }

    return { toolResultMap: resultMap, linkedToolUseIds: linkedIds };
  }, [messages]);

  return (
    <div className="max-w-4xl mx-auto px-6 py-2 space-y-1 border-t border-dashed border-border mt-2">
      {messages.map((msg) => (
        <StreamingMessage
          key={msg.id}
          message={msg}
          toolResultMap={toolResultMap}
          linkedToolUseIds={linkedToolUseIds}
          onSubmitAnswers={onSubmitAnswers}
          interactiveQuestions
        />
      ))}
    </div>
  );
}

function assistantNameFromSource(source: MessageSource) {
  return source === "codex" ? "Codex" : "Claude";
}
