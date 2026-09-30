import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useState, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useTheme } from "../../hooks/useTheme";
import { useUpdateChecker } from "../../hooks/useUpdateChecker";
import { useBackgroundRefresh } from "../../hooks/useBackgroundRefresh";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { ProjectActionsMenu } from "../project/ProjectActionsMenu";
import { DeleteProjectDialog } from "../project/DeleteProjectDialog";
import { NodeSelector } from "./NodeSelector";
import { readRecentSessions, RECENT_SESSIONS_CHANGED } from "../../services/recentSessions";
import { SOURCE_OPTIONS, readHiddenSources, HIDDEN_SOURCES_CHANGED, type SessionSource } from "./sourceOptions";
import type { ProjectEntry } from "../../types";
import { collapseDirectBuckets, DIRECT_GROUP_ID } from "../../utils/directChat";
import {
  FolderOpen,
  FolderClock,
  Search,
  BarChart3,
  MoreHorizontal,
  Sun,
  Moon,
  Monitor,
  Settings,
  MessageSquarePlus,
  Trash2,
  Loader2,
  Star,
  FolderX,
  Repeat,
  Sparkles,
  ChevronDown,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { EscapeToClose } from "../common/EscapeToClose";

declare const __IS_TAURI__: boolean;
declare const __APP_VERSION__: string;

function SourceNavigation({
  source,
  loading,
  onChange,
  hiddenSources,
}: {
  source: SessionSource;
  loading: boolean;
  onChange: (source: SessionSource) => void;
  hiddenSources: SessionSource[];
}) {
  const { t } = useTranslation();
  const visible = SOURCE_OPTIONS.filter((option) => !hiddenSources.includes(option.id));
  const current = SOURCE_OPTIONS.find((option) => option.id === source);
  // One row of icons instead of a 36px row per source: the switcher used to
  // take ~160px of height before any navigation.
  return (
    <div>
      <div role="group" aria-label={t("会话来源")} className="flex gap-0.5 rounded-md bg-muted p-0.5">
        {visible.map((option) => {
          const Icon = option.icon;
          const selected = option.id === source;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              aria-label={option.label}
              title={option.label}
              onClick={() => onChange(option.id)}
              className={`flex h-8 flex-1 items-center justify-center rounded transition-colors ${
                selected ? "bg-background shadow-sm" : "opacity-60 hover:bg-background/60 hover:opacity-100"
              }`}
            >
              <Icon className={"h-4 w-4 shrink-0 " + option.iconClass} />
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{current?.label ?? source}</span>
        {loading && <Loader2 aria-label={t("正在加载项目")} className="h-3 w-3 animate-spin" />}
      </div>
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { source, setSource, projects, loadProjects, projectsLoading, bookmarks, loadBookmarks, deleteProject, setProjectAlias, recycledItems } = useAppStore(
    useShallow((state) => ({ source: state.source, setSource: state.setSource, projects: state.projects, loadProjects: state.loadProjects, projectsLoading: state.projectsLoading, bookmarks: state.bookmarks, loadBookmarks: state.loadBookmarks, deleteProject: state.deleteProject, setProjectAlias: state.setProjectAlias, recycledItems: state.recycledItems })),
  );
  const { theme, setTheme } = useTheme();
  const { detectCli, availableClis, clearChat } = useChatStore(
    useShallow((state) => ({ detectCli: state.detectCli, availableClis: state.availableClis, clearChat: state.clearChat })),
  );
  const [projectQuery, setProjectQuery] = useState("");
  const [hiddenSources, setHiddenSources] = useState<SessionSource[]>(readHiddenSources);
  useEffect(() => {
    const update = () => setHiddenSources(readHiddenSources());
    window.addEventListener(HIDDEN_SOURCES_CHANGED, update);
    return () => window.removeEventListener(HIDDEN_SOURCES_CHANGED, update);
  }, []);
  useEffect(() => {
    if (hiddenSources.includes(source)) {
      const next = SOURCE_OPTIONS.find((option) => !hiddenSources.includes(option.id));
      if (next) { setSource(next.id); navigate("/projects"); }
    }
  }, [hiddenSources, source, setSource, navigate]);
  const [recentSessions, setRecentSessions] = useState(readRecentSessions);
  useEffect(() => {
    const update = () => setRecentSessions(readRecentSessions());
    window.addEventListener(RECENT_SESSIONS_CHANGED, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(RECENT_SESSIONS_CHANGED, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  const [projectActionsMenu, setProjectActionsMenu] = useState<{
    project: ProjectEntry;
    anchorRect: DOMRect;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameLoading, setRenameLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectEntry | null>(null);
  useUpdateChecker();
  useBackgroundRefresh();
  useFileWatcher();

  useEffect(() => {
    loadProjects();
    loadBookmarks();
  }, [source]);

  useEffect(() => {
    // CLI detection only matters once the user opens a chat/session; defer it
    // off the startup burst so it doesn't compete with the first project load.
    if (availableClis.length > 0) return;
    const t = setTimeout(() => {
      if (useChatStore.getState().availableClis.length === 0) {
        detectCli();
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const isActive = (path: string) => location.pathname === path;
  const isProjectActive = (projectId: string) =>
    location.pathname.startsWith(`/projects/${encodeURIComponent(projectId)}`);

  // Collapse Codex direct-chat date buckets into one pinned "直连对话" entry,
  // mirroring the main projects grid.
  const sidebarProjects = useMemo(() => collapseDirectBuckets(projects), [projects, t]);
  // The full, manageable list lives on /projects. The sidebar shows the most
  // recently active few (the pinned direct-chat group always stays), or every
  // match while filtering.
  const SIDEBAR_PROJECT_LIMIT = 8;
  const { visibleSidebarProjects, hiddenProjectCount } = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    if (query) {
      const matches = sidebarProjects.filter((project) =>
        [project.alias, project.shortName, project.displayPath].some((value) => value?.toLowerCase().includes(query)),
      );
      return { visibleSidebarProjects: matches, hiddenProjectCount: 0 };
    }
    const pinned = sidebarProjects.filter((project) => project.id === DIRECT_GROUP_ID);
    const rest = sidebarProjects
      .filter((project) => project.id !== DIRECT_GROUP_ID)
      .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
    const shown = rest.slice(0, SIDEBAR_PROJECT_LIMIT);
    return { visibleSidebarProjects: [...pinned, ...shown], hiddenProjectCount: rest.length - shown.length };
  }, [sidebarProjects, projectQuery]);
  // The aggregate entry and the date-list page are "active" together; so is any
  // drill-down into a `<codex-direct>/DATE` bucket's session list.
  const isDirectGroupActive =
    location.pathname === "/direct-chat" ||
    location.pathname.startsWith(`/projects/${encodeURIComponent("<codex-direct>/")}`);

  const handleSourceChange = (s: SessionSource) => {
    if (s === source) return;
    setSource(s);
    // Pages that exist for every source keep their place; anything tied to a
    // project/session of the old source goes back to the project list.
    const path = location.pathname;
    const keep =
      ["/search", "/bookmarks", "/settings", "/skills", "/cleanup", "/recyclebin"].includes(path) ||
      ((path === "/stats" || path === "/stats/requests") && (s === "claude" || s === "codex")) ||
      (path === "/provider-sync" && s === "codex");
    if (!keep) navigate("/projects");
  };

  return (
    <aside className="w-60 h-full border-r border-border bg-secondary/40 flex flex-col shrink-0">
      {/* Header */}
      <div className="px-3 pb-3 pt-4">
        <h1 className="mb-4 px-1 text-sm font-semibold tracking-tight text-foreground">
          AI Session Viewer
        </h1>
        <SourceNavigation
          source={source}
          loading={projectsLoading}
          onChange={handleSourceChange}
          hiddenSources={hiddenSources}
        />
        <div className="mt-3 min-w-0 border-t border-border pt-3">
          <NodeSelector />
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-2">
        <div className="mb-4 space-y-1">
          {(source === "claude" || source === "codex") && <button onClick={() => { clearChat(); navigate("/chat"); }} className="mb-3 flex w-full items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"><MessageSquarePlus className="h-4 w-4" />{t("新建对话")}</button>}
          {[
            { path: "/projects", label: t("所有项目"), icon: FolderOpen },
            { path: "/search", label: t("搜索会话"), icon: Search },
            { path: "/bookmarks", label: t("收藏"), icon: Star },
            ...(source === "claude" || source === "codex" ? [{ path: "/stats", label: t("使用统计"), icon: BarChart3 }] : []),
          ].map(({ path, label, icon: Icon }) => (
            <button key={path} onClick={() => navigate(path)} aria-current={isActive(path) ? "page" : undefined} className={"navigation-link " + (isActive(path) ? "is-active" : "")}><Icon className="h-4 w-4" />{label}{path === "/bookmarks" && <span className="ml-auto text-xs tabular-nums">{bookmarks.filter((b) => b.source === source).length || ""}</span>}</button>
          ))}
        </div>

        {/* Projects list */}
        {recentSessions.some((item) => item.source === source) && (
          <div className="mb-4">
            <h2 className="px-3 py-1 text-[11px] font-medium text-muted-foreground">{t("最近浏览")}</h2>
            {recentSessions.filter((item) => item.source === source).slice(0, 5).map((item) => (
              <button key={item.filePath} className="navigation-link" title={item.title} onClick={() => navigate(`/projects/${encodeURIComponent(item.projectId)}/session/${encodeURIComponent(item.filePath)}`)}>
                <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" /><span className="truncate">{item.title}</span>
              </button>
            ))}
          </div>
        )}
        <div>
          <h2 className="px-3 py-1 text-[11px] font-medium text-muted-foreground">
            {t("最近项目")}
          </h2>
          <input aria-label={t("筛选项目")} value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder={t("查找项目…")} className="mx-2 my-2 w-[calc(100%-1rem)] rounded-md border border-border/70 bg-card px-2.5 py-1.5 text-xs placeholder:text-muted-foreground" />
          {projectsLoading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {t("加载中...")}</div>
          ) : (
            <div className="mt-1 space-y-0.5">
              {visibleSidebarProjects.map((project) => {
                const isGroup = project.id === DIRECT_GROUP_ID;
                const active = isGroup
                  ? isDirectGroupActive
                  : isProjectActive(project.id);
                return (
                <div
                  key={project.id}
                  className={`relative flex items-center rounded-md text-sm transition-colors group ${
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                >
                  <button
                    onClick={() =>
                      navigate(
                        isGroup
                          ? "/direct-chat"
                          : `/projects/${encodeURIComponent(project.id)}`
                      )
                    }
                    className="flex-1 flex items-center gap-2 px-3 py-1.5 min-w-0"
                    title={
                      project.isVirtual
                        ? t("{{v0}}（按日期归类的虚拟项目）", { v0: project.displayPath })
                        : project.displayPath + (project.pathExists === false ? t(" (路径不存在)") : "")
                    }
                  >
                    {project.isVirtual ? (
                      <FolderClock className="w-3.5 h-3.5 shrink-0 text-muted-foreground/70" />
                    ) : (
                      <FolderOpen className={`w-3.5 h-3.5 shrink-0${project.pathExists === false ? " text-warning" : ""}`} />
                    )}
                    <span className="truncate flex-1 text-left">
                      {project.alias ?? project.shortName}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {project.sessionCount}
                    </span>
                  </button>
                  {!isGroup && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setProjectActionsMenu({
                          project,
                          anchorRect: e.currentTarget.getBoundingClientRect(),
                        });
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 mr-1 rounded text-muted-foreground hover:bg-accent/50 shrink-0"
                      title={t("操作")}
                    >
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                );
              })}
              {hiddenProjectCount > 0 && (
                <button onClick={() => navigate("/projects")} className="navigation-link text-xs">
                  {t("全部项目（另有 {{v0}} 个）→", { v0: hiddenProjectCount })}
                </button>
              )}
            </div>
          )}
        </div>
      </nav>

      <details key={location.pathname} open={["/skills", "/cleanup", "/recyclebin", "/provider-sync"].includes(location.pathname)} className="mx-2 mb-2 border-t border-border pt-2">
        <summary className="navigation-link cursor-pointer list-none"><Settings className="h-4 w-4" />{t("工具与管理")}<ChevronDown className="ml-auto h-3.5 w-3.5" /></summary>
        <div className="mt-1 space-y-0.5 pl-2">
          {[
            { path: "/skills", label: "Skills", icon: Sparkles },
            { path: "/cleanup", label: t("无效项管理"), icon: FolderX },
            { path: "/recyclebin", label: recycledItems.length ? t("回收站 · ") + recycledItems.length : t("回收站"), icon: Trash2 },
            ...(source === "codex" ? [{ path: "/provider-sync", label: t("Provider 同步"), icon: Repeat }] : []),
          ].map(({ path, label, icon: Icon }) => <button key={path} onClick={() => navigate(path)} aria-current={isActive(path) ? "page" : undefined} className={"navigation-link " + (isActive(path) ? "is-active" : "")}><Icon className="h-3.5 w-3.5" />{label}</button>)}
        </div>
      </details>

      {/* Footer */}
      <div className="p-3 border-t border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              v{__APP_VERSION__}
            </span>
            <button
              onClick={() => navigate("/settings")}
              aria-current={isActive("/settings") ? "page" : undefined}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors ${
                isActive("/settings") ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              <Settings className="w-3.5 h-3.5" />
              {t("设置")}
            </button>
          </div>
          <div className="flex rounded-md bg-muted p-0.5">
            <button
              onClick={() => setTheme("light")}
              className={`p-1 rounded transition-colors ${
                theme === "light" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
              title={t("亮色模式")}
            >
              <Sun className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setTheme("system")}
              className={`p-1 rounded transition-colors ${
                theme === "system" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
              title={t("跟随系统")}
            >
              <Monitor className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setTheme("dark")}
              className={`p-1 rounded transition-colors ${
                theme === "dark" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
              title={t("暗色模式")}
            >
              <Moon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ⋯ 菜单 portal */}
      {projectActionsMenu && (
        <ProjectActionsMenu
          project={projectActionsMenu.project}
          source={source}
          anchorRect={projectActionsMenu.anchorRect}
          onClose={() => setProjectActionsMenu(null)}
          onRename={(p) => {
            setRenameTarget(p);
            setRenameValue(p.alias ?? "");
            setRenameError(null);
          }}
          onDelete={(p) => { setDeleteTarget(p); }}
        />
      )}

      {/* 重命名 Modal */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
          <EscapeToClose onClose={() => { setRenameTarget(null); setRenameError(null); }} disabled={renameLoading} />
          <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg">
            <h3 className="text-lg font-semibold mb-1">{t("设置工程别名")}</h3>
            <p className="text-xs text-muted-foreground mb-3">
              {t("别名仅影响显示名称，不修改磁盘目录")}</p>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder={renameTarget.shortName}
              autoFocus
              className="w-full bg-muted border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              onKeyDown={(e) => {
                if (e.key === "Escape") { setRenameTarget(null); setRenameError(null); }
              }}
            />
            {renameError && (
              <p className="text-xs text-destructive mt-1">{renameError}</p>
            )}
            <div className="flex justify-between items-center mt-4">
              <div>
                {renameTarget.alias && (
                  <button
                    onClick={async () => {
                      setRenameLoading(true);
                      try {
                        await setProjectAlias(renameTarget.id, null);
                        setRenameTarget(null);
                        setRenameError(null);
                      } catch (e) {
                        setRenameError(e instanceof Error ? e.message : String(e));
                      } finally {
                        setRenameLoading(false);
                      }
                    }}
                    disabled={renameLoading}
                    className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t("清除别名")}</button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setRenameTarget(null); setRenameError(null); }}
                  disabled={renameLoading}
                  className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
                >
                  {t("取消")}</button>
                <button
                  onClick={async () => {
                    setRenameLoading(true);
                    setRenameError(null);
                    try {
                      await setProjectAlias(renameTarget.id, renameValue.trim() || null);
                      setRenameTarget(null);
                    } catch (e) {
                      setRenameError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setRenameLoading(false);
                    }
                  }}
                  disabled={renameLoading}
                  className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  {renameLoading ? t("保存中...") : t("确认")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 Modal */}
      {deleteTarget && (
        <DeleteProjectDialog
          project={deleteTarget}
          source={source}
          onConfirm={async (level) => {
            await deleteProject(deleteTarget.id, level);
            setDeleteTarget(null);
            navigate("/projects");
          }}
          onCancel={() => { setDeleteTarget(null); }}
        />
      )}
    </aside>
  );
}
