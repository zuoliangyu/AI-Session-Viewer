import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
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

/** 流式扫描进度。total 在 getProjects 返回后立刻设；completed 每个项目扫完 +1；
 *  failed 单独累计。done = completed >= total */
type ScanProgress = {
  total: number;
  completed: number;
  failed: number;
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

/** 比较两个 group 的排序优先级。无效项目优先，然后会话数多的优先，然后名字。 */
function compareGroups(a: CleanupGroup, b: CleanupGroup): number {
  const aScore = Number(a.invalidProject) * 1000 + a.invalidSessions.length;
  const bScore = Number(b.invalidProject) * 1000 + b.invalidSessions.length;
  if (aScore !== bScore) return bScore - aScore;
  return (a.project.alias ?? a.project.shortName).localeCompare(
    b.project.alias ?? b.project.shortName,
    "zh-CN",
  );
}

export function InvalidItemsPage() {
  const navigate = useNavigate();
  const { source, loadProjects } = useAppStore();
  const [groups, setGroups] = useState<CleanupGroup[]>([]);
  /** 仅在拉取项目列表那一刻为 true；扫描阶段不再阻塞 UI，进度由 scanProgress 反映。 */
  const [bootstrapping, setBootstrapping] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress>({
    total: 0,
    completed: 0,
    failed: 0,
  });
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** 每次 reload 自增；in-flight 的请求结果只在 epoch 没变时才落盘。 */
  const reloadEpochRef = useRef(0);
  const canDeleteInvalidProjects = source !== "codex";
  const sessionDeleteHint = __IS_TAURI__
    ? "当前为桌面端，会话删除会移入回收站。"
    : "当前为 Web 端，会话删除为永久删除。";
  const scanInProgress =
    scanProgress.total > 0 && scanProgress.completed < scanProgress.total;
  const scanWarning =
    !scanInProgress && scanProgress.failed > 0
      ? `有 ${scanProgress.failed} / ${scanProgress.total} 个项目读取会话失败，当前结果不完整，仅展示已成功扫描的项目。`
      : null;

  /**
   * 流式重扫：项目列表拿到就立刻渲染"已知坏项目"骨架，避免白屏；
   * 之后并发扫每个项目的 invalid sessions，每完成一个就更新对应行。
   * 用户能立即和"已扫完"的项目交互，不用等到全部 95 个项目都扫完。
   */
  const reload = async (showRefreshing = false) => {
    const epoch = ++reloadEpochRef.current;
    if (showRefreshing) {
      setRefreshing(true);
    } else {
      setBootstrapping(true);
    }
    setLoadError(null);
    setActionError(null);
    setScanProgress({ total: 0, completed: 0, failed: 0 });
    // 重扫时直接清掉旧选择；in-flight 选项的 file path 可能已经失效。
    setSelectedKeys(new Set());

    let projects: ProjectEntry[];
    try {
      projects = await api.getProjects(source);
    } catch (error) {
      if (reloadEpochRef.current !== epoch) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setGroups([]);
      setBootstrapping(false);
      setRefreshing(false);
      return;
    }

    if (reloadEpochRef.current !== epoch) return;

    // 先把"路径不存在"的项目立刻渲染出来（无需扫描就知道无效）；
    // 其他项目此时还不知道结果，先不渲染，等扫描完成再 push。
    // 虚拟项目（codex 无 cwd 会话桶）不算无效，跳过这条 fast path——它们
    // 只在内部确有 invalid session 时才会被下面的扫描结果带进来。
    const initialGroups: CleanupGroup[] = projects
      .filter((p) => p.pathExists === false && !p.isVirtual)
      .map((p) => ({
        project: p,
        invalidProject: true,
        invalidSessions: [],
      }))
      .sort(compareGroups);
    setGroups(initialGroups);
    setExpandedProjectIds(
      new Set(initialGroups.map((g) => g.project.id)),
    );
    setBootstrapping(false);
    setRefreshing(false);
    setScanProgress({ total: projects.length, completed: 0, failed: 0 });

    // 并发扫描，每完成一个就更新对应 group 的 slot；
    // 仅当结果有 invalid session（或本来就是无效项目）才在列表里保留这条。
    await mapWithConcurrencyLimit(projects, 4, async (project) => {
      let invalidSessions: SessionIndexEntry[] = [];
      let scanFailed = false;
      try {
        invalidSessions = await api.getInvalidSessions(source, project.id);
      } catch (e) {
        scanFailed = true;
        console.error(
          `Failed to load invalid sessions for ${project.id}:`,
          e,
        );
      }
      if (reloadEpochRef.current !== epoch) return;

      // 虚拟项目本身不算"无效项目"，pathExists 对它无意义
      const projectIsInvalid = project.pathExists === false && !project.isVirtual;
      const hasIssue = projectIsInvalid || invalidSessions.length > 0;
      const isNewGroup =
        hasIssue && !projectIsInvalid; // 已经在 initialGroups 里的，不再算新

      setGroups((prev) => {
        const existingIdx = prev.findIndex((g) => g.project.id === project.id);
        if (!hasIssue) {
          if (existingIdx === -1) return prev;
          return prev.filter((g) => g.project.id !== project.id);
        }
        const next: CleanupGroup = {
          project,
          invalidProject: projectIsInvalid,
          invalidSessions,
        };
        if (existingIdx >= 0) {
          const replaced = [...prev];
          replaced[existingIdx] = next;
          return replaced.sort(compareGroups);
        }
        return [...prev, next].sort(compareGroups);
      });

      // 新发现的有问题项目默认展开，方便用户看到内容
      if (isNewGroup) {
        setExpandedProjectIds((prev) => {
          if (prev.has(project.id)) return prev;
          const next = new Set(prev);
          next.add(project.id);
          return next;
        });
      }

      setScanProgress((prev) => ({
        total: prev.total,
        completed: prev.completed + 1,
        failed: prev.failed + (scanFailed ? 1 : 0),
      }));
    });
  };

  useEffect(() => {
    void loadProjects();
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const summary = useMemo(() => {
    const invalidProjectCount = groups.filter((group) => group.invalidProject).length;
    // Split by status. Missing `status` (older backend response) is treated
    // as `empty` since that was the only flavour `getInvalidSessions` returned
    // before this feature shipped.
    const emptySessionCount = groups.reduce(
      (count, group) =>
        count +
        group.invalidSessions.filter(
          (s) => (s.status ?? "empty") === "empty",
        ).length,
      0,
    );
    const corruptSessionCount = groups.reduce(
      (count, group) =>
        count +
        group.invalidSessions.filter((s) => s.status === "corrupt").length,
      0,
    );

    return {
      invalidProjectCount,
      emptySessionCount,
      corruptSessionCount,
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
            按项目分组查看异常数据。当前规则：无效项目 = 路径不存在；无效会话 = 消息数为 0
            或文件中部 JSONL 解析失败（损坏）。损坏会话仍可"查看详情"，坏行会被静默跳过。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void reload(true)}
            disabled={bootstrapping || refreshing || scanInProgress || deleting}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors disabled:opacity-50"
          >
            <RefreshCw
              className={`w-4 h-4 ${refreshing || scanInProgress ? "animate-spin" : ""}`}
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">涉及项目</div>
          <div className="mt-1 text-2xl font-semibold text-foreground">
            {summary.groupCount}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            含无效项目、空或损坏会话的分组
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
          <div className="text-xs text-muted-foreground">空会话</div>
          <div className="mt-1 text-2xl font-semibold text-foreground">
            {summary.emptySessionCount}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            `messageCount === 0`
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">损坏会话</div>
          <div className="mt-1 text-2xl font-semibold text-amber-500">
            {summary.corruptSessionCount}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            JSONL 中部解析失败
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

      {/* 流式扫描进度条：项目列表先到，扫描每完成一个 +1，
          完成的项目立即出现在下面的 groups 列表里可交互。 */}
      {scanInProgress && (
        <div className="rounded-lg border border-border bg-card/60 px-4 py-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 text-muted-foreground min-w-0">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span className="truncate">
                正在扫描会话异常项（{scanProgress.completed} /{" "}
                {scanProgress.total}）{scanProgress.failed > 0 && (
                  <span className="text-amber-500 ml-1">
                    · {scanProgress.failed} 个失败
                  </span>
                )}
              </span>
            </span>
            <span className="text-xs text-muted-foreground shrink-0">
              已发现 {groups.length} 个问题项目
            </span>
          </div>
          <div className="mt-2 h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: `${(scanProgress.completed / scanProgress.total) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {bootstrapping ? (
        <div className="rounded-xl border border-border bg-card px-6 py-16 text-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground mx-auto" />
          <p className="mt-3 text-sm text-muted-foreground">正在加载项目列表...</p>
        </div>
      ) : loadError ? (
        <div className="rounded-xl border border-dashed border-red-500/30 bg-red-500/5 px-6 py-16 text-center">
          <AlertCircle className="w-12 h-12 text-red-400/70 mx-auto" />
          <h2 className="mt-4 text-lg font-medium text-foreground">扫描失败</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            当前无法完成无效项扫描，因此还不能判断是否存在无效项目、空会话或损坏会话。
          </p>
        </div>
      ) : groups.length === 0 && !scanInProgress ? (
        <div className="rounded-xl border border-dashed border-border bg-card/60 px-6 py-16 text-center">
          <FolderOpen className="w-12 h-12 text-muted-foreground/30 mx-auto" />
          <h2 className="mt-4 text-lg font-medium text-foreground">
            {scanProgress.failed > 0 ? "扫描部分失败" : "暂未发现无效项"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {scanProgress.failed > 0
              ? "本次扫描中有项目读取失败，当前没有发现可确认的无效项，但这不代表数据源中一定不存在无效项。"
              : "当前数据源下没有路径失效的项目，没有空会话，也没有损坏会话。"}
          </p>
          {scanProgress.failed > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              请稍后刷新重试，或先处理导致会话扫描失败的项目。
            </p>
          )}
        </div>
      ) : groups.length === 0 ? null : (
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
                        {(() => {
                          const empty = group.invalidSessions.filter(
                            (s) => (s.status ?? "empty") === "empty",
                          ).length;
                          const corrupt = group.invalidSessions.filter(
                            (s) => s.status === "corrupt",
                          ).length;
                          return (
                            <>
                              {empty > 0 && (
                                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                  空会话 {empty}
                                </span>
                              )}
                              {corrupt > 0 && (
                                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500">
                                  损坏会话 {corrupt}
                                </span>
                              )}
                            </>
                          );
                        })()}
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
                        const isCorrupt = session.status === "corrupt";

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
                              {isCorrupt ? (
                                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                              ) : (
                                <FileX className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-medium text-foreground break-all">
                                    {sessionTitle}
                                  </span>
                                  {isCorrupt ? (
                                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-500">
                                      文件损坏，部分可读
                                    </span>
                                  ) : (
                                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                                      `messageCount === 0`
                                    </span>
                                  )}
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
                                {isCorrupt && (
                                  <p className="mt-1 text-xs text-amber-500/80">
                                    JSONL 中部出现解析失败的行（常见于 CC 异常退出留下的稀疏空洞）。
                                    "查看详情"会跳过坏行展示残存内容。
                                  </p>
                                )}
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
              已选项目下的空/损坏会话会随项目一起移除，不会重复调用会话删除接口。
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
