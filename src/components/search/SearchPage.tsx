import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import {
  Search,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Tag,
  Copy,
  Check,
  Filter,
} from "lucide-react";
import { formatDateOnly } from "../../utils/dateTime";

type SearchMode = "messages" | "sessions";
type SearchScope = "all" | "content" | "session" | "tags";

const SEARCH_SCOPE_OPTIONS: Array<{ key: SearchScope; label: string }> = [
  { key: "all", get label() { return t("所有"); } },
  { key: "content", get label() { return t("消息内容"); } },
  { key: "session", get label() { return t("会话名称"); } },
  { key: "tags", get label() { return t("标签"); } },
];

export function SearchPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    source,
    searchResults,
    searchLoading,
    search,
    searchScope,
    setSearchScope,
    crossProjectTags,
    globalTagFilter,
    loadCrossProjectTags,
    setGlobalTagFilter,
    timeZone,
  } = useAppStore();
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("messages");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [copiedFilePath, setCopiedFilePath] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopySessionName = (e: React.MouseEvent, filePath: string, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(name);
    setCopiedFilePath(filePath);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedFilePath(null), 2000);
  };

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (Object.keys(crossProjectTags).length === 0) {
      loadCrossProjectTags();
    }
  }, [source, crossProjectTags, loadCrossProjectTags]);

  const handleSearch = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        search(value);
      }, 300);
    },
    [search]
  );

  const highlightMatch = (text: string, q: string) => {
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-yellow-500/30 text-foreground rounded px-0.5">
          {text.slice(idx, idx + q.length)}
        </mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  const buildSessionLink = (
    projectId: string,
    filePath: string,
    matchedMessageId?: string | null,
  ) => {
    const encodedProjectId = encodeURIComponent(projectId);
    const encodedFilePath = encodeURIComponent(filePath);
    const params = new URLSearchParams();
    if (matchedMessageId) {
      params.set("scrollTo", matchedMessageId);
      params.set("matchedOnly", "1");
    }
    if (query.trim()) {
      params.set("searchQuery", query.trim());
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return `/projects/${encodedProjectId}/session/${encodedFilePath}${suffix}`;
  };

  const handleResultClick = (result: (typeof searchResults)[0]) => {
    navigate(buildSessionLink(result.projectId, result.filePath, result.matchedMessageId));
  };

  const getRoleLabel = (role: string) => {
    if (role === "user") return t("用户");
    if (role === "tool") return "Tool";
    if (role === "session") return t("会话名");
    if (role === "tag") return t("标签");
    return source === "codex" ? "Codex" : source === "grok" ? "Grok" : source === "omp" ? "Oh My Pi" : "Claude";
  };

  const allGlobalTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const tags of Object.values(crossProjectTags)) {
      for (const tag of tags) {
        tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort();
  }, [crossProjectTags]);

  const toggleGlobalTag = useCallback((tag: string) => {
    if (globalTagFilter.includes(tag)) {
      setGlobalTagFilter(globalTagFilter.filter((t) => t !== tag));
    } else {
      setGlobalTagFilter([...globalTagFilter, tag]);
    }
  }, [globalTagFilter, setGlobalTagFilter]);

  const filteredResults =
    globalTagFilter.length > 0
      ? searchResults.filter((r) =>
          globalTagFilter.every((t) => r.tags?.includes(t))
        )
      : searchResults;

  const groupedSessions = useMemo(() => {
    if (searchMode !== "sessions") return [];
    const groups = new Map<string, {
      projectId: string;
      projectName: string;
      alias: string | null;
      firstPrompt: string | null;
      threadName: string | null;
      tags: string[] | null;
      filePath: string;
      matchCount: number;
      latestTimestamp: string;
      matchedTexts: string[];
      totalMessageCount: number;
      firstMatchedMessageId: string | null;
    }>();

    for (const r of filteredResults) {
      const existing = groups.get(r.filePath);
      if (existing) {
        existing.matchCount++;
        if (r.timestamp && r.timestamp > existing.latestTimestamp) {
          existing.latestTimestamp = r.timestamp;
        }
        if (existing.matchedTexts.length < 3) {
          existing.matchedTexts.push(r.matchedText);
        }
        if (!existing.firstMatchedMessageId && r.matchedMessageId) {
          existing.firstMatchedMessageId = r.matchedMessageId;
        }
      } else {
        groups.set(r.filePath, {
          projectId: r.projectId,
          projectName: r.projectName,
          alias: r.alias,
          firstPrompt: r.firstPrompt,
          threadName: r.threadName,
          tags: r.tags,
          filePath: r.filePath,
          matchCount: 1,
          latestTimestamp: r.timestamp || "",
          matchedTexts: [r.matchedText],
          totalMessageCount: r.totalMessageCount,
          firstMatchedMessageId: r.matchedMessageId,
        });
      }
    }

    return Array.from(groups.values()).sort(
      (a, b) => b.latestTimestamp.localeCompare(a.latestTimestamp)
    );
  }, [filteredResults, searchMode]);

  return (
    <div className="workspace-page">
      <div className="mb-5"><h1 className="workspace-page-title">{t("搜索会话")}</h1><p className="workspace-page-description">{t("查找消息、会话名称和标签")}</p></div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="search"
          aria-label={t("搜索会话")}
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={t("搜索所有会话内容...")}
          className="w-full pl-10 pr-4 py-2.5 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
          autoFocus
        />
        {searchLoading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
          <button
            onClick={() => setSearchMode("messages")}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              searchMode === "messages"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            {t("消息")}</button>
          <button
            onClick={() => setSearchMode("sessions")}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              searchMode === "sessions"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <MessagesSquare className="w-3.5 h-3.5" />
            {t("会话")}</button>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1">
          <span className="inline-flex items-center gap-1 px-2 text-xs text-muted-foreground">
            <Filter className="w-3.5 h-3.5" />
            {t("匹配范围")}</span>
          {SEARCH_SCOPE_OPTIONS.map((option) => (
            <button
              key={option.key}
              onClick={() => setSearchScope(option.key)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                searchScope === option.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {allGlobalTags.length > 0 && (
        <details className="workspace-filter"><summary>{t("标签筛选")}{globalTagFilter.length > 0 ? t(" · 已选 ") + globalTagFilter.length : ""}</summary>
        <div className="flex flex-wrap items-center gap-2">
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
              {t("清除筛选")}</button>
          )}
        </div></details>
      )}

      {filteredResults.length > 0 ? (
        searchMode === "messages" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("找到")}{filteredResults.length} {t("条结果")}{globalTagFilter.length > 0 && searchResults.length !== filteredResults.length && (
                <span>{t("（共")}{searchResults.length} {t("条，已按标签筛选）")}</span>
              )}
            </p>
            {filteredResults.map((result, i) => {
              const sessionTitle = result.alias || result.threadName || result.firstPrompt || t("（无标题）");
              return (
                <div
                  key={`${result.filePath}-${result.matchedMessageId || i}`}
                  onClick={() => handleResultClick(result)}
                  className="bg-card border border-border rounded-lg p-3 hover:border-primary/50 hover:bg-accent/30 transition-all cursor-pointer"
                >
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-xs px-2 py-0.5 bg-muted rounded font-medium">
                      {result.projectName}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {getRoleLabel(result.role)}
                    </span>
                    <span className="text-xs px-2 py-0.5 bg-primary/15 text-primary rounded font-medium">
                      {t("共")}{result.totalMessageCount} {t("条消息")}</span>
                    {result.timestamp && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        {formatDateOnly(result.timestamp, timeZone)}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 mb-2">
                    <MessageSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm text-foreground truncate flex-1">
                      {sessionTitle}
                    </span>
                    <button
                      onClick={(e) => handleCopySessionName(e, result.filePath, sessionTitle)}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      title={t("复制会话名")}
                    >
                      {copiedFilePath === result.filePath ? (
                        <>
                          <Check className="w-3 h-3 text-green-500" />
                          {t("已复制")}</>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          {t("复制会话名")}</>
                      )}
                    </button>
                  </div>

                  {result.tags && result.tags.length > 0 && (
                    <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                      {result.tags.map((tag) => (
                        <button
                          key={tag}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleGlobalTag(tag);
                          }}
                          className={`inline-block px-2 py-0.5 text-xs rounded-full transition-colors ${
                            globalTagFilter.includes(tag)
                              ? "bg-primary text-primary-foreground"
                              : "bg-primary/15 text-primary hover:bg-primary/25"
                          }`}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}

                  <p className="text-sm font-mono whitespace-pre-wrap break-all">
                    {highlightMatch(result.matchedText, query)}
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("找到")}{groupedSessions.length} {t("个会话（共")}{filteredResults.length} {t("条匹配）")}{globalTagFilter.length > 0 && searchResults.length !== filteredResults.length && (
                <span>{t("（已按标签筛选）")}</span>
              )}
            </p>
            {groupedSessions.map((session) => {
              const title = session.alias || session.threadName || session.firstPrompt || t("（无标题）");
              return (
                <div
                  key={session.filePath}
                  onClick={() => {
                    navigate(
                      buildSessionLink(
                        session.projectId,
                        session.filePath,
                        session.firstMatchedMessageId
                      )
                    );
                  }}
                  className="bg-card border border-border rounded-lg p-3 hover:border-primary/50 hover:bg-accent/30 transition-all cursor-pointer"
                >
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-xs px-2 py-0.5 bg-muted rounded font-medium">
                      {session.projectName}
                    </span>
                    <span className="text-xs px-2 py-0.5 bg-primary/15 text-primary rounded font-medium">
                      {session.matchCount} {t("条匹配")}</span>
                    <span className="text-xs px-2 py-0.5 bg-muted text-muted-foreground rounded font-medium">
                      {t("共")}{session.totalMessageCount} {t("条消息")}</span>
                    {session.latestTimestamp && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        {formatDateOnly(session.latestTimestamp, timeZone)}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 mb-2">
                    <MessagesSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm text-foreground truncate flex-1">
                      {title}
                    </span>
                    <button
                      onClick={(e) => handleCopySessionName(e, session.filePath, title)}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      title={t("复制会话名")}
                    >
                      {copiedFilePath === session.filePath ? (
                        <>
                          <Check className="w-3 h-3 text-green-500" />
                          {t("已复制")}</>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          {t("复制会话名")}</>
                      )}
                    </button>
                  </div>

                  {session.tags && session.tags.length > 0 && (
                    <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                      {session.tags.map((tag) => (
                        <button
                          key={tag}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleGlobalTag(tag);
                          }}
                          className={`inline-block px-2 py-0.5 text-xs rounded-full transition-colors ${
                            globalTagFilter.includes(tag)
                              ? "bg-primary text-primary-foreground"
                              : "bg-primary/15 text-primary hover:bg-primary/25"
                          }`}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="space-y-1">
                    {session.matchedTexts.map((text, i) => (
                      <p key={i} className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all line-clamp-1">
                        {highlightMatch(text, query)}
                      </p>
                    ))}
                    {session.matchCount > 3 && (
                      <p className="text-xs text-muted-foreground/70">
                        {t("还有")}{session.matchCount - 3} {t("条匹配...")}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : query && !searchLoading ? (
        <div className="text-center text-muted-foreground py-12">
          {globalTagFilter.length > 0 && searchResults.length > 0
            ? t("没有匹配标签筛选条件的搜索结果")
            : t("未找到匹配的结果")}
        </div>
      ) : !query ? (
        <div className="text-center text-muted-foreground py-12">
          {t("输入关键词搜索所有会话内容")}</div>
      ) : null}
    </div>
  );
}
