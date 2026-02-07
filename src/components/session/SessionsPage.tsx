import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import {
  ArrowLeft,
  MessageSquare,
  Clock,
  GitBranch,
  Play,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { resumeSession } from "../../services/tauriApi";

export function SessionsPage() {
  const { encodedName } = useParams<{ encodedName: string }>();
  const navigate = useNavigate();
  const {
    sessions,
    sessionsLoading,
    selectProject,
    projects,
  } = useAppStore();

  const project = projects.find((p) => p.encodedName === encodedName);

  useEffect(() => {
    if (encodedName) {
      selectProject(encodedName);
    }
  }, [encodedName]);

  const handleResume = async (
    e: React.MouseEvent,
    sessionId: string,
    projectPath: string | null
  ) => {
    e.stopPropagation();
    if (!projectPath) return;
    try {
      await resumeSession(sessionId, projectPath);
    } catch (err) {
      console.error("Failed to resume session:", err);
    }
  };

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
            {project?.shortName || encodedName}
          </h1>
          {project && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {project.displayPath}
            </p>
          )}
        </div>
      </div>

      {/* Sessions list */}
      {sessionsLoading ? (
        <div className="text-muted-foreground">加载会话列表...</div>
      ) : sessions.length === 0 ? (
        <div className="text-muted-foreground">此项目没有会话记录。</div>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => (
            <div
              key={session.sessionId}
              onClick={() =>
                navigate(
                  `/projects/${encodedName}/${session.sessionId}`
                )
              }
              className="bg-card border border-border rounded-lg p-4 hover:border-primary/50 hover:bg-accent/30 transition-all cursor-pointer group"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground line-clamp-2">
                    {session.firstPrompt || "（无标题）"}
                  </p>
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
                  </div>
                </div>
                <button
                  onClick={(e) =>
                    handleResume(
                      e,
                      session.sessionId,
                      session.projectPath || project?.displayPath || null
                    )
                  }
                  className="shrink-0 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-primary/90 flex items-center gap-1"
                  title="在终端中恢复此会话"
                >
                  <Play className="w-3 h-3" />
                  Resume
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
