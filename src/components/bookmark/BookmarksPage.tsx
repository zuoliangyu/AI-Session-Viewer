import { t, getDateLocale } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { Star, Trash2, MessageSquare, FolderOpen } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useShallow } from "zustand/react/shallow";
import { EmptyState, LoadingState } from "../common/StateViews";


export function BookmarksPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { bookmarks, bookmarksLoading, loadBookmarks, removeBookmark, source } = useAppStore(
    useShallow((state) => ({ bookmarks: state.bookmarks, bookmarksLoading: state.bookmarksLoading, loadBookmarks: state.loadBookmarks, removeBookmark: state.removeBookmark, source: state.source })),
  );

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  const filtered = useMemo(
    () => bookmarks.filter((b) => b.source === source),
    [bookmarks, source]
  );

  // Group by project
  const grouped = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const b of filtered) {
      const key = b.projectName || b.projectId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(b);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const handleClick = (b: (typeof filtered)[0]) => {
    const base = `/projects/${encodeURIComponent(b.projectId)}/session/${encodeURIComponent(b.filePath)}`;
    if (b.messageId) {
      navigate(`${base}?scrollTo=${encodeURIComponent(b.messageId)}`);
    } else {
      navigate(base);
    }
  };

  return (
    <div className="workspace-page">
      <div className="flex items-center gap-2 mb-5">
        <Star className="w-5 h-5 text-yellow-500" />
        <h1 className="workspace-page-title">{t("收藏")}</h1>
        <span className="text-sm text-muted-foreground">({filtered.length})</span>
      </div>

      {bookmarksLoading ? (
        <LoadingState label={t("加载收藏...")} />
      ) : filtered.length === 0 ? (
        <EmptyState title={t("暂无收藏。在会话列表或消息页中点击星标即可添加收藏。")} />
      ) : (
        <div className="space-y-6">
          {grouped.map(([projectName, items]) => (
            <div key={projectName}>
              <div className="flex items-center gap-1.5 mb-2 text-sm font-medium text-muted-foreground">
                <FolderOpen className="w-3.5 h-3.5" />
                {projectName}
              </div>
              <div className="space-y-1.5">
                {items.map((b) => (
                  <div
                    key={b.id}
                    onClick={() => handleClick(b)}
                    className="bg-card border border-border rounded-lg p-3 hover:border-primary/50 hover:bg-accent/30 transition-all cursor-pointer group flex items-center gap-3"
                  >
                    <Star className="w-4 h-4 text-yellow-500 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {b.messageId ? b.preview : b.sessionTitle}
                      </p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        {b.messageId ? (
                          <span className="flex items-center gap-1">
                            <MessageSquare className="w-3 h-3" />
                            {t("消息收藏")}</span>
                        ) : (
                          <span>{t("会话收藏")}</span>
                        )}
                        {b.sessionTitle && b.messageId && (
                          <span className="truncate">{b.sessionTitle}</span>
                        )}
                        <span>
                          {formatDistanceToNow(new Date(b.createdAt), {
                            addSuffix: true,
                            locale: getDateLocale(),
                          })}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeBookmark(b.id);
                      }}
                      className="p-1.5 rounded-md text-transparent group-hover:text-muted-foreground hover:!text-destructive transition-colors shrink-0"
                      title={t("取消收藏")}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
