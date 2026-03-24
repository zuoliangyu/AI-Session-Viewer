import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import type { ProjectEntry } from "../../types";
import { FolderOpen, Clock, Hash, Tag, MoreHorizontal, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import { ProjectActionsMenu } from "./ProjectActionsMenu";
import { DeleteProjectDialog } from "./DeleteProjectDialog";

export function ProjectsPage() {
  const navigate = useNavigate();
  const {
    source,
    projects,
    loadProjects,
    projectsLoading,
    crossProjectTags,
    globalTagFilter,
    loadCrossProjectTags,
    setGlobalTagFilter,
    deleteProject,
    setProjectAlias,
  } = useAppStore();

  // ⋯ 操作菜单状态
  const [actionsMenu, setActionsMenu] = useState<{
    project: ProjectEntry;
    anchorRect: DOMRect;
  } | null>(null);

  // 删除确认对话框状态
  const [deleteTarget, setDeleteTarget] = useState<ProjectEntry | null>(null);

  // 重命名（别名）对话框状态
  const [renameTarget, setRenameTarget] = useState<ProjectEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameLoading, setRenameLoading] = useState(false);

  useEffect(() => {
    loadProjects();
    loadCrossProjectTags();
  }, [source]);

  // Deduplicated sorted list of all tags across projects
  const allGlobalTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const tags of Object.values(crossProjectTags)) {
      for (const tag of tags) {
        tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort();
  }, [crossProjectTags]);

  const toggleGlobalTag = (tag: string) => {
    if (globalTagFilter.includes(tag)) {
      setGlobalTagFilter(globalTagFilter.filter((t) => t !== tag));
    } else {
      setGlobalTagFilter([...globalTagFilter, tag]);
    }
  };

  // Filter projects by global tag filter
  const filteredProjects =
    globalTagFilter.length > 0
      ? projects.filter((p) => {
          const projectTags = crossProjectTags[p.id] || [];
          return globalTagFilter.every((t) => projectTags.includes(t));
        })
      : projects;

  const emptyText =
    source === "claude"
      ? "未找到任何 Claude 项目。请确认 ~/.claude/projects/ 目录存在。"
      : "未找到任何 Codex 项目。请确认 ~/.codex/sessions/ 目录存在。";

  return (
    <>
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">所有项目</h1>

      {/* Global tag filter bar */}
      {allGlobalTags.length > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <Tag className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          {allGlobalTags.map((tag) => (
            <button
              key={tag}
              onClick={() => toggleGlobalTag(tag)}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                globalTagFilter.includes(tag)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/50 text-muted-foreground border-border hover:border-primary/50"
              }`}
            >
              {tag}
            </button>
          ))}
          {globalTagFilter.length > 0 && (
            <button
              onClick={() => setGlobalTagFilter([])}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              清除筛选
            </button>
          )}
        </div>
      )}

      {projectsLoading ? (
        <div className="text-muted-foreground">加载项目列表...</div>
      ) : filteredProjects.length === 0 ? (
        <div className="text-muted-foreground">
          {globalTagFilter.length > 0
            ? "没有匹配筛选条件的项目。"
            : emptyText}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map((project) => (
            <div
              key={project.id}
              role="button"
              tabIndex={0}
              onClick={() =>
                navigate(
                  `/projects/${encodeURIComponent(project.id)}`
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  navigate(`/projects/${encodeURIComponent(project.id)}`);
                }
              }}
              className="relative bg-card border border-border rounded-lg p-4 text-left hover:border-primary/50 hover:bg-accent/30 transition-all group cursor-pointer"
            >
              {/* ⋯ 操作按钮（所有数据源均显示） */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setActionsMenu({ project, anchorRect: e.currentTarget.getBoundingClientRect() });
                }}
                className="absolute top-2 right-2 p-1.5 rounded opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:bg-accent/50"
                title="操作"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
              <div className="flex items-start gap-3">
                <FolderOpen className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-foreground truncate">
                    {project.alias ?? project.shortName}
                  </h3>
                  {project.alias && (
                    <p className="text-[10px] text-muted-foreground/60 truncate">
                      {project.shortName}
                    </p>
                  )}
                  <p
                    className={`text-xs truncate mt-1 ${project.pathExists === false ? "text-yellow-500" : "text-muted-foreground"}`}
                    title={project.displayPath + (project.pathExists === false ? " (路径不存在，解码可能不准确)" : "")}
                  >
                    {project.displayPath}
                    {project.pathExists === false && (
                      <AlertCircle className="w-3 h-3 inline ml-1 -mt-0.5" />
                    )}
                  </p>
                  {/* Project tags */}
                  {crossProjectTags[project.id] && crossProjectTags[project.id].length > 0 && (
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                      {crossProjectTags[project.id].map((tag) => (
                        <span
                          key={tag}
                          className="inline-block px-2 py-0.5 text-xs rounded-full bg-primary/15 text-primary"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Hash className="w-3 h-3" />
                      {project.sessionCount} 个会话
                    </span>
                    {project.lastModified && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDistanceToNow(
                          new Date(project.lastModified),
                          { addSuffix: true, locale: zhCN }
                        )}
                      </span>
                    )}
                  </div>
                  {project.modelProvider && (
                    <span className="mt-2 inline-block text-xs px-2 py-0.5 bg-muted rounded">
                      {project.modelProvider}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>

    {/* ⋯ 操作菜单（portal） */}
    {actionsMenu && (
      <ProjectActionsMenu
        project={actionsMenu.project}
        source={source}
        anchorRect={actionsMenu.anchorRect}
        onClose={() => setActionsMenu(null)}
        onRename={(p) => {
          setRenameTarget(p);
          setRenameValue(p.alias ?? "");
          setRenameError(null);
        }}
        onDelete={(p) => { setDeleteTarget(p); }}
      />
    )}

    {/* 删除确认对话框 */}
    {deleteTarget && (
      <DeleteProjectDialog
        project={deleteTarget}
        onConfirm={async (level) => {
          await deleteProject(deleteTarget.id, level);
          setDeleteTarget(null);
          navigate("/projects");
        }}
        onCancel={() => { setDeleteTarget(null); }}
      />
    )}

    {/* 别名重命名对话框 */}
    {renameTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg">
          <h3 className="text-lg font-semibold mb-1">设置工程别名</h3>
          <p className="text-xs text-muted-foreground mb-3">
            别名仅影响显示名称，不修改磁盘目录
          </p>
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder={renameTarget.shortName}
            autoFocus
            className="w-full bg-muted border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setRenameTarget(null);
                setRenameError(null);
              }
            }}
          />
          {renameError && (
            <p className="text-xs text-red-400 mt-1">{renameError}</p>
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
                  清除别名
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setRenameTarget(null); setRenameError(null); }}
                disabled={renameLoading}
                className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
              >
                取消
              </button>
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
                {renameLoading ? "保存中..." : "确认"}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
