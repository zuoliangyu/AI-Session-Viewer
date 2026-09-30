import { t, getDateLocale } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { ActionMenu } from "../common/ActionMenu";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppStore } from "../../stores/appStore";
import {
  ArrowLeft,
  MessageSquare,
  Clock,
  GitBranch,
  Play,
  Trash2,
  Loader2,
  Tag,
  Copy,
  CopyPlus,
  Star,
  AlertTriangle,
  Download,
  CheckSquare,
  X,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import { api } from "../../services/api";
import { SessionMetaEditor } from "./SessionMetaEditor";
import { CloneToProviderDialog } from "./CloneToProviderDialog";
import { ExportFormatMenu } from "./ExportFormatMenu";
import { ScanProgressView } from "../common/ScanProgressView";
import { ProjectSkillsPanel } from "../skills/ProjectSkillsPanel";
import { saveExport, saveExportMany } from "../../services/exportHelpers";
import type { ExportFormat, SessionIndexEntry } from "../../types";
import { formatDateOnly, formatDateTime } from "../../utils/dateTime";
import { getResumeCommand } from "../../utils/resumeCommand";
import { isRemoteNodeActive } from "../../services/nodeConfig";
import { copyTextToClipboard } from "../message/utils";
import { EmptyState, ErrorState } from "../common/StateViews";
import { useShallow } from "zustand/react/shallow";

declare const __IS_TAURI__: boolean;
// Remote-node mode routes the API to a web server, where resume_session is a
// no-op, so only a local desktop session can open a terminal.
const USE_TAURI_TRANSPORT = __IS_TAURI__ && !isRemoteNodeActive();

function sessionFilenameBase(s: SessionIndexEntry): string {
  return s.alias || s.threadName || s.firstPrompt || s.sessionId;
}

export function SessionsPage() {
  const { t } = useTranslation();
  const { projectId: rawProjectId } = useParams<{ projectId: string }>();
  const projectId = rawProjectId || "";
  const navigate = useNavigate();
  const {
    source,
    sessions,
    invalidSessions,
    sessionsLoading,
    sessionsError,
    selectProject,
    deleteSession,
    projects,
    allTags,
    tagFilter,
    setTagFilter,
    addBookmark,
    removeBookmark,
    isBookmarked,
    bookmarks,
    timeZone,
  } = useAppStore(
    useShallow((state) => ({ source: state.source, sessions: state.sessions, invalidSessions: state.invalidSessions, sessionsLoading: state.sessionsLoading, sessionsError: state.sessionsError, selectProject: state.selectProject, deleteSession: state.deleteSession, projects: state.projects, allTags: state.allTags, tagFilter: state.tagFilter, setTagFilter: state.setTagFilter, addBookmark: state.addBookmark, removeBookmark: state.removeBookmark, isBookmarked: state.isBookmarked, bookmarks: state.bookmarks, timeZone: state.timeZone })),
  );

  const project = projects.find((p) => p.id === projectId);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteTargetSessionId, setDeleteTargetSessionId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [cloningSession, setCloningSession] = useState<SessionIndexEntry | null>(null);

  const [showCleanDialog, setShowCleanDialog] = useState(false);
  const [cleanSelected, setCleanSelected] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);

  // 多选模式（批量导出 / 批量删除）
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // by filePath
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  // 单会话导出格式浮层
  const [exportMenu, setExportMenu] = useState<{ session: SessionIndexEntry; rect: DOMRect } | null>(null);
  // 批量导出格式浮层
  const [batchExportRect, setBatchExportRect] = useState<DOMRect | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const toggleSelected = (filePath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  // invalidSessions 由 store 在 selectProject 时从同一次 getSessions 响应拆分而来 ——
  // 不再单独 RPC 拉取，避免冷缓存下两个调用各自启动一次完整扫描。
  // 兼容老 API：status 缺失视为 empty（getInvalidSessions 旧版只返回空会话）。
  const emptySessions = invalidSessions.filter(
    (s) => (s.status ?? "empty") === "empty",
  );
  const corruptSessions = invalidSessions.filter((s) => s.status === "corrupt");

  useEffect(() => {
    if (projectId) {
      selectProject(projectId);
    }
  }, [projectId, source]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteSession(deleteTarget, deleteTargetSessionId || undefined);
    } catch (err) {
      console.error("Failed to delete session:", err);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
      setDeleteTargetSessionId(null);
    }
  };

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyCommand = async (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const command = getResumeCommand(source, sessionId);
    if (!(await copyTextToClipboard(command))) {
      setResumeError(t("复制失败，请手动复制：{{v0}}", { v0: command }));
      setTimeout(() => setResumeError(null), 5000);
      return;
    }
    setCopiedId(sessionId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const { terminalShell } = useAppStore(
    useShallow((state) => ({ terminalShell: state.terminalShell })),
  );

  const [resumeError, setResumeError] = useState<string | null>(null);

  const handleResume = async (
    e: React.MouseEvent,
    sessionId: string,
    projectPath: string | null,
    filePath?: string
  ) => {
    e.stopPropagation();
    setResumeError(null);
    if (USE_TAURI_TRANSPORT) {
      if (!projectPath) {
        setResumeError(t("找不到会话所在的项目目录，无法在终端中恢复"));
        setTimeout(() => setResumeError(null), 5000);
        return;
      }
      try {
        await api.resumeSession(source, sessionId, projectPath, filePath, terminalShell);
      } catch (err) {
        const msg = typeof err === "string" ? err : String(err);
        setResumeError(msg);
        setTimeout(() => setResumeError(null), 5000);
      }
    } else {
      await handleCopyCommand(e, sessionId);
    }
  };

  const toggleTagFilter = (tag: string) => {
    if (tagFilter.includes(tag)) {
      setTagFilter(tagFilter.filter((t) => t !== tag));
    } else {
      setTagFilter([...tagFilter, tag]);
    }
  };

  // Filter sessions by tags
  const filteredSessions =
    tagFilter.length > 0
      ? sessions.filter((s) =>
          tagFilter.every((t) => s.tags?.includes(t))
        )
      : sessions;

  // 预计算每个会话的日期文案：date-fns 较重，几百行 × 每行两次会在切换选择
  // 模式（整列表重渲染）时造成明显卡顿。按 sessions 缓存，仅在会话列表变化时重算。
  const dateMap = useMemo(() => {
    const m = new Map<string, { rel: string | null; created: string | null }>();
    for (const s of sessions) {
      m.set(s.sessionId, {
        rel: s.modified
          ? formatDistanceToNow(new Date(s.modified), { addSuffix: true, locale: getDateLocale() })
          : null,
        created: s.created
          ? formatDateTime(s.created, timeZone, "minute")
          : null,
      });
    }
    return m;
  }, [sessions, timeZone, t]);

  const editSession = editingSession
    ? sessions.find((s) => s.sessionId === editingSession)
    : null;

  const selectedSessions = filteredSessions.filter((s) => selected.has(s.filePath));

  // 列表虚拟化：只渲染可见行，几百/上千会话也能秒切、流畅滚动。卡片变高，用
  // measureElement 动态测量。滚动容器是下方 flex-1 区域。
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sessionView, setSessionView] = useState(() => localStorage.getItem("sessionLayout") === "list" ? "list" : "grid");
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const update = () => setCols(sessionView === "list" ? 1 : Math.min(4, Math.max(1, Math.floor((container.clientWidth - 48) / 280))));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [sessionView]);
  const sessionRows = useMemo(() => {
    const rows: SessionIndexEntry[][] = [];
    for (let i = 0; i < filteredSessions.length; i += cols) rows.push(filteredSessions.slice(i, i + cols));
    return rows;
  }, [filteredSessions, cols]);
  const rowVirtualizer = useVirtualizer({
    count: sessionRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => sessionView === "grid" ? 132 : 112,
    overscan: 8,
  });

  // 单会话导出
  const handleExportSingle = async (s: SessionIndexEntry, fmt: ExportFormat) => {
    setExportError(null);
    try {
      const content = await api.exportSession(source, s.filePath, fmt);
      await saveExport(content, sessionFilenameBase(s), fmt);
    } catch (err) {
      setExportError(typeof err === "string" ? err : String(err));
      setTimeout(() => setExportError(null), 5000);
    }
  };

  // 批量导出：逐个取内容再一次性保存到目录（Tauri）或逐个下载（Web）
  const handleBatchExport = async (fmt: ExportFormat) => {
    if (selectedSessions.length === 0) return;
    setBatchBusy(true);
    setExportError(null);
    try {
      const items = [];
      for (const s of selectedSessions) {
        const content = await api.exportSession(source, s.filePath, fmt);
        items.push({ content, filenameBase: sessionFilenameBase(s) });
      }
      await saveExportMany(items, fmt);
    } catch (err) {
      setExportError(typeof err === "string" ? err : String(err));
      setTimeout(() => setExportError(null), 5000);
    } finally {
      setBatchBusy(false);
    }
  };

  // 批量删除（移入回收站，可还原）
  const handleBatchDelete = async () => {
    if (selectedSessions.length === 0) return;
    setBatchBusy(true);
    try {
      await Promise.all(
        selectedSessions.map((s) => deleteSession(s.filePath, s.sessionId)),
      );
      exitSelectMode();
    } catch (err) {
      console.error("Failed to batch delete sessions:", err);
    } finally {
      setBatchBusy(false);
      setBatchDeleteOpen(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="workspace-list-header">
      {/* Header */}
      <div className="workspace-page-header">
        <button
          onClick={() =>
            navigate(projectId.startsWith("<codex-direct>/") ? "/direct-chat" : "/projects")
          }
          className="p-1 rounded hover:bg-accent transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="workspace-page-title truncate">
            {project?.shortName || projectId}
          </h1>
          {project && (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {project.displayPath}
            </p>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select aria-label={t("会话显示方式")} className="toolbar-button" value={sessionView} onChange={(event) => { setSessionView(event.target.value); localStorage.setItem("sessionLayout", event.target.value); }}><option value="grid">{t("网格")}</option><option value="list">{t("列表")}</option></select>
          {emptySessions.length > 0 && (
            <button
              onClick={() => {
                setCleanSelected(new Set(emptySessions.map((s) => s.filePath)));
                setShowCleanDialog(true);
              }}
              className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t("清理空会话 (")}{emptySessions.length})
            </button>
          )}
          {sessions.length > 0 && (
            selectMode ? (
              <button
                onClick={exitSelectMode}
                className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
              >
                <X className="w-3.5 h-3.5" />
                {t("退出选择")}</button>
            ) : (
              <button
                onClick={() => setSelectMode(true)}
                className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors flex items-center gap-1.5"
              >
                <CheckSquare className="w-3.5 h-3.5" />
                {t("选择")}</button>
            )
          )}
        </div>
      </div>

      {/* 损坏会话提示：has_messages 但 JSONL 中部解析失败，正常列表会过滤掉，
          但仍可在 /cleanup 里查看残存内容或清理。 */}
      {corruptSessions.length > 0 && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-sm text-amber-500 flex items-center justify-between gap-3 flex-wrap">
          <span className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="truncate">
              {t("本项目有")}{corruptSessions.length} {t("个会话因文件损坏被隐藏，未出现在下方列表中。")}</span>
          </span>
          <button
            onClick={() => navigate("/cleanup")}
            className="text-xs underline hover:text-amber-400 transition-colors shrink-0"
          >
            {t("查看并清理 →")}</button>
        </div>
      )}

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <details className="workspace-filter"><summary>{t("标签筛选")}{tagFilter.length > 0 ? t(" · 已选 ") + tagFilter.length : ""}</summary>
        <div className="flex flex-wrap items-center gap-2">
          <Tag className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => toggleTagFilter(tag)}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                tagFilter.includes(tag)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/50 text-muted-foreground border-border hover:border-primary/50"
              }`}
            >
              {tag}
            </button>
          ))}
          {tagFilter.length > 0 && (
            <button
              onClick={() => setTagFilter([])}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("清除筛选")}</button>
          )}
        </div></details>
      )}

      {/* Resume error toast */}
      {resumeError && (
        <div className="mb-3 px-4 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
          {resumeError}
        </div>
      )}

      {/* 项目 / 全局 Skills（折叠，展开时才扫描） */}
      <ProjectSkillsPanel
        projectPath={project && !project.isVirtual ? project.displayPath : null}
      />

      </div>

      {/* Sessions list（虚拟化滚动容器） */}
      <div ref={scrollRef} className="workspace-list-body">
      {sessionsLoading ? (
        <ScanProgressView label={t("加载会话列表")} />
      ) : sessionsError && sessions.length === 0 ? (
        <ErrorState
          title={t("会话列表加载失败")}
          message={sessionsError}
          onRetry={() => selectProject(projectId)}
        />
      ) : filteredSessions.length === 0 ? (
        <EmptyState
          title={tagFilter.length > 0 ? t("没有匹配筛选条件的会话。") : t("此项目没有会话记录。")}
        />
      ) : (
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            return (
            <div
              key={virtualRow.index}
              className="focus-within:z-30"
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
                paddingBottom: "0.75rem",
              }}
            >
            <div className={"grid gap-3 " + (sessionView === "grid" ? "session-card-grid" : "")} style={{ gridTemplateColumns: "repeat(" + cols + ", minmax(0, 1fr))" }}>
            {sessionRows[virtualRow.index].map((session) => (
            <div
              key={session.filePath}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.currentTarget.click(); } }}
              onClick={() => {
                if (selectMode) {
                  toggleSelected(session.filePath);
                  return;
                }
                navigate(
                  `/projects/${encodeURIComponent(projectId)}/session/${encodeURIComponent(session.filePath)}`
                );
              }}
              className={`session-card relative bg-card border rounded-lg p-3 hover:border-primary/50 hover:bg-accent/30 transition-colors cursor-pointer group ${
                selected.has(session.filePath)
                  ? "border-primary bg-primary/5"
                  : "border-border"
              }`}
            >
              <div className="session-card-content flex flex-col items-stretch justify-between gap-3 xl:flex-row xl:items-center">
                <input
                  type="checkbox"
                  checked={selected.has(session.filePath)}
                  onChange={() => toggleSelected(session.filePath)}
                  onClick={(e) => e.stopPropagation()}
                  className={`accent-primary w-4 h-4 shrink-0 ${selectMode ? "" : "hidden"}`}
                />
                <div className="min-w-0 flex-1">
                  {/* Tags */}
                  {session.tags && session.tags.length > 0 && (
                    <div className="flex items-center gap-1.5 mb-1.5">
                      {session.tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-block px-2 py-0.5 text-xs rounded-full bg-primary/15 text-primary"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Title: alias > Codex thread title > firstPrompt */}
                  <p className="text-sm font-medium text-foreground line-clamp-2">
                    {session.alias || session.threadName || session.firstPrompt || t("（无标题）")}
                  </p>
                  {/* Show original firstPrompt as subtitle when a generated
                      title (alias or Codex thread name) replaced it */}
                  {(session.alias || session.threadName) &&
                    session.firstPrompt &&
                    session.firstPrompt !== (session.alias || session.threadName) && (
                      <p className="text-xs text-muted-foreground/60 mt-0.5 line-clamp-1">
                        {session.firstPrompt}
                      </p>
                    )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground flex-wrap">
                    {session.messageCount != null && (
                      <span className="flex items-center gap-1">
                        <MessageSquare className="w-3 h-3" />
                        {session.messageCount} {t("条消息")}</span>
                    )}
                    {session.gitBranch && (
                      <span className="flex items-center gap-1">
                        <GitBranch className="w-3 h-3" />
                        {session.gitBranch}
                      </span>
                    )}
                    {session.modified && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {dateMap.get(session.sessionId)?.rel}
                      </span>
                    )}
                    {session.created && (
                      <span className="session-created-date text-muted-foreground/60">
                        {t("创建于")}{dateMap.get(session.sessionId)?.created}
                      </span>
                    )}
                    {session.modelProvider && (
                      <span className="px-1.5 py-0.5 bg-muted rounded text-xs">
                        {session.modelProvider}
                      </span>
                    )}
                  </div>
                </div>
                <div className={"session-card-menu " + (selectMode ? "hidden" : "")} onClick={(event) => event.stopPropagation()}>
                  <ActionMenu label={t("操作")}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const bookmarked = isBookmarked(session.sessionId);
                      if (bookmarked) {
                        const bm = bookmarks.find(
                          (b) => b.sessionId === session.sessionId && b.messageId === null
                        );
                        if (bm) removeBookmark(bm.id);
                      } else {
                        addBookmark({
                          source,
                          projectId: projectId,
                          sessionId: session.sessionId,
                          filePath: session.filePath,
                          messageId: null,
                          preview: "",
                          sessionTitle: session.alias || session.threadName || session.firstPrompt || session.sessionId,
                          projectName: project?.shortName || projectId,
                        });
                      }
                    }}
                    className={`p-1.5 text-xs rounded-md transition-colors ${
                      isBookmarked(session.sessionId)
                        ? "text-yellow-500"
                        : "text-muted-foreground hover:text-yellow-500"
                    }`}
                    title={isBookmarked(session.sessionId) ? t("取消收藏") : t("收藏会话")}
                  >
                    <Star className={`w-3.5 h-3.5 ${isBookmarked(session.sessionId) ? "fill-current" : ""}`} />{isBookmarked(session.sessionId) ? t("取消收藏") : t("收藏会话")}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingSession(session.sessionId);
                    }}
                    className="p-1.5 text-xs text-muted-foreground rounded-md hover:bg-accent hover:text-foreground transition-colors"
                    title={t("编辑标签和别名")}
                  >
                    <Tag className="w-3.5 h-3.5" />{t("编辑标签和别名")}</button>
                  {source === "codex" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setCloningSession(session);
                      }}
                      className="p-1.5 text-xs text-muted-foreground rounded-md hover:bg-accent hover:text-foreground transition-colors"
                      title={t("克隆到其他 Provider（非破坏式）")}
                    >
                      <CopyPlus className="w-3.5 h-3.5" />{t("克隆到其他 Provider")}</button>
                  )}
                  {(source === "claude" || source === "codex" || source === "grok" || source === "omp") && (
                    <button
                      onClick={(e) =>
                        handleResume(
                          e,
                          session.sessionId,
                          session.projectPath || session.cwd || project?.displayPath || null,
                          session.filePath
                        )
                      }
                      className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-1"
                      title={USE_TAURI_TRANSPORT ? t("在终端中恢复此会话") : t("复制恢复命令")}
                    >
                      {USE_TAURI_TRANSPORT ? (
                        <><Play className="w-3 h-3" />{t("终端续聊")}</>
                      ) : (
                        <>{copiedId === session.sessionId ? t("已复制") : <><Copy className="w-3 h-3" />{t("复制命令")}</>}</>
                      )}
                    </button>
                  )}
                  {USE_TAURI_TRANSPORT && (source === "claude" || source === "codex" || source === "grok" || source === "omp") && (
                    <button
                      onClick={(e) => handleCopyCommand(e, session.sessionId)}
                      className="px-3 py-1.5 text-xs border border-border text-muted-foreground rounded-md hover:bg-accent hover:text-foreground flex items-center gap-1"
                      title={t("复制恢复命令")}
                    >
                      {copiedId === session.sessionId ? (
                        <>{t("已复制")}</>
                      ) : (
                        <><Copy className="w-3 h-3" />{t("复制命令")}</>
                      )}
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setExportMenu({ session, rect: e.currentTarget.getBoundingClientRect() });
                    }}
                    className="p-1.5 text-xs text-muted-foreground rounded-md hover:bg-accent hover:text-foreground transition-colors"
                    title={t("导出此会话")}
                  >
                    <Download className="w-3.5 h-3.5" />{t("导出会话")}</button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(session.filePath);
                      setDeleteTargetSessionId(session.sessionId);
                    }}
                    className="p-1.5 text-xs text-muted-foreground rounded-md hover:bg-destructive/10 hover:text-destructive transition-colors"
                    title={t("删除此会话")}
                  >
                    <Trash2 className="w-3.5 h-3.5" />{t("删除会话")}</button>
                  </ActionMenu>
                </div>
              </div>
            </div>
            ))}
            </div>
            </div>
            );
          })}
        </div>
      )}
      </div>

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg">
            <h3 className="text-lg font-semibold mb-2">{t("确认删除")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("确定要删除此会话吗？此操作不可撤销。")}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteTargetSessionId(null);
                }}
                disabled={deleting}
                className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
              >
                {t("取消")}</button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors flex items-center gap-1.5"
              >
                {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {deleting ? t("删除中...") : t("删除")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Meta editor modal */}
      {editingSession && editSession && (
        <SessionMetaEditor
          sessionId={editingSession}
          currentAlias={editSession.alias}
          currentTags={editSession.tags}
          onClose={() => setEditingSession(null)}
        />
      )}

      {/* Clone-to-provider modal (codex only) */}
      {cloningSession && (
        <CloneToProviderDialog
          session={cloningSession}
          onClose={() => setCloningSession(null)}
          onCloned={() => {
            void selectProject(projectId);
          }}
        />
      )}

      {/* 清理空会话对话框 */}
      {showCleanDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-lg">
            <h3 className="text-lg font-semibold mb-1">{t("清理空会话")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("以下会话没有消息记录，选择后点击删除。")}</p>
            <div className="space-y-1 max-h-60 overflow-y-auto mb-4">
              {emptySessions.map((s) => (
                <label
                  key={s.filePath}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={cleanSelected.has(s.filePath)}
                    onChange={(e) => {
                      const next = new Set(cleanSelected);
                      if (e.target.checked) next.add(s.filePath);
                      else next.delete(s.filePath);
                      setCleanSelected(next);
                    }}
                    className="rounded"
                  />
                  <span className="text-xs text-muted-foreground font-mono truncate flex-1">
                    {s.sessionId.slice(0, 8)}...
                  </span>
                  {s.modified && (
                    <span className="text-xs text-muted-foreground/60 shrink-0">
                      {formatDateOnly(s.modified, timeZone)}
                    </span>
                  )}
                </label>
              ))}
            </div>
            <div className="flex justify-between items-center">
              <button
                onClick={() => {
                  if (cleanSelected.size === emptySessions.length) {
                    setCleanSelected(new Set());
                  } else {
                    setCleanSelected(new Set(emptySessions.map((s) => s.filePath)));
                  }
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {cleanSelected.size === emptySessions.length ? t("取消全选") : t("全选")}
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCleanDialog(false)}
                  disabled={cleaning}
                  className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
                >
                  {t("取消")}</button>
                <button
                  onClick={async () => {
                    if (cleanSelected.size === 0) return;
                    setCleaning(true);
                    try {
                      const targets = emptySessions.filter((s) => cleanSelected.has(s.filePath));
                      await Promise.all(
                        targets.map((s) => deleteSession(s.filePath, s.sessionId))
                      );
                      // selectProject 会重读全分类并自动重填 sessions + invalidSessions
                      await selectProject(projectId);
                    } catch (err) {
                      console.error("Failed to clean sessions:", err);
                    } finally {
                      setCleaning(false);
                      setShowCleanDialog(false);
                      setCleanSelected(new Set());
                    }
                  }}
                  disabled={cleaning || cleanSelected.size === 0}
                  className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                >
                  {cleaning ? t("删除中...") : t("删除已选 {{v0}} 个", { v0: cleanSelected.size })}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 多选底部浮动操作条 */}
      {selectMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-card border border-border rounded-xl shadow-lg px-4 py-2.5">
          <button
            onClick={() => {
              if (selectedSessions.length === filteredSessions.length) {
                setSelected(new Set());
              } else {
                setSelected(new Set(filteredSessions.map((s) => s.filePath)));
              }
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {selectedSessions.length === filteredSessions.length ? t("取消全选") : t("全选")}
          </button>
          <span className="text-sm text-foreground">{t("已选")}{selectedSessions.length}</span>
          <button
            onClick={(e) => setBatchExportRect(e.currentTarget.getBoundingClientRect())}
            disabled={batchBusy || selectedSessions.length === 0}
            className="text-xs px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-accent transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            {t("导出")}</button>
          <button
            onClick={() => setBatchDeleteOpen(true)}
            disabled={batchBusy || selectedSessions.length === 0}
            className="text-xs px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            {batchBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            {t("删除选中")}</button>
          <button
            onClick={exitSelectMode}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("退出")}</button>
        </div>
      )}

      {/* 单会话导出格式浮层 */}
      {exportMenu && (
        <ExportFormatMenu
          anchorRect={exportMenu.rect}
          onClose={() => setExportMenu(null)}
          onPick={(fmt) => handleExportSingle(exportMenu.session, fmt)}
        />
      )}

      {/* 批量导出格式浮层 */}
      {batchExportRect && (
        <ExportFormatMenu
          anchorRect={batchExportRect}
          title={t("导出选中 {{v0}} 个", { v0: selectedSessions.length })}
          onClose={() => setBatchExportRect(null)}
          onPick={(fmt) => handleBatchExport(fmt)}
        />
      )}

      {/* 批量删除确认 */}
      {batchDeleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg">
            <h3 className="text-lg font-semibold mb-2">{t("批量删除会话")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("将删除选中的")}{selectedSessions.length} {t("个会话（移入回收站，可在回收站还原）。")}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setBatchDeleteOpen(false)}
                disabled={batchBusy}
                className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
              >
                {t("取消")}</button>
              <button
                onClick={handleBatchDelete}
                disabled={batchBusy}
                className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {batchBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {batchBusy ? t("删除中...") : t("删除")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 导出错误提示 */}
      {exportError && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive shadow-lg max-w-md">
          {exportError}
        </div>
      )}
    </div>
  );
}
