import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
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
  Star,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { api } from "../../services/api";
import { SessionMetaEditor } from "./SessionMetaEditor";

declare const __IS_TAURI__: boolean;

export function SessionsPage() {
  const { projectId: rawProjectId } = useParams<{ projectId: string }>();
  const projectId = rawProjectId || "";
  const navigate = useNavigate();
  const {
    source,
    sessions,
    sessionsLoading,
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
  } = useAppStore();

  const project = projects.find((p) => p.id === projectId);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteTargetSessionId, setDeleteTargetSessionId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editingSession, setEditingSession] = useState<string | null>(null);

  const [showCleanDialog, setShowCleanDialog] = useState(false);
  const [cleanSelected, setCleanSelected] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);

  const emptySessions = sessions.filter((s) => s.messageCount === 0);

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

  const getResumeCommand = (sessionId: string) =>
    source === "claude"
      ? `claude --resume ${sessionId}`
      : `codex resume ${sessionId}`;

  const handleCopyCommand = async (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    await navigator.clipboard.writeText(getResumeCommand(sessionId));
    setCopiedId(sessionId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const { terminalShell } = useAppStore();

  const [resumeError, setResumeError] = useState<string | null>(null);

  const handleResume = async (
    e: React.MouseEvent,
    sessionId: string,
    projectPath: string | null,
    filePath?: string
  ) => {
    e.stopPropagation();
    setResumeError(null);
    if (__IS_TAURI__) {
      if (!projectPath) return;
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

  const editSession = editingSession
    ? sessions.find((s) => s.sessionId === editingSession)
    : null;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate("/projects")}
          className="p-1 rounded hover:bg-accent transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold">
            {project?.shortName || projectId}
          </h1>
          {project && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {project.displayPath}
            </p>
          )}
        </div>
        {emptySessions.length > 0 && (
          <button
            onClick={() => {
              setCleanSelected(new Set(emptySessions.map((s) => s.filePath)));
              setShowCleanDialog(true);
            }}
            className="ml-auto text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            清理空会话 ({emptySessions.length})
          </button>
        )}
      </div>

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
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
              清除筛选
            </button>
          )}
        </div>
      )}

      {/* Resume error toast */}
      {resumeError && (
        <div className="mb-3 px-4 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
          {resumeError}
        </div>
      )}

      {/* Sessions list */}
      {sessionsLoading ? (
        <div className="text-muted-foreground">加载会话列表...</div>
      ) : filteredSessions.length === 0 ? (
        <div className="text-muted-foreground">
          {tagFilter.length > 0
            ? "没有匹配筛选条件的会话。"
            : "此项目没有会话记录。"}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredSessions.map((session) => (
            <div
              key={session.sessionId}
              onClick={() =>
                navigate(
                  `/projects/${encodeURIComponent(projectId)}/session/${encodeURIComponent(session.filePath)}`
                )
              }
              className="bg-card border border-border rounded-lg p-4 hover:border-primary/50 hover:bg-accent/30 transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between gap-4">
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
                  {/* Title: alias or firstPrompt */}
                  <p className="text-sm font-medium text-foreground line-clamp-2">
                    {session.alias || session.firstPrompt || "（无标题）"}
                  </p>
                  {/* Show original firstPrompt when alias is set */}
                  {session.alias && session.firstPrompt && (
                    <p className="text-xs text-muted-foreground/60 mt-0.5 line-clamp-1">
                      {session.firstPrompt}
                    </p>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground flex-wrap">
                    {session.messageCount != null && (
                      <span className="flex items-center gap-1">
                        <MessageSquare className="w-3 h-3" />
                        {session.messageCount} 条消息
                      </span>
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
                        {formatDistanceToNow(
                          new Date(session.modified),
                          { addSuffix: true, locale: zhCN }
                        )}
                      </span>
                    )}
                    {session.created && (
                      <span className="text-muted-foreground/60">
                        创建于{" "}
                        {format(new Date(session.created), "yyyy-MM-dd HH:mm")}
                      </span>
                    )}
                    {session.modelProvider && (
                      <span className="px-1.5 py-0.5 bg-muted rounded text-xs">
                        {session.modelProvider}
                      </span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
                          sessionTitle: session.alias || session.firstPrompt || session.sessionId,
                          projectName: project?.shortName || projectId,
                        });
                      }
                    }}
                    className={`p-1.5 text-xs rounded-md transition-colors ${
                      isBookmarked(session.sessionId)
                        ? "text-yellow-500"
                        : "text-muted-foreground hover:text-yellow-500"
                    }`}
                    title={isBookmarked(session.sessionId) ? "取消收藏" : "收藏会话"}
                  >
                    <Star className={`w-3.5 h-3.5 ${isBookmarked(session.sessionId) ? "fill-current" : ""}`} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingSession(session.sessionId);
                    }}
                    className="p-1.5 text-xs text-muted-foreground rounded-md hover:bg-accent hover:text-foreground transition-colors"
                    title="编辑标签和别名"
                  >
                    <Tag className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={(e) =>
                      handleResume(
                        e,
                        session.sessionId,
                        session.projectPath || session.cwd || project?.displayPath || null,
                        session.filePath
                      )
                    }
                    onContextMenu={(e) => handleCopyCommand(e, session.sessionId)}
                    className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-1"
                    title={__IS_TAURI__ ? "在终端中恢复此会话（右键复制命令）" : "复制恢复命令"}
                  >
                    {copiedId === session.sessionId ? (
                      <>已复制</>
                    ) : __IS_TAURI__ ? (
                      <><Play className="w-3 h-3" />Resume</>
                    ) : (
                      <><Copy className="w-3 h-3" />复制命令</>
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(session.filePath);
                      setDeleteTargetSessionId(session.sessionId);
                    }}
                    className="p-1.5 text-xs text-muted-foreground rounded-md hover:bg-destructive/10 hover:text-destructive transition-colors"
                    title="删除此会话"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg">
            <h3 className="text-lg font-semibold mb-2">确认删除</h3>
            <p className="text-sm text-muted-foreground mb-4">
              确定要删除此会话吗？此操作不可撤销。
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteTargetSessionId(null);
                }}
                disabled={deleting}
                className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors flex items-center gap-1.5"
              >
                {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {deleting ? "删除中..." : "删除"}
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

      {/* 清理空会话对话框 */}
      {showCleanDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-lg">
            <h3 className="text-lg font-semibold mb-1">清理空会话</h3>
            <p className="text-sm text-muted-foreground mb-4">
              以下会话没有消息记录，选择后点击删除。
            </p>
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
                      {new Date(s.modified).toLocaleDateString()}
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
                {cleanSelected.size === emptySessions.length ? "取消全选" : "全选"}
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCleanDialog(false)}
                  disabled={cleaning}
                  className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={async () => {
                    if (cleanSelected.size === 0) return;
                    setCleaning(true);
                    try {
                      const targets = emptySessions.filter((s) => cleanSelected.has(s.filePath));
                      await Promise.all(
                        targets.map((s) => deleteSession(s.filePath, s.sessionId))
                      );
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
                  {cleaning ? "删除中..." : `删除已选 ${cleanSelected.size} 个`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
