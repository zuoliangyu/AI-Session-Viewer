import { t, getDateLocale } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { ArrowLeft, FolderClock, Clock, Hash } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import { isDirectBucket, directBucketDate } from "../../utils/directChat";

/**
 * Middle layer of the Codex "直连对话" drill-down: 直连对话总入口 → (this page)
 * 按日期归档 → 会话列表. Lists the `<codex-direct>/DATE` buckets; each card
 * routes to the existing session list for that bucket.
 */
export function DirectChatDatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { source, projects, loadProjects, projectsLoading } = useAppStore();

  useEffect(() => {
    if (projects.length === 0) loadProjects();
  }, [source]);

  const buckets = useMemo(() => {
    return projects
      .filter(isDirectBucket)
      .slice()
      .sort((a, b) => (directBucketDate(b) || "").localeCompare(directBucketDate(a) || ""));
  }, [projects]);

  const lastModifiedMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of buckets) {
      if (p.lastModified) {
        m.set(p.id, formatDistanceToNow(new Date(p.lastModified), { addSuffix: true, locale: getDateLocale() }));
      }
    }
    return m;
  }, [buckets, t]);

  return (
    <div className="flex flex-col h-full">
      <div className="workspace-list-header">
        <button
          onClick={() => navigate("/projects")}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          {t("所有项目")}</button>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <FolderClock className="w-6 h-6 text-muted-foreground" />
          <h1 className="workspace-page-title">{t("Codex 直连对话")}</h1>
          <span className="text-sm text-muted-foreground">{t("（按日期归档）")}</span>
        </div>
      </div>

      <div className="workspace-list-body">
        {projectsLoading && buckets.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t("加载中...")}</div>
        ) : buckets.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            {t("没有 Codex 直连对话。Codex Desktop 的「直接对话」会归到这里。")}</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {buckets.map((bucket) => {
              const date = directBucketDate(bucket);
              return (
                <div
                  key={bucket.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/projects/${encodeURIComponent(bucket.id)}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      navigate(`/projects/${encodeURIComponent(bucket.id)}`);
                    }
                  }}
                  className="relative bg-card border border-border rounded-lg p-4 text-left hover:border-primary/50 hover:bg-accent/30 transition-all cursor-pointer"
                >
                  <div className="flex items-start gap-3">
                    <FolderClock className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <h3 className="font-medium text-foreground truncate">{date}</h3>
                      <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Hash className="w-3 h-3" />
                          {bucket.sessionCount} {t("个会话")}</span>
                        {bucket.lastModified && (
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {lastModifiedMap.get(bucket.id)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
