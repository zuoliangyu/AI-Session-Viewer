import { useState, useEffect } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { ProjectEntry, ProjectSourceStatus } from "../../types";

interface DeleteProjectDialogProps {
  project: ProjectEntry;
  deleteSource: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export function DeleteProjectDialog({
  project,
  deleteSource,
  onConfirm,
  onCancel,
}: DeleteProjectDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [sourceStatus, setSourceStatus] = useState<ProjectSourceStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  // 当 deleteSource=true 时，加载源代码 git 状态
  useEffect(() => {
    if (!deleteSource) return;

    let cancelled = false;
    const loadStatus = async () => {
      setStatusLoading(true);
      setStatusError(null);
      try {
        const { checkProjectSourceStatus } = await import("../../services/api").then(m => m.api);
        const status = await checkProjectSourceStatus(project.source, project.id);
        if (!cancelled) setSourceStatus(status);
      } catch (e) {
        if (!cancelled) setStatusError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    };
    loadStatus();
    return () => { cancelled = true; };
  }, [deleteSource, project.source, project.id]);

  const handleConfirm = async () => {
    setDeleting(true);
    try {
      await onConfirm();
    } catch (err) {
      console.error("Failed to delete project:", err);
    } finally {
      setDeleting(false);
    }
  };

  const displayName = project.alias ?? project.shortName;
  const confirmMatch = confirmInput === project.shortName;

  // 简单确认模式（仅删除会话数据）
  if (!deleteSource) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg">
          <h3 className="text-lg font-semibold mb-2">确认删除工程</h3>
          <p className="text-sm text-muted-foreground mb-1">
            工程：<span className="font-medium text-foreground">{displayName}</span>
          </p>
          <p className="text-xs text-muted-foreground mb-1 break-all">
            路径：{project.displayPath}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            将永久删除 {project.sessionCount} 个会话及所有相关数据，且无法恢复。
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={deleting}
              className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleConfirm}
              disabled={deleting}
              className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors flex items-center gap-1.5"
            >
              {deleting ? "删除中..." : "删除"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 强确认模式（删除会话数据 + 源代码）
  const hasWarnings = sourceStatus && (sourceStatus.hasUncommittedChanges || sourceStatus.hasUnpushedCommits);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-lg">
        <h3 className="text-lg font-semibold mb-3 text-destructive">确认删除工程及源代码</h3>

        <div className="space-y-1.5 mb-4">
          <p className="text-sm text-muted-foreground">
            工程：<span className="font-medium text-foreground">{displayName}</span>
          </p>
          {sourceStatus && (
            <p className="text-xs text-muted-foreground break-all">
              源代码：{sourceStatus.sourcePath}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            会话数：{project.sessionCount} 个
          </p>
        </div>

        {/* 加载中 */}
        {statusLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            正在检查源代码状态...
          </div>
        )}

        {/* 加载错误 */}
        {statusError && (
          <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 px-3 py-2 mb-3">
            <p className="text-xs text-yellow-600 dark:text-yellow-400">
              无法检查源代码状态：{statusError}
            </p>
          </div>
        )}

        {/* Git 状态警告 */}
        {hasWarnings && (
          <div className="space-y-1.5 mb-3">
            {sourceStatus.hasUncommittedChanges && (
              <div className="flex items-center gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 px-3 py-2">
                <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0" />
                <span className="text-xs text-yellow-600 dark:text-yellow-400">检测到未提交的更改</span>
              </div>
            )}
            {sourceStatus.hasUnpushedCommits && (
              <div className="flex items-center gap-2 rounded-md bg-orange-500/10 border border-orange-500/30 px-3 py-2">
                <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0" />
                <span className="text-xs text-orange-600 dark:text-orange-400">检测到未推送的提交</span>
              </div>
            )}
          </div>
        )}

        {/* 确认输入框 */}
        <div className="mb-4">
          <p className="text-xs text-muted-foreground mb-1.5">
            输入 "<span className="font-mono font-medium text-foreground">{project.shortName}</span>" 以确认删除
          </p>
          <input
            type="text"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder={project.shortName}
            autoFocus
            className="w-full bg-muted border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-destructive font-mono"
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
              if (e.key === "Enter" && confirmMatch && !deleting && !statusLoading) handleConfirm();
            }}
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={deleting || !confirmMatch || statusLoading}
            className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {deleting ? "删除中..." : "永久删除"}
          </button>
        </div>
      </div>
    </div>
  );
}
