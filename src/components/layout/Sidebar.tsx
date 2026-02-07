import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import {
  FolderOpen,
  Search,
  BarChart3,
  ChevronRight,
  MessageSquare,
} from "lucide-react";

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projects, loadProjects, projectsLoading } = useAppStore();

  useEffect(() => {
    loadProjects();
  }, []);

  const isActive = (path: string) => location.pathname === path;
  const isProjectActive = (encodedName: string) =>
    location.pathname.startsWith(`/projects/${encodedName}`);

  return (
    <aside className="w-64 h-full border-r border-border bg-card flex flex-col shrink-0">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary" />
          Claude Memory Viewer
        </h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-2">
        {/* Quick links */}
        <div className="mb-4">
          <button
            onClick={() => navigate("/search")}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
              isActive("/search")
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <Search className="w-4 h-4" />
            全局搜索
          </button>
          <button
            onClick={() => navigate("/stats")}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
              isActive("/stats")
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            使用统计
          </button>
        </div>

        {/* Projects list */}
        <div>
          <h2 className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            项目 ({projects.length})
          </h2>
          {projectsLoading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              加载中...
            </div>
          ) : (
            <div className="mt-1 space-y-0.5">
              {projects.map((project) => (
                <button
                  key={project.encodedName}
                  onClick={() =>
                    navigate(`/projects/${project.encodedName}`)
                  }
                  className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors group ${
                    isProjectActive(project.encodedName)
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                  title={project.displayPath}
                >
                  <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate flex-1 text-left">
                    {project.shortName}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {project.sessionCount}
                  </span>
                  <ChevronRight className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          )}
        </div>
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-border text-xs text-muted-foreground">
        {projects.length} 个项目
      </div>
    </aside>
  );
}
