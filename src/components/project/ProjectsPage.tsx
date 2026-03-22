import { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import type { ProjectEntry } from "../../types";
import { FolderOpen, Clock, Hash, Tag, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";

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
  } = useAppStore();

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    project: ProjectEntry;
  } | null>(null);

  // 删除确认对话框状态
  const [deleteTarget, setDeleteTarget] = useState<ProjectEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

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
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, project });
              }}
              className="relative bg-card border border-border rounded-lg p-4 text-left hover:border-primary/50 hover:bg-accent/30 transition-all group cursor-pointer"
            >
              {/* Hover 删除图标（仅 claude source） */}
              {source === "claude" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(project);
                  }}
                  className="absolute top-2 right-2 p-1.5 rounded opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  title="删除工程"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <div className="flex items-start gap-3">
                <FolderOpen className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-foreground truncate">
                    {project.shortName}
                  </h3>
                  <p
                    className="text-xs text-muted-foreground truncate mt-1"
                    title={project.displayPath}
                  >
                    {project.displayPath}
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

    {/* 右键菜单（portal） */}
    {contextMenu && ReactDOM.createPortal(
      <ProjectContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        project={contextMenu.project}
        source={source}
        onClose={() => setContextMenu(null)}
        onDelete={(p) => {
          setContextMenu(null);
          setDeleteTarget(p);
        }}
      />,
      document.body
    )}

    {/* 删除确认对话框 */}
    {deleteTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg">
          <h3 className="text-lg font-semibold mb-2">确认删除工程</h3>
          <p className="text-sm text-muted-foreground mb-1">
            工程：<span className="font-medium text-foreground">{deleteTarget.shortName}</span>
          </p>
          <p className="text-xs text-muted-foreground mb-1 break-all">
            路径：{deleteTarget.displayPath}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            将永久删除 {deleteTarget.sessionCount} 个会话及所有相关数据，且无法恢复。
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
            >
              取消
            </button>
            <button
              onClick={async () => {
                setDeleting(true);
                try {
                  await deleteProject(deleteTarget.id);
                  navigate("/projects");
                } catch (err) {
                  console.error("Failed to delete project:", err);
                } finally {
                  setDeleting(false);
                  setDeleteTarget(null);
                }
              }}
              disabled={deleting}
              className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors flex items-center gap-1.5"
            >
              {deleting ? "删除中..." : "删除"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function ProjectContextMenu({
  x, y, project, source, onClose, onDelete,
}: {
  x: number;
  y: number;
  project: ProjectEntry;
  source: string;
  onClose: () => void;
  onDelete: (p: ProjectEntry) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // 避免菜单超出右侧/底部视口
  const menuWidth = 200;
  const menuHeight = 100;
  const left = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const top = y + menuHeight > window.innerHeight ? y - menuHeight : y;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[180px]"
      style={{ left, top }}
    >
      {/* 工程信息 */}
      <div className="px-3 py-2 border-b border-border">
        <p className="text-xs font-medium text-foreground">{project.shortName}</p>
        <p className="text-xs text-muted-foreground break-all mt-0.5">{project.displayPath}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{project.sessionCount} 个会话</p>
      </div>
      {/* 删除工程（仅 claude source） */}
      {source === "claude" && (
        <button
          onClick={() => onDelete(project)}
          className="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-2"
        >
          <Trash2 className="w-3.5 h-3.5" />
          删除工程
        </button>
      )}
    </div>
  );
}
