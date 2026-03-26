import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  FileX,
  FolderX,
} from "lucide-react";
import { api } from "../../services/api";
import { useAppStore } from "../../stores/appStore";
import type { ProjectEntry, SessionIndexEntry } from "../../types";

type CleanupGroup = {
  project: ProjectEntry;
  invalidProject: boolean;
  invalidSessions: SessionIndexEntry[];
};

type SessionTarget = {
  projectId: string;
  session: SessionIndexEntry;
};

type ScanSummary = {
  totalProjects: number;
  failedProjects: number;
};

function getProjectKey(projectId: string) {
  return `project:${projectId}`;
}

function getSessionKey(projectId: string, filePath: string) {
  return `session:${projectId}:${filePath}`;
}

function getGroupItemKeys(group: CleanupGroup, includeInvalidProject: boolean) {
  return [
    ...(group.invalidProject && includeInvalidProject
      ? [getProjectKey(group.project.id)]
      : []),
    ...group.invalidSessions.map((session) =>
      getSessionKey(group.project.id, session.filePath)
    ),
  ];
}

function getSessionTitle(session: SessionIndexEntry) {
  return session.alias || session.firstPrompt || session.sessionId || "未命名会话";
}

function formatDateTime(value: string | null) {
  if (!value) return "未知时间";
  try {
    return new Date(value).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
) {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));
  let currentIndex = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = currentIndex++;
        if (index >= items.length) {
          return;
        }

        try {
          results[index] = {
            status: "fulfilled",
            value: await worker(items[index], index),
          };
        } catch (error) {
          results[index] = {
            status: "rejected",
            reason: error,
          };
        }
      }
    })
  );

  return results;
}

