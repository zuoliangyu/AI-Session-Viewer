import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import {
  Profiler,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { ArrowLeft, Play, Copy, Loader2, ArrowDown, ArrowUp, AlertCircle, Tag, Plus, X, Rows3, ChevronsUpDown, Columns2, ListTree, MessageSquare } from "lucide-react";
import { ActionMenu } from "../common/ActionMenu";
import { rememberSession } from "../../services/recentSessions";
import { MessageThread } from "./MessageThread";
import { ThreadSummaryView } from "./ThreadSummaryView";
import { SelectionReplyButton } from "./SelectionReplyButton";
import { TimelineDots } from "./TimelineDots";
import { MessageTOCSidebar } from "./MessageTOCSidebar";
import { JumpToPercentControl } from "./JumpToPercentControl";
import { SessionPositionRail } from "./SessionPositionRail";
import { ChatInput, type ChatInputHandle } from "../chat/ChatInput";
import { StreamingMessage, getLinkedToolUseIds } from "../chat/StreamingMessage";
import { useActiveUserMessage } from "../../hooks/useActiveUserMessage";
import { copyTextToClipboard, formatTime } from "./utils";
import { api } from "../../services/api";
import { subscribeToChatWebSocketMessages } from "../../services/webApi";
import { SessionMetaEditor } from "../session/SessionMetaEditor";
import { ScrollArea } from "../ScrollArea";
import type { DisplayMessage, QuestionIndexEntry, SessionIndexEntry } from "../../types";
import type { ChatMessage } from "../../types/chat";
import { ExpandAllProvider } from "../common/ExpandAllContext";
import { useReplyNotification } from "../../hooks/useReplyNotification";
import { SessionCostBadge } from "./SessionCostBadge";
import { TrajectoryView } from "./TrajectoryView";
import { isRemoteNodeActive } from "../../services/nodeConfig";
import {
  PERF_DIAGNOSTICS_ENABLED,
  consumePendingMessageCommit,
  getBrowserPerfSnapshot,
  getMessagesPerfFields,
  recordMessagesProfilerRender,
  recordPerfDiagnostic,
  recordPerfProfilerRender,
} from "../../utils/perfDiagnostics";

declare const __IS_TAURI__: boolean;
const USE_TAURI_TRANSPORT = __IS_TAURI__ && !isRemoteNodeActive();
type MessageSource = "claude" | "codex" | "grok" | "omp";
type SplitDirection = "horizontal" | "vertical";

const SPLIT_PANE_MESSAGES_PAGE_SIZE = 50;
// Below this many total messages a single window already covers everything,
// so the percentage-jump controls add nothing — hide them.
const JUMP_CONTROLS_MIN_TOTAL = 60;

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

function getMessagesPaneId(filePath: string) {
  return `messages:${filePath || "unknown"}`;
}

function isActualChatError(line: string): boolean {
  const lower = line.toLowerCase().trim();
  if (!lower) return false;
  if (lower.startsWith("[request interrupted")) return false;
  if (lower.startsWith("warning:")) return false;
  if (lower.startsWith("info:")) return false;
  if (lower.startsWith("debug:")) return false;
  if (lower.includes("error") || lower.includes("fatal") || lower.includes("panic")) return true;
  return true;
}

function handlePaneWebChatMessage(
  paneId: string,
  targetStreamId: string | null | undefined,
  rawMessage: string
): void {
  const {
    addStreamLineToPane,
    getPaneState,
    setPaneError,
    setPaneStreaming,
  } = useChatStore.getState();

  try {
    const data = JSON.parse(rawMessage);
    const type = typeof data?.type === "string" ? data.type : "";
    const payload =
      typeof data?.data === "string"
        ? data.data
        : typeof data?.payload === "string"
          ? data.payload
          : "";
    const eventSessionId =
      typeof data?.sessionId === "string"
        ? data.sessionId
        : typeof data?.session_id === "string"
          ? data.session_id
          : null;
    const pane = getPaneState(paneId);
    const routingKey = pane.streamId ?? targetStreamId ?? null;

    // Strict per-stream routing: a frame must carry our routing key (the
    // server tags every frame with sessionId) and our pane must have one to
    // compare against. Untagged frames or mismatches are dropped.
    if (!eventSessionId || !routingKey || eventSessionId !== routingKey) {
      // The handshake echo for `session_id` is consumed in webApi.ts; we can
      // safely ignore everything else that doesn't carry our routing key.
      return;
    }

    if (type === "output" || type === "chunk") {
      if (payload && pane.isStreaming) {
        addStreamLineToPane(paneId, payload);
      }
      return;
    }

    if (type === "error" || type === "auth_required") {
      if (type === "auth_required") {
        setPaneStreaming(paneId, false);
        window.dispatchEvent(new CustomEvent("asv-auth-required"));
      }
      if (payload && isActualChatError(payload)) {
        setPaneError(paneId, payload);
      }
      return;
    }

    if (type === "complete" || type === "done") {
      setPaneStreaming(paneId, false);
    }
  } catch {
    // ignore non-JSON frames
  }
}

function usePaneChatStream(paneId: string, streamIdOverride?: string | null) {
  const paneStreamId = useChatStore(
    useCallback((state) => state.panes[paneId]?.streamId ?? null, [paneId])
  );
  // Prefer the pane's own streamId once a turn is live; fall back to the
  // override (the URL session id) so we still receive frames after a fresh
  // navigation, before the user has typed anything.
  const targetStreamId = paneStreamId ?? streamIdOverride ?? null;
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!targetStreamId) return;

    if (USE_TAURI_TRANSPORT) {
      const addStreamLineToPane = useChatStore.getState().addStreamLineToPane;
      const setPaneStreaming = useChatStore.getState().setPaneStreaming;
      const setPaneError = useChatStore.getState().setPaneError;
      let cancelled = false;

      const setupListeners = async () => {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;

        const unlistenOutput = await listen<string>(
          `chat-output:${targetStreamId}`,
          (event) => {
            if (!cancelled) {
              addStreamLineToPane(paneId, event.payload);
            }
          }
        );
        if (cancelled) {
          unlistenOutput();
          return;
        }

        const unlistenError = await listen<string>(
          `chat-error:${targetStreamId}`,
          (event) => {
            if (!cancelled && event.payload && isActualChatError(event.payload)) {
              setPaneError(paneId, event.payload);
            }
          }
        );
        if (cancelled) {
          unlistenOutput();
          unlistenError();
          return;
        }

        const unlistenComplete = await listen<string>(
          `chat-complete:${targetStreamId}`,
          () => {
            if (!cancelled) {
              setPaneStreaming(paneId, false);
            }
          }
        );
        if (cancelled) {
          unlistenOutput();
          unlistenError();
          unlistenComplete();
          return;
        }

        cleanupRef.current = () => {
          unlistenOutput();
          unlistenError();
          unlistenComplete();
        };
      };

      void setupListeners();

      return () => {
        cancelled = true;
        if (cleanupRef.current) {
          cleanupRef.current();
          cleanupRef.current = null;
        }
      };
    }

    const unsubscribe = subscribeToChatWebSocketMessages((rawMessage) => {
      handlePaneWebChatMessage(paneId, targetStreamId, rawMessage);
    });

    return () => {
      unsubscribe();
    };
  }, [paneId, targetStreamId]);
}

