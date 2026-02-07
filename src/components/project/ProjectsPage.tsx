import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { FolderOpen, Clock, Hash } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";

export function ProjectsPage() {
  const navigate = useNavigate();
  const { source, projects, loadProjects, projectsLoading } = useAppStore();

  useEffect(() => {
    loadProjects();
  }, [source]);

  const emptyText =
    source === "claude"
      ? "未找到任何 Claude 项目。请确认 ~/.claude/projects/ 目录存在。"
      : "未找到任何 Codex 项目。请确认 ~/.codex/sessions/ 目录存在。";

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">所有项目</h1>

      {projectsLoading ? (
        <div className="text-muted-foreground">加载项目列表...</div>
      ) : projects.length === 0 ? (
        <div className="text-muted-foreground">{emptyText}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() =>
                navigate(
                  `/projects/${encodeURIComponent(project.id)}`
                )
              }
              className="bg-card border border-border rounded-lg p-4 text-left hover:border-primary/50 hover:bg-accent/30 transition-all group"
            >
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
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