export function InvalidItemsPage() {
  const navigate = useNavigate();
  const { source, loadProjects } = useAppStore();
  const [groups, setGroups] = useState<CleanupGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scanSummary, setScanSummary] = useState<ScanSummary>({
    totalProjects: 0,
    failedProjects: 0,
  });
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canDeleteInvalidProjects = source !== "codex";
  const sessionDeleteHint = __IS_TAURI__
    ? "当前为桌面端，会话删除会移入回收站。"
    : "当前为 Web 端，会话删除为永久删除。";
  const scanWarning =
    scanSummary.failedProjects > 0
      ? `有 ${scanSummary.failedProjects} / ${scanSummary.totalProjects} 个项目读取会话失败，当前结果不完整，仅展示已成功扫描的项目。`
      : null;

  const reload = async (showRefreshing = false) => {
    if (showRefreshing) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setLoadError(null);
    setActionError(null);

    try {
      const projects = await api.getProjects(source);
      const sessionResults = await mapWithConcurrencyLimit(
        projects,
        4,
        async (project) => {
          const sessions = await api.getSessions(source, project.id);
          return { project, sessions };
        }
      );

      const successfulGroups = sessionResults
        .map<CleanupGroup | null>((result, index) => {
          const project = projects[index];
          if (!project) return null;

          if (result.status === "fulfilled") {
            return {
              project,
              invalidProject: project.pathExists === false,
              invalidSessions: result.value.sessions.filter(
                (session) => session.messageCount === 0
              ),
            };
          }

          if (project.pathExists === false) {
            return {
              project,
              invalidProject: true,
              invalidSessions: [],
            };
          }

          return null;
        })
        .filter((group): group is CleanupGroup => group !== null)
        .filter((group) => group.invalidProject || group.invalidSessions.length > 0)
        .sort((a, b) => {
          const aScore = Number(a.invalidProject) * 1000 + a.invalidSessions.length;
          const bScore = Number(b.invalidProject) * 1000 + b.invalidSessions.length;
          if (aScore !== bScore) return bScore - aScore;
          return (a.project.alias ?? a.project.shortName).localeCompare(
            b.project.alias ?? b.project.shortName,
            "zh-CN"
          );
        });

      const nextSelectableKeys = new Set(
        successfulGroups.flatMap((group) =>
          getGroupItemKeys(group, canDeleteInvalidProjects)
        )
      );

      setGroups(successfulGroups);
      setExpandedProjectIds((prev) => {
        if (prev.size === 0) {
          return new Set(successfulGroups.map((group) => group.project.id));
        }

        const next = new Set<string>();
        for (const group of successfulGroups) {
          if (prev.has(group.project.id)) {
            next.add(group.project.id);
          }
        }
        return next;
      });
      setSelectedKeys((prev) => {
        const next = new Set<string>();
        for (const key of prev) {
          if (nextSelectableKeys.has(key)) {
            next.add(key);
          }
        }
        return next;
      });

      const failedProjectCount = sessionResults.filter(
        (result) => result.status === "rejected"
      ).length;
      setScanSummary({
        totalProjects: projects.length,
        failedProjects: failedProjectCount,
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setScanSummary({
        totalProjects: 0,
        failedProjects: 0,
      });
      setGroups([]);
      setSelectedKeys(new Set());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadProjects();
    void reload();
  }, [source]);

  const summary = useMemo(() => {
    const invalidProjectCount = groups.filter((group) => group.invalidProject).length;
    const invalidSessionCount = groups.reduce(
      (count, group) => count + group.invalidSessions.length,
      0
    );

    return {
      invalidProjectCount,
      invalidSessionCount,
      groupCount: groups.length,
    };
  }, [groups]);

  const selectedProjectIds = useMemo(() => {
    const projectIds = new Set<string>();
    for (const group of groups) {
      if (
        canDeleteInvalidProjects &&
        selectedKeys.has(getProjectKey(group.project.id))
      ) {
        projectIds.add(group.project.id);
      }
    }
    return projectIds;
  }, [canDeleteInvalidProjects, groups, selectedKeys]);

  const selectedProjects = useMemo(
    () => groups.filter((group) => selectedProjectIds.has(group.project.id)),
    [groups, selectedProjectIds]
  );

  const selectedSessions = useMemo(() => {
    const targets: SessionTarget[] = [];

    for (const group of groups) {
      if (selectedProjectIds.has(group.project.id)) {
        continue;
      }

      for (const session of group.invalidSessions) {
        if (selectedKeys.has(getSessionKey(group.project.id, session.filePath))) {
          targets.push({ projectId: group.project.id, session });
        }
      }
    }

    return targets;
  }, [groups, selectedKeys, selectedProjectIds]);

  const rawSelectedCount = selectedKeys.size;
  const effectiveSelectedCount = selectedProjects.length + selectedSessions.length;
  const allExpanded =
    groups.length > 0 &&
    groups.every((group) => expandedProjectIds.has(group.project.id));
  const allSelectableKeys = useMemo(
    () =>
      groups.flatMap((group) => getGroupItemKeys(group, canDeleteInvalidProjects)),
    [canDeleteInvalidProjects, groups]
  );
  const hasSelectableItems = allSelectableKeys.length > 0;
  const allSelectableSelected =
    hasSelectableItems && allSelectableKeys.every((key) => selectedKeys.has(key));

  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const toggleItemSelection = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleGroupSelection = (group: CleanupGroup) => {
    const keys = getGroupItemKeys(group, canDeleteInvalidProjects);
    const allSelected = keys.length > 0 && keys.every((key) => selectedKeys.has(key));

    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (allSelected) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedKeys(allSelectableSelected ? new Set() : new Set(allSelectableKeys));
  };

  const handleDeleteSelected = async () => {
    if (effectiveSelectedCount === 0) return;

    setDeleting(true);
    setActionError(null);

    try {
      const projectTargets = canDeleteInvalidProjects ? selectedProjects : [];
      const projectResults = await Promise.allSettled(
        projectTargets.map((group) =>
          api.deleteProject(source, group.project.id, "sessionOnly")
        )
      );
      const sessionResults = await Promise.allSettled(
        selectedSessions.map(({ projectId, session }) =>
          api.deleteSession(
            session.filePath,
            source,
            projectId,
            session.sessionId || undefined
          )
        )
      );

      const failedProjectCount = projectResults.filter(
        (result) => result.status === "rejected"
      ).length;
      const failedSessionCount = sessionResults.filter(
        (result) => result.status === "rejected"
      ).length;

      await loadProjects();
      await reload();

      if (failedProjectCount > 0 || failedSessionCount > 0) {
        setActionError(
          `已删除 ${projectTargets.length - failedProjectCount} 个项目、${
            selectedSessions.length - failedSessionCount
          } 个会话，仍有 ${failedProjectCount + failedSessionCount} 项删除失败。`
        );
      } else {
        setConfirmDeleteOpen(false);
        setSelectedKeys(new Set());
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <button
              onClick={() => navigate("/projects")}
              className="text-sm hover:text-foreground transition-colors"
            >
              项目
            </button>
            <span>/</span>
            <span className="text-sm text-foreground">无效项管理</span>
          </div>
          <div className="flex items-center gap-2">
            <FolderX className="w-6 h-6 text-amber-500" />
            <h1 className="text-2xl font-bold text-foreground">无效项目 / 无效会话</h1>
          </div>
          <p className="mt-2 text-sm text-muted-foreground max-w-3xl">
            按项目分组查看异常数据。当前规则：无效项目 = 路径不存在；无效会话 = 消息数为 0。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void reload(true)}
            disabled={loading || refreshing || deleting}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors disabled:opacity-50"
          >
            <RefreshCw
              className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`}
            />
            刷新
          </button>
          <button
            onClick={() =>
              setExpandedProjectIds(
                allExpanded ? new Set() : new Set(groups.map((group) => group.project.id))
              )
            }
            disabled={groups.length === 0 || deleting}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors disabled:opacity-50"
          >
            {allExpanded ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            {allExpanded ? "全部收起" : "全部展开"}
          </button>
          <button
            onClick={toggleSelectAll}
            disabled={!hasSelectableItems || deleting}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors disabled:opacity-50"
          >
            <span
              className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
                allSelectableSelected
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-transparent"
              }`}
            >
              ✓
            </span>
            全选
          </button>
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={rawSelectedCount === 0 || deleting}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            删除已选 {rawSelectedCount > 0 ? `(${rawSelectedCount})` : ""}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">涉及项目</div>
          <div className="mt-1 text-2xl font-semibold text-foreground">
            {summary.groupCount}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            含无效项目或空会话的项目分组
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">无效项目</div>
          <div className="mt-1 text-2xl font-semibold text-amber-500">
            {summary.invalidProjectCount}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            `pathExists === false`
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">无效会话</div>
          <div className="mt-1 text-2xl font-semibold text-foreground">
            {summary.invalidSessionCount}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            `messageCount === 0`
          </div>
        </div>
      </div>

      {(loadError || actionError) && (
        <div className="space-y-3">
          {loadError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{loadError}</span>
            </div>
          )}
          {actionError && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-500">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{actionError}</span>
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-400">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p>会话删除说明：桌面端删除会移入回收站，Web 端删除为永久删除。</p>
            <p>{sessionDeleteHint}</p>
          </div>
        </div>
        {!canDeleteInvalidProjects && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-500">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              当前数据源为 `codex`，项目删除后端暂不支持。此页仅可清理无效会话，不能删除无效项目索引。
            </span>
          </div>
        )}
        {scanWarning && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-500">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{scanWarning}</span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="rounded-xl border border-border bg-card px-6 py-16 text-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground mx-auto" />
          <p className="mt-3 text-sm text-muted-foreground">正在扫描无效项目和空会话...</p>
        </div>
      ) : loadError ? (
        <div className="rounded-xl border border-dashed border-red-500/30 bg-red-500/5 px-6 py-16 text-center">
          <AlertCircle className="w-12 h-12 text-red-400/70 mx-auto" />
          <h2 className="mt-4 text-lg font-medium text-foreground">扫描失败</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            当前无法完成无效项扫描，因此还不能判断是否存在无效项目或空会话。
          </p>
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/60 px-6 py-16 text-center">
          <FolderOpen className="w-12 h-12 text-muted-foreground/30 mx-auto" />
          <h2 className="mt-4 text-lg font-medium text-foreground">
            {scanSummary.failedProjects > 0 ? "扫描尚未完成" : "暂未发现无效项"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {scanSummary.failedProjects > 0
              ? "本次扫描中有项目读取失败，当前没有发现可确认的无效项，但这不代表数据源中一定不存在无效项。"
              : "当前数据源下没有路径失效的项目，也没有消息数为 0 的会话。"}
          </p>
          {scanSummary.failedProjects > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              请稍后刷新重试，或先处理导致会话扫描失败的项目。
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const groupItemKeys = getGroupItemKeys(group, canDeleteInvalidProjects);
            const groupAllSelected =
              groupItemKeys.length > 0 &&
              groupItemKeys.every((key) => selectedKeys.has(key));
            const groupSelectedCount = groupItemKeys.filter((key) =>
              selectedKeys.has(key)
            ).length;
            const expanded = expandedProjectIds.has(group.project.id);

            return (
              <section
                key={group.project.id}
                className="overflow-hidden rounded-xl border border-border bg-card"
              >
                <div className="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-start">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <input
                      type="checkbox"
                      checked={groupAllSelected}
                      onChange={() => toggleGroupSelection(group)}
                      disabled={groupItemKeys.length === 0}
                      className="mt-1 rounded border-border"
                      aria-label={`选择项目 ${group.project.alias ?? group.project.shortName}`}
                    />
                    <button
                      onClick={() => toggleProjectExpanded(group.project.id)}
                      className="mt-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={expanded ? "收起分组" : "展开分组"}
                    >
                      {expanded ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-foreground truncate">
                          {group.project.alias ?? group.project.shortName}
                        </h2>
                        {group.invalidProject && (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500">
                            项目路径无效
                          </span>
                        )}
                        {group.invalidSessions.length > 0 && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            空会话 {group.invalidSessions.length}
                          </span>
                        )}
                        {groupSelectedCount > 0 && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                            已选 {groupSelectedCount}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-sm text-muted-foreground">
                        {group.project.displayPath}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>项目 ID: {group.project.id}</span>
                        <span>总会话数: {group.project.sessionCount}</span>
                        {group.project.lastModified && (
                          <span>最近更新: {formatDateTime(group.project.lastModified)}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pl-9 md:pl-0">
                    {group.invalidProject && (
                      canDeleteInvalidProjects ? (
                        <button
                          onClick={() =>
                            toggleItemSelection(getProjectKey(group.project.id))
                          }
                          className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                            selectedKeys.has(getProjectKey(group.project.id))
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border text-muted-foreground hover:bg-accent"
                          }`}
                        >
                          {selectedKeys.has(getProjectKey(group.project.id))
                            ? "取消选择项目"
                            : "选择项目"}
                        </button>
                      ) : (
                        <span className="text-xs px-2.5 py-1 rounded-md border border-border text-muted-foreground/70">
                          `codex` 下项目删除不可用
                        </span>
                      )
                    )}
                    <button
                      onClick={() =>
                        navigate(`/projects/${encodeURIComponent(group.project.id)}`)
                      }
                      className="text-xs px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    >
                      打开项目
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="border-t border-border bg-background/40">
                    {group.invalidProject && (
                      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-start">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          {canDeleteInvalidProjects ? (
                            <input
                              type="checkbox"
                              checked={selectedKeys.has(getProjectKey(group.project.id))}
                              onChange={() =>
                                toggleItemSelection(getProjectKey(group.project.id))
                              }
                              className="mt-1 rounded border-border"
                            />
                          ) : (
                            <span className="mt-1 h-4 w-4 rounded border border-border bg-muted/40" />
                          )}
                          <FolderX className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-foreground">
                                无效项目目录
                              </span>
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-500">
                                `pathExists === false`
                              </span>
                            </div>
                            <p className="mt-1 break-all text-xs text-muted-foreground">
                              {group.project.displayPath}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {canDeleteInvalidProjects
                                ? "删除后会移除该项目索引。当前页面默认使用项目删除接口的 `sessionOnly` 级别。"
                                : "`codex` 数据源当前不支持项目删除，无法在此页移除此项目索引。"}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="divide-y divide-border">
                      {group.invalidSessions.map((session) => {
                        const sessionKey = getSessionKey(group.project.id, session.filePath);
                        const sessionTitle = getSessionTitle(session);

                        return (
                          <label
                            key={session.filePath}
                            className="flex flex-col gap-3 px-4 py-3 cursor-pointer sm:flex-row sm:items-start"
                          >
                            <div className="flex items-start gap-3 flex-1 min-w-0">
                              <input
                                type="checkbox"
                                checked={selectedKeys.has(sessionKey)}
                                onChange={() => toggleItemSelection(sessionKey)}
                                className="mt-1 rounded border-border"
                              />
                              <FileX className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-medium text-foreground break-all">
                                    {sessionTitle}
                                  </span>
                                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                                    `messageCount === 0`
                                  </span>
                                  {session.alias && session.firstPrompt && (
                                    <span className="text-xs text-muted-foreground/70">
                                      原标题：{session.firstPrompt}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                                  <span>Session ID: {session.sessionId}</span>
                                  <span>消息数: {session.messageCount}</span>
                                  {session.modified && (
                                    <span>更新时间: {formatDateTime(session.modified)}</span>
                                  )}
                                </div>
                                <p className="mt-1 break-all text-xs text-muted-foreground/80">
                                  {session.filePath}
                                </p>
                              </div>
                            </div>
                            <div className="pl-7 sm:pl-0">
                              <button
                                onClick={(event) => {
                                  event.preventDefault();
                                  navigate(
                                    `/projects/${encodeURIComponent(
                                      group.project.id
                                    )}/session/${encodeURIComponent(session.filePath)}`
                                  );
                                }}
                                className="text-xs px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                              >
                                查看详情
                              </button>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {confirmDeleteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !deleting && setConfirmDeleteOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Trash2 className="w-5 h-5 text-destructive" />
              <h2 className="text-lg font-semibold text-foreground">确认删除已选项</h2>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              将删除 {selectedProjects.length} 个项目和 {selectedSessions.length} 个独立会话。
              已选项目下的空会话会随项目一起移除，不会重复调用会话删除接口。
            </p>
            <div className="mt-4 rounded-lg bg-muted/50 px-4 py-3 text-sm text-muted-foreground space-y-1">
              <div>
                项目删除：
                {canDeleteInvalidProjects
                  ? "默认使用 `sessionOnly` 级别"
                  : "`codex` 数据源不支持项目删除"}
              </div>
              <div>会话删除：桌面端会移入回收站，Web 端为永久删除</div>
              <div>当前环境：{__IS_TAURI__ ? "桌面端" : "Web 端"}</div>
              <div>此操作请确认后继续。</div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDeleteOpen(false)}
                disabled={deleting}
                className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => void handleDeleteSelected()}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
              >
                {deleting && <Loader2 className="w-4 h-4 animate-spin" />}
                {deleting ? "删除中..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