export function MessagesPage() {
  const { t } = useTranslation();
  const params = useParams();
  const location = useLocation();
  const projectId = params.projectId || "";
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const scrollToMessageId = searchParams.get("scrollTo");
  const matchedOnly = searchParams.get("matchedOnly") === "1";

  // React Router already decodes the wildcard param. Decoding again corrupts
  // paths that legitimately contain "%" (e.g. Grok's URL-encoded cwd dirs).
  const filePath = params["*"] || "";

  const {
    source,
    messages,
    messagesLoading,
    messagesHasMore,
    messagesHasNewer,
    messagesTotal,
    loadedStart,
    loadedEnd,
    selectSession,
    selectProject,
    loadMoreMessages,
    loadNewerMessages,
    jumpToMessageIndex,
    sessions,
    projects,
    searchResults,
    showTimestamp,
    showModel,
    timeZone,
    toggleTimestamp,
    toggleModel,
    refreshInBackground,
  } = useAppStore(
    useShallow((state) => ({
      source: state.source,
      messages: state.messages,
      messagesLoading: state.messagesLoading,
      messagesHasMore: state.messagesHasMore,
      messagesHasNewer: state.messagesHasNewer,
      messagesTotal: state.messagesTotal,
      loadedStart: state.loadedStart,
      loadedEnd: state.loadedEnd,
      selectSession: state.selectSession,
      selectProject: state.selectProject,
      loadMoreMessages: state.loadMoreMessages,
      loadNewerMessages: state.loadNewerMessages,
      jumpToMessageIndex: state.jumpToMessageIndex,
      sessions: state.sessions,
      projects: state.projects,
      searchResults: state.searchResults,
      showTimestamp: state.showTimestamp,
      showModel: state.showModel,
      timeZone: state.timeZone,
      toggleTimestamp: state.toggleTimestamp,
      toggleModel: state.toggleModel,
      refreshInBackground: state.refreshInBackground,
    })),
  );
  const supportsCli = source === "claude" || source === "codex" || source === "omp";
  // In-app continue only drives the local Claude / Codex CLIs.
  const supportsInlineChat = source === "claude" || source === "codex";
  const supportsResume = supportsCli || source === "grok";

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [showScrollUp, setShowScrollUp] = useState(false);
  const scrollButtonStateRef = useRef({ showScrollDown: false, showScrollUp: false });
  // Current reading position as a 0–100% of the whole session (not just the
  // loaded window). Drives the right-side position rail thumb.
  const [positionPercent, setPositionPercent] = useState(0);
  const positionPercentRef = useRef(0);
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  const prevScrollHeightRef = useRef<number>(0);
  const isLoadingOlderRef = useRef(false);
  const scrolledTargetRef = useRef<string | null>(null);
  const [expandVersion, setExpandVersion] = useState(0);
  const [allExpanded, setAllExpanded] = useState<boolean>(
    () => localStorage.getItem("messagesAllExpanded") === "true"
  );
  const setAllExpandedPersist = useCallback((next: boolean) => {
    setAllExpanded(next);
    localStorage.setItem("messagesAllExpanded", String(next));
  }, []);
  const [splitFilePaths, setSplitFilePaths] = useState<string[]>([]);
  const [showSplitPicker, setShowSplitPicker] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const loadAllAbortRef = useRef(false);
  const [splitDirection, setSplitDirection] = useState<SplitDirection>("horizontal");
  const [viewMode, setViewMode] = useState<"messages" | "thread" | "trajectory">("messages");
  const [tocCollapsed, setTocCollapsed] = useState<boolean>(
    () => localStorage.getItem("messageTocCollapsed") !== "false"
  );
  const handleToggleToc = useCallback((next: boolean) => {
    setTocCollapsed(next);
    localStorage.setItem("messageTocCollapsed", String(next));
  }, []);
  const [composerOpen, setComposerOpen] = useState(() => localStorage.getItem("messageComposerOpen") === "true");
  const setComposerVisible = (open: boolean) => { setComposerOpen(open); localStorage.setItem("messageComposerOpen", String(open)); };
  const [questionIndex, setQuestionIndex] = useState<QuestionIndexEntry[]>([]);
  const mainPaneId = useMemo(() => getMessagesPaneId(filePath), [filePath]);
  const activePaneId = useChatStore((state) => state.activePaneId);

  // Chat store for inline continue-chat
  const {
    availableClis,
    detectCli,
    continueExistingChatInPane,
    cancelPane,
    clearPane,
    setPaneProjectPath,
    setPaneModel,
    setPaneSource,
    setActivePane,
    fetchModelList: fetchChatModelList,
  } = useChatStore(
    useShallow((state) => ({ availableClis: state.availableClis, detectCli: state.detectCli, continueExistingChatInPane: state.continueExistingChatInPane, cancelPane: state.cancelPane, clearPane: state.clearPane, setPaneProjectPath: state.setPaneProjectPath, setPaneModel: state.setPaneModel, setPaneSource: state.setPaneSource, setActivePane: state.setActivePane, fetchModelList: state.fetchModelList })),
  );
  const mainChatPane = useChatStore(useCallback((state) => state.panes[mainPaneId], [mainPaneId]));

  const session = sessions.find((s) => s.filePath === filePath);
  const searchHit = searchResults.find((r) => r.filePath === filePath);
  const project = projects.find((p) => p.id === projectId);
  const createdFork = location.state?.forkResult?.newFilePath === filePath ? location.state.forkResult : null;
  const resolvedSessionId = session?.sessionId || searchHit?.sessionId || createdFork?.newSessionId || null;
  const resolvedSessionTitle =
    session?.alias ||
    session?.threadName ||
    session?.firstPrompt ||
    searchHit?.alias ||
    searchHit?.firstPrompt ||
    resolvedSessionId ||
    "Session";

  const chatProjectPath =
    session?.projectPath ||
    session?.cwd ||
    createdFork?.projectPath ||
    project?.displayPath ||
    (source !== "claude" ? searchHit?.projectId : "") ||
    "";

  usePaneChatStream(mainPaneId, resolvedSessionId);
  const cliAvailable = supportsInlineChat && availableClis.some((cli) => cli.cliType === source);
  const [editingSession, setEditingSession] = useState(false);

  // Detect CLI and set chat context on mount
  useEffect(() => {
    detectCli();
  }, [detectCli]);

  // Sync source from appStore into chatStore, then refresh model list
  useEffect(() => {
    setActivePane(mainPaneId);
    if (source === "claude" || source === "codex") {
      setPaneSource(mainPaneId, source);
      fetchChatModelList(mainPaneId);
    }
  }, [fetchChatModelList, mainPaneId, setActivePane, setPaneSource, source]);

  // Extract the model used in this historical session
  const sessionModel = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].model) {
        return messages[i].model!;
      }
    }
    return null;
  }, [messages]);
  const chatMessages = mainChatPane?.messages ?? [];
  const chatStreaming = mainChatPane?.isStreaming ?? false;
  const chatError = mainChatPane?.error ?? null;
  const chatModel = mainChatPane?.model ?? sessionModel ?? "";

  useEffect(() => {
    setPaneProjectPath(mainPaneId, chatProjectPath);
  }, [chatProjectPath, mainPaneId, setPaneProjectPath]);

  // Set chat model from the historical session's model when entering a session
  const modelInitRef = useRef<string>("");
  useEffect(() => {
    const modelInitKey = `${source}:${filePath}`;
    if (sessionModel && modelInitRef.current !== modelInitKey) {
      modelInitRef.current = modelInitKey;
      setPaneModel(mainPaneId, sessionModel);
    }
  }, [filePath, mainPaneId, sessionModel, setPaneModel, source]);

  // Clear chat state when leaving the page / switching sessions
  useEffect(() => {
    return () => {
      clearPane(mainPaneId);
    };
  }, [clearPane, mainPaneId]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    setInitialScrollDone(false);
    setViewMode("messages");
    scrollButtonStateRef.current = { showScrollDown: false, showScrollUp: false };
    setShowScrollDown(false);
    setShowScrollUp(false);
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
  }, [filePath, source, projectId]);

  useEffect(() => {
    if (!filePath) {
      setQuestionIndex([]);
      return;
    }

    let cancelled = false;
    setQuestionIndex([]);
    void api.getQuestionIndex(source, filePath)
      .then((entries) => {
        if (!cancelled) setQuestionIndex(entries);
      })
      .catch((error) => {
        console.error("Failed to load question index:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, source]);

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

  const requestOlderMessages = useCallback(() => {
    if (!containerRef.current || messagesLoading || !messagesHasMore) return;
    isLoadingOlderRef.current = true;
    prevScrollHeightRef.current = containerRef.current.scrollHeight;
    void loadMoreMessages();
  }, [loadMoreMessages, messagesHasMore, messagesLoading]);

  // Sequentially page through everything older than what's currently loaded.
  // The button is intentionally manual (not auto on mount) since very long
  // sessions can be 10k+ messages and rendering them all is expensive.
  const handleLoadAll = useCallback(async () => {
    if (loadingAll) {
      // Second click cancels an in-flight load-all run.
      loadAllAbortRef.current = true;
      return;
    }
    setLoadingAll(true);
    loadAllAbortRef.current = false;
    try {
      // Read latest store state on each iteration to know if we still need
      // more pages. Cap iterations defensively.
      for (let i = 0; i < 500; i += 1) {
        if (loadAllAbortRef.current) break;
        const state = useAppStore.getState();
        if (!state.messagesHasMore || state.messagesLoading) {
          if (state.messagesLoading) {
            // Yield until the in-flight request settles.
            await new Promise((r) => setTimeout(r, 80));
            continue;
          }
          break;
        }
        const before = state.loadedStart;
        await state.loadMoreMessages();
        const after = useAppStore.getState().loadedStart;
        if (after >= before) {
          // No-progress guard: if loadMoreMessages didn't actually advance
          // the window backwards (e.g. backend returned an empty slice or
          // the request errored), stop instead of spinning to i=500.
          console.error(
            `handleLoadAll: no progress at iter ${i} (loadedStart stayed at ${before}), aborting`,
          );
          break;
        }
      }
    } finally {
      setLoadingAll(false);
      loadAllAbortRef.current = false;
    }
  }, [loadingAll]);

  const updateScrollButtonState = useCallback((nextShowScrollUp: boolean, nextShowScrollDown: boolean) => {
    const current = scrollButtonStateRef.current;

    if (current.showScrollUp !== nextShowScrollUp) {
      current.showScrollUp = nextShowScrollUp;
      setShowScrollUp(nextShowScrollUp);
    }

    if (current.showScrollDown !== nextShowScrollDown) {
      current.showScrollDown = nextShowScrollDown;
      setShowScrollDown(nextShowScrollDown);
    }
  }, []);

  const requestNewerMessages = useCallback(() => {
    if (!containerRef.current || messagesLoading || !messagesHasNewer) return;
    void loadNewerMessages();
  }, [loadNewerMessages, messagesHasNewer, messagesLoading]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const nextShowScrollDown = scrollHeight - scrollTop - clientHeight > 400;
    const nextShowScrollUp = scrollTop > 400;

    updateScrollButtonState(nextShowScrollUp, nextShowScrollDown);

    // Map scroll position within the loaded window to an absolute position in
    // the whole session, so the rail thumb reflects where we really are.
    if (messagesTotal > 0) {
      const scrollFrac =
        scrollHeight > clientHeight ? scrollTop / (scrollHeight - clientHeight) : 0;
      const absIdx = loadedStart + scrollFrac * Math.max(0, loadedEnd - loadedStart - 1);
      const nextPct = Math.max(0, Math.min(100, (absIdx / Math.max(1, messagesTotal - 1)) * 100));
      if (Math.abs(nextPct - positionPercentRef.current) >= 0.5) {
        positionPercentRef.current = nextPct;
        setPositionPercent(nextPct);
      }
    }

    // Load older messages when scrolling near top
    const canScroll = scrollHeight > clientHeight + 24;
    if (!messagesLoading && messagesHasMore && canScroll && scrollTop < 200) {
      requestOlderMessages();
    }
    // Load newer messages when scrolling near bottom (and we're not at the
    // tail — happens after a TOC jump that placed the window mid-session).
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    if (!messagesLoading && messagesHasNewer && distanceFromBottom < 200) {
      requestNewerMessages();
    }
  }, [
    messagesHasMore,
    messagesHasNewer,
    messagesLoading,
    requestOlderMessages,
    requestNewerMessages,
    updateScrollButtonState,
    messagesTotal,
    loadedStart,
    loadedEnd,
  ]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const scrollToTop = () => {
    containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Jump to a percentage of the whole session. Reuses the windowed
  // `jumpToMessageIndex`, so only a small slice around the target is loaded —
  // fast even for very long sessions, and keeps the DOM small.
  const handleJumpToPercent = useCallback(
    async (percent: number) => {
      const total = useAppStore.getState().messagesTotal;
      if (total <= 0) return;
      const p = Math.max(0, Math.min(100, percent));
      const target = Math.round((p / 100) * (total - 1));
      // Optimistically move the thumb so the rail feels responsive.
      positionPercentRef.current = p;
      setPositionPercent(p);
      await jumpToMessageIndex(target);
      // Wait for the new window to render, then position the viewport. 0%/100%
      // snap to the exact top/bottom; mid-session lands on the target (the
      // window is centered on it).
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const viewport = containerRef.current;
          if (!viewport) return;
          if (p <= 0) {
            viewport.scrollTo({ top: 0, behavior: "smooth" });
            return;
          }
          if (p >= 100) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
            return;
          }
          const { loadedStart: ls, loadedEnd: le } = useAppStore.getState();
          const span = Math.max(1, le - ls);
          const rel = Math.max(0, Math.min(1, (target - ls) / span));
          const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
          viewport.scrollTo({ top: rel * maxScroll, behavior: "smooth" });
        });
      });
    },
    [jumpToMessageIndex]
  );

  const displayedMessages = useMemo(() => {
    if (!matchedOnly || !scrollToMessageId) return messages;
    const idx = messages.findIndex((msg) => msg.uuid === scrollToMessageId);
    if (idx === -1) return messages;
    return buildFocusedMessages(messages, idx);
  }, [messages, matchedOnly, scrollToMessageId]);

  useLayoutEffect(() => {
    if (!PERF_DIAGNOSTICS_ENABLED || messages.length === 0) return;
    const pendingCommit = consumePendingMessageCommit();
    if (!pendingCommit) return;

    const committedAt = performance.now();
    const viewport = containerRef.current;
    const commonFields = {
      requestId: pendingCommit.requestId,
      stage: pendingCommit.stage,
      loadedStart,
      loadedEnd,
      total: messagesTotal,
      ...getMessagesPerfFields(messages),
      ...getBrowserPerfSnapshot(viewport),
    };
    recordPerfDiagnostic(
      "messages.dom_committed",
      committedAt - pendingCommit.responseAt,
      commonFields,
    );

    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (!viewport?.isConnected) return;
        recordPerfDiagnostic(
          "messages.paint_ready",
          performance.now() - committedAt,
          {
            ...commonFields,
            ...getBrowserPerfSnapshot(viewport),
          },
        );
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [loadedEnd, loadedStart, messages, messagesTotal]);

  // Keep navigation targets aligned with the messages currently rendered in the DOM.
  // Current-window anchors drive active-state detection and the sticky context card.
  const userDots = useMemo(() => {
    let userIndex = 0;
    return displayedMessages
      .map((msg, index) => {
        if (msg.role !== "user") return null;
        return {
          id: msg.uuid || `user-${loadedStart + index}`,
          index: userIndex++,
          preview: extractUserQuestionPreview(msg),
          timestamp: msg.timestamp ? formatTime(msg.timestamp, timeZone) : null,
        };
      })
      .filter(Boolean) as Array<{ id: string; index: number; preview: string; timestamp: string | null }>;
  }, [displayedMessages, loadedStart, timeZone, t]);

  const questionTocItems = useMemo(
    () => questionIndex.map((question, index) => ({
      id: question.messageId,
      index,
      preview: question.preview || t("（用户消息）"),
      timestamp: question.timestamp ? formatTime(question.timestamp, timeZone) : null,
    })),
    [questionIndex, timeZone, t],
  );

  const userMessageIds = useMemo(() => userDots.map((d) => d.id), [userDots]);
  const activeUserMsgId = useActiveUserMessage(containerRef, userMessageIds);

  // First user question in the currently loaded messages — used as a sticky
  // context anchor at the top of the scroll area so you always know what the
  // conversation is about, even after scrolling far down.
  const firstUserAnchor = useMemo(() => {
    return userDots.length > 0 ? userDots[0] : null;
  }, [userDots]);
  // When the anchor is near the top of the viewport the sticky banner would
  // visually duplicate the message itself — hide it in that case.
  const firstAnchorIsActive = firstUserAnchor !== null && activeUserMsgId === firstUserAnchor.id;

  const handleDotClick = useCallback((id: string) => {
    const viewport = containerRef.current;
    if (!viewport) return;
    const el = viewport.querySelector(`[data-user-msg-id="${id}"]`);
    if (!el) {
      // Fallback: jump to top so the user at least sees *something* happen
      // when the target message is paginated out.
      viewport.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-primary/40", "rounded-lg");
    setTimeout(() => {
      el.classList.remove("ring-2", "ring-primary/40", "rounded-lg");
    }, 1200);
  }, []);

  const handleQuestionSelect = useCallback(async (messageId: string) => {
    const question = questionIndex.find((entry) => entry.messageId === messageId);
    if (!question) return;

    setViewMode("messages");

    await jumpToMessageIndex(question.messageIndex);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const element = containerRef.current?.querySelector(
          `[data-message-index="${question.messageIndex}"]`,
        );
        if (!element) return;
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.classList.add("ring-2", "ring-primary/40", "rounded-lg");
        setTimeout(() => {
          element.classList.remove("ring-2", "ring-primary/40", "rounded-lg");
        }, 1200);
      });
    });
  }, [jumpToMessageIndex, questionIndex]);

  const assistantName = assistantNameFromSource(source);


  const latestReply = useMemo(() => {
    if (chatMessages.length > 0) {
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role !== "assistant") continue;
        const firstText = chatMessages[i].content.find((block) => block.type === "text");
        return {
          key: `${chatMessages[i].id}:${chatMessages[i].timestamp}`,
          preview: firstText && "text" in firstText ? firstText.text.slice(0, 80) : t("有新回复"),
        };
      }
      return null;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "assistant") continue;
      const firstText = messages[i].content.find((block) => block.type === "text");
      return {
        key: `${messages[i].uuid ?? i}:${messages[i].timestamp}`,
        preview: firstText && "text" in firstText ? firstText.text.slice(0, 80) : t("有新回复"),
      };
    }

    return null;
  }, [messages, chatMessages, t]);

  const { unreadCount: unreadReplyCount, clear: clearUnreadReplies } = useReplyNotification(
    latestReply?.key ?? null,
    t("{{v0}} 有新回复", { v0: assistantName }),
    latestReply?.preview || t("点击查看最新消息")
  );

  // Drop the unread banner when the user navigates to a different session so
  // counts don't bleed across sessions.
  useEffect(() => {
    clearUnreadReplies();
  }, [filePath, clearUnreadReplies]);

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (filePath && resolvedSessionId && resolvedSessionTitle) {
      rememberSession({ source, projectId, filePath, title: resolvedSessionTitle });
    }
  }, [filePath, resolvedSessionId, resolvedSessionTitle, projectId, source]);

  const getResumeCommand = () => {
    if (!resolvedSessionId) return "";
    return source === "claude"
      ? `claude --resume ${resolvedSessionId}`
      : source === "grok"
        ? `grok -r ${resolvedSessionId}`
        : source === "omp"
          ? `omp --resume ${resolvedSessionId}`
          : `codex resume ${resolvedSessionId}`;
  };

  const handleCopyCommand = async (e: React.MouseEvent) => {
    e.preventDefault();
    const command = getResumeCommand();
    if (!await copyTextToClipboard(command)) {
      setResumeError(t("复制失败，请手动复制：{{v0}}", { v0: command }));
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const terminalShell = useAppStore((state) => state.terminalShell);

  const [resumeError, setResumeError] = useState<string | null>(null);

  const handleResume = async () => {
    if (!resolvedSessionId) return;
    setResumeError(null);
    if (USE_TAURI_TRANSPORT) {
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
      if (!await copyTextToClipboard(cmd)) {
        setResumeError(t("复制失败，请手动复制：{{v0}}", { v0: cmd }));
        return;
      }
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

  // When an in-page chat stream completes, the JSONL on disk is freshly written
  // but fs-change debounce + backend cache may delay the main message list
  // refresh. Explicitly trigger a background refresh and hand the conversation
  // over to the historical list so users don't have to reload the page.
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !chatStreaming && chatMessages.length > 0) {
      const refreshTimer = setTimeout(() => {
        void refreshInBackground(true, false, { reason: "chat-complete" });
      }, 300);
      const clearTimer = setTimeout(() => {
        clearPane(mainPaneId);
      }, 1500);
      prevStreamingRef.current = chatStreaming;
      return () => {
        clearTimeout(refreshTimer);
        clearTimeout(clearTimer);
      };
    }
    prevStreamingRef.current = chatStreaming;
  }, [chatStreaming, chatMessages.length, clearPane, mainPaneId, refreshInBackground]);

  const handleSendChat = (prompt: string) => {
    if (!resolvedSessionId) return;
    continueExistingChatInPane(
      mainPaneId,
      resolvedSessionId,
      chatProjectPath,
      prompt,
      chatModel
    );
  };

  const handleSubmitAnswers = useCallback(async (answers: string) => {
    if (!resolvedSessionId || !chatProjectPath) return;
    if (chatStreaming) {
      await cancelPane(mainPaneId);
      setTimeout(() => {
        void continueExistingChatInPane(mainPaneId, resolvedSessionId, chatProjectPath, answers, chatModel);
      }, 150);
      return;
    }
    void continueExistingChatInPane(mainPaneId, resolvedSessionId, chatProjectPath, answers, chatModel);
  }, [cancelPane, chatModel, chatProjectPath, chatStreaming, continueExistingChatInPane, mainPaneId, resolvedSessionId]);

  const availableSplitSessions = sessions.filter(
    (item) => item.filePath !== filePath && !splitFilePaths.includes(item.filePath)
  );
  const isSplitHorizontal = splitFilePaths.length > 0 && splitDirection === "horizontal";
  const splitScrollDrag = useHorizontalDragScroll(isSplitHorizontal);

  // Percentage-jump controls only make sense for long sessions and the main
  // (non-thread, non-matched-fragment) message view.
  const showJumpControls =
    viewMode === "messages" &&
    !matchedOnly &&
    splitFilePaths.length === 0 &&
    messagesTotal > JUMP_CONTROLS_MIN_TOTAL;
  const messageThread = (
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
      viewportRef={containerRef}
      priorityMessageId={scrollToMessageId}
      messageOffset={loadedStart}
    />
  );
  const measuredMessageThread = PERF_DIAGNOSTICS_ENABLED ? (
    <Profiler id="MessageThread" onRender={recordMessagesProfilerRender}>
      {messageThread}
    </Profiler>
  ) : (
    messageThread
  );

  return (
    <div className="message-workspace flex h-full min-h-0 flex-col relative overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-3 flex flex-wrap items-center justify-between gap-3 sm:px-5">
        <div className="flex flex-1 items-center gap-2 min-w-0 basis-60">
          <button
            onClick={() => navigate(`/projects/${encodeURIComponent(projectId)}`)}
            aria-label={t("返回会话列表")}
            className="p-1 rounded hover:bg-accent transition-colors shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {resolvedSessionTitle}
            </p>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
              {messages.length < messagesTotal ? (
                <button
                  onClick={handleLoadAll}
                  disabled={!messagesHasMore && !loadingAll}
                  className="inline-flex items-center gap-1 rounded border border-border/60 bg-background/50 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-60"
                  title={loadingAll ? t("点击中止加载") : t("点击一次性加载全部历史消息")}
                >
                  {loadingAll && <Loader2 className="w-3 h-3 animate-spin" />}
                  {t("已加载")}{messages.length} / {messagesTotal}
                  <span className="text-primary">{loadingAll ? t("·中止") : t("·加载全部")}</span>
                </button>
              ) : (
                <span>{messagesTotal} {t("条消息")}</span>
              )}
              {session?.gitBranch && <span>· {session.gitBranch}</span>}
              <span>· {assistantName}</span>
              {showJumpControls && (
                <>
                  <span className="text-border">·</span>
                  <JumpToPercentControl
                    onJump={handleJumpToPercent}
                    disabled={messagesLoading}
                  />
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {viewMode === "messages" && questionTocItems.length > 0 && !matchedOnly && <button id="message-directory-toggle" className="toolbar-button" aria-expanded={!tocCollapsed} onClick={() => handleToggleToc(!tocCollapsed)}><ListTree className="h-3.5 w-3.5" />{t("目录 ·")}{questionTocItems.length}</button>}
          <select aria-label={t("阅读视图")} value={viewMode} onChange={(event) => setViewMode(event.target.value as "messages" | "thread" | "trajectory")} className="toolbar-button pr-1">
            <option value="messages">{t("消息")}</option><option value="thread">{t("提问汇总")}</option>{source === "codex" && <option value="trajectory">{t("轨迹")}</option>}
          </select>
          <ActionMenu label={t("显示")}>
            <label><span>{t("消息时间")}</span><input type="checkbox" checked={showTimestamp} onChange={toggleTimestamp} /></label>
            <label><span>{t("模型名称")}</span><input type="checkbox" checked={showModel} onChange={toggleModel} /></label>
            <button onClick={() => { setAllExpandedPersist(true); setExpandVersion((v) => v + 1); }}><Rows3 className="h-4 w-4" />{t("展开全部消息")}</button>
            <button onClick={() => { setAllExpandedPersist(false); setExpandVersion((v) => v + 1); }}><ChevronsUpDown className="h-4 w-4" />{t("折叠全部消息")}</button>
            <div className="my-1 border-t border-border" />
            <button onClick={() => setShowSplitPicker((v) => !v)}><Plus className="h-4 w-4" />{t("分屏查看其他会话")}</button>
            {splitFilePaths.length > 0 && <button onClick={() => setSplitDirection((prev) => prev === "horizontal" ? "vertical" : "horizontal")}><Columns2 className="h-4 w-4" />{splitDirection === "horizontal" ? t("改为上下分屏") : t("改为左右分屏")}</button>}
          </ActionMenu>
          <ActionMenu label={t("详情")}>
            <p>{t("会话信息")}</p>
            {supportsCli && filePath && <div className="px-3 py-2"><SessionCostBadge filePath={filePath} /></div>}
            {resolvedSessionId && <button onClick={() => setEditingSession(true)}><Tag className="h-4 w-4" />{t("编辑标签和别名")}</button>}
            {supportsResume && <button onClick={handleCopyCommand}><Copy className="h-4 w-4" />{copied ? t("已复制") : t("复制续聊命令")}</button>}
            {supportsResume && USE_TAURI_TRANSPORT && <button onClick={handleResume}><Play className="h-4 w-4" />{t("在终端打开")}</button>}
          </ActionMenu>
          {resolvedSessionId && cliAvailable ? (
            <button className="toolbar-primary" onClick={() => { setViewMode("messages"); setComposerVisible(true); requestAnimationFrame(() => chatInputRef.current?.focus()); }}><MessageSquare className="h-3.5 w-3.5" />{t("继续对话")}</button>
          ) : supportsResume && resolvedSessionId ? (
            <button className="toolbar-primary" onClick={handleResume}>{USE_TAURI_TRANSPORT ? <Play className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{USE_TAURI_TRANSPORT ? t("终端续聊") : copied ? t("已复制") : t("复制续聊命令")}</button>
          ) : null}
        </div>
      </div>

      {showSplitPicker && availableSplitSessions.length > 0 && (
        <div className="mx-4 mt-2 rounded-lg border border-border bg-card shadow-sm max-w-md">
          <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
            {t("选择要分屏查看的会话")}</div>
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
                  {item.alias || item.threadName || item.firstPrompt || item.sessionId}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {item.messageCount} {t("条消息")}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {matchedOnly && scrollToMessageId && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2 text-sm">
          <span className="text-muted-foreground">{t("当前仅显示匹配消息片段")}</span>
          <button
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("matchedOnly");
              setSearchParams(next, { replace: true });
            }}
            className="text-primary hover:text-primary/80 transition-colors"
          >
            {t("显示全部消息")}</button>
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
      {createdFork && (
        <div role="status" className="mx-4 mt-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm">
          <div>{t("已创建独立分叉，原会话保留。")}</div>
          {location.state.forkWarning && <div className="mt-1 text-destructive">{location.state.forkWarning}</div>}
          {(!USE_TAURI_TRANSPORT || location.state.forkWarning) && (
            <div className="mt-1 space-y-1">
              <div>{source === "grok" ? t("Grok 请使用下方命令续聊。") : t("可在下方继续对话，或使用命令续聊。")}{t("在会话所在机器的项目目录运行：")}</div>
              <div className="break-all text-xs text-muted-foreground">{createdFork.projectPath}</div>
              <code className="block select-all break-all font-mono text-xs">{getResumeCommand()}</code>
            </div>
          )}
        </div>
      )}
      {resumeError && (
        <div className="mx-4 mt-2 px-4 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
          {resumeError}
        </div>
      )}

      {/* Unread replies banner — accumulates while the page is hidden, shown on return */}
      {unreadReplyCount > 0 && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm">
          <span className="text-primary">{t("期间收到")}{unreadReplyCount} {t("条新回复")}</span>
          <button
            onClick={() => {
              clearUnreadReplies();
              scrollToBottom();
            }}
            className="ml-auto rounded px-2 py-0.5 text-xs text-primary hover:bg-primary/15 transition-colors"
          >
            {t("跳到底部")}</button>
          <button
            onClick={clearUnreadReplies}
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {t("关闭")}</button>
        </div>
      )}

      <ExpandAllProvider value={{ expanded: allExpanded, version: expandVersion }}>
        <div className="relative flex-1 min-h-0 flex min-w-0">
          {viewMode === "messages" && questionTocItems.length > 0 && !matchedOnly && !tocCollapsed && (
            <>
            <button className="message-directory-backdrop" aria-label={t("关闭提问目录")} onClick={() => handleToggleToc(true)} />
            <div className="message-directory" onKeyDown={(event) => { if (event.key === "Escape") { handleToggleToc(true); document.getElementById("message-directory-toggle")?.focus(); } }}>
              <MessageTOCSidebar
                items={questionTocItems}
                activeId={activeUserMsgId}
                onSelect={(id) => { handleQuestionSelect(id); if (window.matchMedia("(max-width: 1279px)").matches) handleToggleToc(true); }}
                collapsed={tocCollapsed}
                onToggleCollapsed={handleToggleToc}
              />
            </div>
            </>
          )}
          <div
          className={`flex-1 min-w-0 ${
            isSplitHorizontal ? "overflow-x-auto overflow-y-hidden" : "overflow-y-auto"
          } ${splitScrollDrag.isEnabled ? "cursor-grab" : ""}`}
          onPointerDown={splitScrollDrag.onPointerDown}
          onPointerMove={splitScrollDrag.onPointerMove}
          onPointerUp={splitScrollDrag.onPointerUp}
          onPointerCancel={splitScrollDrag.onPointerCancel}
          onClickCapture={splitScrollDrag.onClickCapture}
        >
          <div
            className={`gap-2 p-0 ${
              isSplitHorizontal
                ? "flex min-h-full min-w-full w-max"
                : "flex min-h-full min-w-0 flex-col"
            }`}
          >
            <div
              onMouseDownCapture={() => {
                if (splitFilePaths.length > 0 && activePaneId !== mainPaneId) {
                  setActivePane(mainPaneId);
                }
              }}
              className={`message-reading-pane relative flex flex-col border bg-card transition-colors ${
                splitFilePaths.length > 0 && activePaneId === mainPaneId
                  ? "border-primary ring-1 ring-primary/40 shadow-[0_0_0_1px_hsl(var(--primary)/0.4)]"
                  : "border-border"
              } ${
                splitFilePaths.length === 0
                  ? "min-w-0 flex-1"
                  : isSplitHorizontal
                    ? "w-[min(70vw,64rem)] min-w-[28rem] shrink-0"
                    : "min-h-[28rem] max-h-[70vh] min-w-0 shrink-0"
              }`}
            >
              {viewMode === "trajectory" ? (
                <div
                  className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
                  style={{ contain: "strict" }}
                >
                  {PERF_DIAGNOSTICS_ENABLED ? (
                    <Profiler
                      id="TrajectoryView"
                      onRender={recordPerfProfilerRender}
                    >
                      <TrajectoryView source={source} filePath={filePath} />
                    </Profiler>
                  ) : (
                    <TrajectoryView source={source} filePath={filePath} />
                  )}
                </div>
              ) : (
                <ScrollArea
                  className="flex-1 min-h-0"
                  viewportRef={containerRef}
                  onViewportScroll={handleScroll}
                  viewportClassName="h-full"
                >
                {viewMode === "messages" && firstUserAnchor && (
                  <button
                    type="button"
                    onClick={() => handleDotClick(firstUserAnchor.id)}
                    title={firstUserAnchor.preview}
                    className={`sticky top-0 z-30 flex w-full items-center gap-2 border-b border-border/70 bg-card/95 px-4 py-2 text-left text-xs backdrop-blur supports-[backdrop-filter]:bg-card/80 transition-opacity hover:bg-accent/50 ${
                      firstAnchorIsActive ? "opacity-0 pointer-events-none" : "opacity-100"
                    }`}
                  >
                    <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary/15 px-1.5 font-mono text-[10px] text-primary">
                      {t("首问")}</span>
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {firstUserAnchor.preview}
                    </span>
                    {firstUserAnchor.timestamp && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {firstUserAnchor.timestamp}
                      </span>
                    )}
                  </button>
                )}
                {viewMode === "messages" && messagesHasMore && messages.length > 0 && !matchedOnly && (
                  <div className="flex justify-center px-4 pt-4">
                    <button
                      onClick={requestOlderMessages}
                      disabled={messagesLoading}
                      className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {messagesLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {messagesLoading ? t("加载更早的消息...") : t("加载更早的消息")}
                    </button>
                  </div>
                )}
                {viewMode === "messages" && !messagesHasMore && messages.length > 0 && (
                  <div className="text-center py-4 text-xs text-muted-foreground">
                    {t("— 会话开始 —")}</div>
                )}
                {viewMode === "thread" ? (
                  <ThreadSummaryView
                    questions={questionIndex}
                    source={source}
                    onSelect={handleQuestionSelect}
                    filePath={filePath}
                    projectPath={chatProjectPath}
                  />
                ) : messagesLoading && messages.length === 0 ? (
                  <div className="flex items-center justify-center h-32 text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" />
                    {t("加载消息中...")}</div>
                ) : (
                  measuredMessageThread
                )}
                {viewMode === "messages" && !messagesLoading && messages.length > 0 && chatMessages.length === 0 && !chatStreaming && (
                  <div className="text-center py-4 text-xs text-muted-foreground">
                    {t("— 会话结束 —")}</div>
                )}

                {viewMode === "messages" && chatMessages.length > 0 && (
                  <ChatMessagesBlock
                    messages={chatMessages}
                    source={source}
                    onSubmitAnswers={handleSubmitAnswers}
                  />
                )}
                {viewMode === "messages" && chatStreaming && (
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
                {viewMode === "messages" && chatError && (
                  <div className="max-w-4xl mx-auto px-6">
                    <div className="flex items-center gap-2 py-2 text-sm text-red-400">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      {chatError}
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
                </ScrollArea>
              )}
            </div>

            {splitFilePaths.map((splitPath) => (
              <SplitSessionPane
                key={splitPath}
                source={source}
                filePath={splitPath}
                showTimestamp={showTimestamp}
                showModel={showModel}
                session={sessions.find((item) => item.filePath === splitPath) || null}
                cliAvailable={cliAvailable}
                fallbackProjectPath={project?.displayPath || ""}
                splitDirection={splitDirection}
                onClose={() => setSplitFilePaths((prev) => prev.filter((item) => item !== splitPath))}
              />
            ))}
          </div>
        </div>
        </div>
      </ExpandAllProvider>

      {/* Chat input */}
      {resolvedSessionId && cliAvailable && viewMode === "messages" && (
        <div className="shrink-0 border-t border-border bg-card">
          <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-muted-foreground">
            <span>{chatStreaming ? t("正在回复…") : t("在此会话中继续")}</span>
            <button className="toolbar-button" disabled={chatStreaming} aria-expanded={composerOpen || chatStreaming} onClick={() => setComposerVisible(!composerOpen)}>{composerOpen || chatStreaming ? t("收起输入框") : t("输入消息")}</button>
          </div>
          <div hidden={!composerOpen && !chatStreaming}>
          <ChatInput
            ref={chatInputRef}
            paneId={mainPaneId}
            onSend={handleSendChat}
            onCancel={() => cancelPane(mainPaneId)}
            isStreaming={chatStreaming}
            disabled={!chatProjectPath}
          />
          </div>
        </div>
      )}

      {/* Floating "Reply" button that appears when the user selects text inside the messages area */}
      {resolvedSessionId && cliAvailable && viewMode === "messages" && (
        <SelectionReplyButton
          scopeRef={containerRef}
          disabled={chatStreaming}
          onReply={(text) => { setComposerVisible(true); requestAnimationFrame(() => chatInputRef.current?.insertQuote(text)); }}
        />
      )}

      {/* Session position rail — jump to any percentage of a long session */}
      {showJumpControls && (
        <SessionPositionRail
          currentPercent={positionPercent}
          onJump={handleJumpToPercent}
          disabled={messagesLoading}
        />
      )}

      {/* Timeline navigation dots */}
      {questionTocItems.length > 1 && viewMode === "messages" && !matchedOnly && !tocCollapsed && (
        <TimelineDots
          dots={questionTocItems}
          activeId={activeUserMsgId}
          onDotClick={handleQuestionSelect}
          offsetFromEdge={showJumpControls}
        />
      )}

      {/* Scroll buttons */}
      <div className="absolute bottom-20 right-6 flex flex-col gap-2">
        {messages.length > 0 && viewMode === "messages" && (
          <button
            onClick={() => {
              setAllExpandedPersist(!allExpanded);
              setExpandVersion((v) => v + 1);
            }}
            className="p-2.5 rounded-full bg-card border border-border text-foreground shadow-lg hover:bg-accent transition-all hover:scale-105"
            title={allExpanded ? t("全部折叠（默认值已记住）") : t("全部展开（默认值已记住）")}
          >
            {allExpanded ? (
              <ChevronsUpDown className="w-4 h-4" />
            ) : (
              <Rows3 className="w-4 h-4" />
            )}
          </button>
        )}
        {showScrollUp && (
          <button
            onClick={scrollToTop}
            className="p-2.5 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all hover:scale-105"
            title={t("跳转到顶部")}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        )}
        {showScrollDown && (
          <button
            onClick={scrollToBottom}
            className="p-2.5 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all hover:scale-105"
            title={t("跳转到底部")}
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
  cliAvailable,
  fallbackProjectPath,
  splitDirection,
  onClose,
}: {
  source: MessageSource;
  filePath: string;
  showTimestamp: boolean;
  showModel: boolean;
  session: SessionIndexEntry | null;
  cliAvailable: boolean;
  fallbackProjectPath: string;
  splitDirection: SplitDirection;
  onClose: () => void;
}) {
  const { t } = useTranslation();
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const paneId = useMemo(() => getMessagesPaneId(filePath), [filePath]);
  const {
    continueExistingChatInPane,
    cancelPane,
    clearPane,
    setPaneProjectPath,
    setPaneModel,
    setPaneSource,
    setActivePane,
  } = useChatStore(
    useShallow((state) => ({ continueExistingChatInPane: state.continueExistingChatInPane, cancelPane: state.cancelPane, clearPane: state.clearPane, setPaneProjectPath: state.setPaneProjectPath, setPaneModel: state.setPaneModel, setPaneSource: state.setPaneSource, setActivePane: state.setActivePane })),
  );
  const paneState = useChatStore(useCallback((state) => state.panes[paneId], [paneId]));
  const activePaneId = useChatStore((state) => state.activePaneId);
  const isActivePane = activePaneId === paneId;

  const sessionTitle =
    session?.alias ||
    session?.threadName ||
    session?.firstPrompt ||
    session?.sessionId ||
    filePath;
  const resolvedSessionId = session?.sessionId || null;
  const chatProjectPath = session?.projectPath || session?.cwd || fallbackProjectPath || "";
  const chatMessages = paneState?.messages ?? [];
  const chatStreaming = paneState?.isStreaming ?? false;
  const chatError = paneState?.error ?? null;
  const sessionModel = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].model) {
        return messages[i].model!;
      }
    }
    return null;
  }, [messages]);
  const chatModel = paneState?.model ?? sessionModel ?? "";

  usePaneChatStream(paneId, resolvedSessionId);

  const loadMessages = useCallback(
    async (nextPage: number, mode: "replace" | "prepend") => {
      const requestVersion = ++requestVersionRef.current;
      setLoading(true);
      if (mode === "replace") {
        setError(null);
      }

      try {
        const result = await api.getMessages(source, filePath, nextPage, SPLIT_PANE_MESSAGES_PAGE_SIZE, true);
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
    if (source === "claude" || source === "codex") {
      setPaneSource(paneId, source);
    }
  }, [paneId, setPaneSource, source]);

  useEffect(() => {
    setPaneProjectPath(paneId, chatProjectPath);
  }, [chatProjectPath, paneId, setPaneProjectPath]);

  const modelInitRef = useRef("");
  useEffect(() => {
    const modelInitKey = `${source}:${filePath}`;
    if (!sessionModel || modelInitRef.current === modelInitKey) return;
    modelInitRef.current = modelInitKey;
    setPaneModel(paneId, sessionModel);
  }, [filePath, paneId, sessionModel, setPaneModel, source]);

  useEffect(() => {
    return () => {
      clearPane(paneId);
    };
  }, [clearPane, paneId]);

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

  const requestOlderMessages = useCallback(() => {
    if (!containerRef.current || loading || !hasMore) return;
    isLoadingOlderRef.current = true;
    prevScrollHeightRef.current = containerRef.current.scrollHeight;
    void loadMessages(page + 1, "prepend");
  }, [hasMore, loadMessages, loading, page]);

  useEffect(() => {
    if (chatMessages.length > 0 || chatStreaming) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    }
  }, [chatMessages, chatStreaming]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current || loading || !hasMore) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    if (scrollHeight > clientHeight + 24 && scrollTop < 200) {
      requestOlderMessages();
    }
  }, [hasMore, loading, requestOlderMessages]);

  const handleSendChat = useCallback((prompt: string) => {
    if (!resolvedSessionId || !chatProjectPath) return;
    void continueExistingChatInPane(paneId, resolvedSessionId, chatProjectPath, prompt, chatModel);
  }, [chatModel, chatProjectPath, continueExistingChatInPane, paneId, resolvedSessionId]);

  const handleSubmitAnswers = useCallback(async (answers: string) => {
    if (!resolvedSessionId || !chatProjectPath) return;
    if (chatStreaming) {
      await cancelPane(paneId);
      setTimeout(() => {
        void continueExistingChatInPane(paneId, resolvedSessionId, chatProjectPath, answers, chatModel);
      }, 150);
      return;
    }
    void continueExistingChatInPane(paneId, resolvedSessionId, chatProjectPath, answers, chatModel);
  }, [cancelPane, chatModel, chatProjectPath, chatStreaming, continueExistingChatInPane, paneId, resolvedSessionId]);

  return (
    <div
      onMouseDownCapture={() => {
        if (!isActivePane) setActivePane(paneId);
      }}
      className={`flex shrink-0 flex-col rounded-lg border bg-card transition-colors ${
        isActivePane
          ? "border-primary ring-1 ring-primary/40 shadow-[0_0_0_1px_hsl(var(--primary)/0.4)]"
          : "border-border"
      } ${
        splitDirection === "horizontal"
          ? "w-[24rem] min-w-[22rem] max-w-[30rem]"
          : "min-h-[24rem] max-h-[56vh] min-w-0"
      }`}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{sessionTitle}</p>
          <p className="text-xs text-muted-foreground">
            {t("分屏续聊")}{total > 0 && ` · ${messages.length < total ? t("已加载 {{v0}} / {{v1}}", { v0: messages.length, v1: total }) : t("{{v0}} 条消息", { v0: total })}`}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t("关闭分屏")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ScrollArea
        className="flex-1 min-h-0"
        viewportRef={containerRef}
        onViewportScroll={handleScroll}
        viewportClassName="h-full"
      >
        {hasMore && messages.length > 0 && (
          <div className="flex justify-center px-4 pt-4">
            <button
              onClick={requestOlderMessages}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70"
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {loading ? t("加载更早的消息...") : t("加载更早的消息")}
            </button>
          </div>
        )}

        {!hasMore && messages.length > 0 && (
          <div className="py-4 text-center text-xs text-muted-foreground">
            {t("— 会话开始 —")}</div>
        )}

        {loading && messages.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            {t("加载消息中...")}</div>
        ) : error ? (
          <div className="px-4 py-6 text-sm text-destructive">{error}</div>
        ) : (
          <MessageThread
            messages={messages}
            source={source}
            showTimestamp={showTimestamp}
            showModel={showModel}
            viewportRef={containerRef}
          />
        )}

        {!loading && !error && messages.length > 0 && chatMessages.length === 0 && !chatStreaming && (
          <div className="py-4 text-center text-xs text-muted-foreground">
            {t("— 会话结束 —")}</div>
        )}

        {chatMessages.length > 0 && (
          <ChatMessagesBlock
            messages={chatMessages}
            source={source}
            onSubmitAnswers={handleSubmitAnswers}
          />
        )}
        {chatStreaming && (
          <div className="px-6">
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <div className="flex gap-1">
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
              </div>
            </div>
          </div>
        )}
        {chatError && (
          <div className="px-6">
            <div className="flex items-center gap-2 py-2 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {chatError}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </ScrollArea>

      {resolvedSessionId && cliAvailable && (
        <div className="shrink-0 border-t border-border">
          <ChatInput
            paneId={paneId}
            onSend={handleSendChat}
            onCancel={() => cancelPane(paneId)}
            isStreaming={chatStreaming}
            disabled={!chatProjectPath}
          />
        </div>
      )}
    </div>
  );
}

/* ── Helper: Chat messages with tool linking ── */
const ChatMessagesBlock = memo(function ChatMessagesBlock({
  messages,
  source,
  onSubmitAnswers,
}: {
  messages: ChatMessage[];
  source: MessageSource;
  onSubmitAnswers: (answers: string) => void;
}) {
  useTranslation();
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
          source={source}
          toolResultMap={toolResultMap}
          linkedToolUseIds={linkedToolUseIds}
          onSubmitAnswers={onSubmitAnswers}
          interactiveQuestions
        />
      ))}
      </div>
    );
}, (prevProps, nextProps) => (
  prevProps.messages === nextProps.messages &&
  prevProps.source === nextProps.source &&
  prevProps.onSubmitAnswers === nextProps.onSubmitAnswers
));

function assistantNameFromSource(source: MessageSource) {
  return source === "codex"
    ? "Codex"
    : source === "grok"
      ? "Grok"
      : source === "omp"
        ? "Oh My Pi"
        : "Claude";
}

function extractUserQuestionPreview(message: DisplayMessage) {
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const normalized = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(```|~~~)/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s+/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/^\[[ xX]\]\s+/, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!normalized) {
    return t("（用户消息）");
  }

  const sentenceEndChars = new Set(["。", "！", "？", "!", "?", "；", ";", "…"]);

  for (let i = 0; i < normalized.length; i += 1) {
    const current = normalized[i];
    if (sentenceEndChars.has(current)) {
      return normalized.slice(0, i + 1).trim();
    }

    if (current === ".") {
      const prev = normalized[i - 1] ?? "";
      const next = normalized[i + 1] ?? "";
      const isDecimalPoint = /\d/.test(prev) && /\d/.test(next);
      if (!isDecimalPoint && (!next || /\s/.test(next))) {
        return normalized.slice(0, i + 1).trim();
      }
    }
  }

  return normalized.length > 48 ? `${normalized.slice(0, 48).trim()}...` : normalized;
}
