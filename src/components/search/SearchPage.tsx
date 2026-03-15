import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { Search, Loader2, MessageSquare, MessagesSquare, Tag, Copy, Check } from "lucide-react";

export function SearchPage() {
  const navigate = useNavigate();
  const {
    source,
    searchResults,
    searchLoading,
    search,
    crossProjectTags,
    globalTagFilter,
    loadCrossProjectTags,
    setGlobalTagFilter,
  } = useAppStore();
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"messages" | "sessions">("messages");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [copiedFilePath, setCopiedFilePath] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopySessionName = (e: React.MouseEvent, filePath: string, name: string) => {
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
    // Ensure cross-project tags are loaded for filtering
    if (Object.keys(crossProjectTags).length === 0) {
      loadCrossProjectTags();
    }
  }, [source]);

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

  const handleResultClick = (result: (typeof searchResults)[0]) => {
    const encodedProjectId = encodeURIComponent(result.projectId);
    const encodedFilePath = encodeURIComponent(result.filePath);
    navigate(
      `/projects/${encodedProjectId}/session/${encodedFilePath}`
    );
  };

  const getRoleLabel = (role: string) => {
    if (role === "user") return "用户";
    if (role === "tool") return "Tool";
    if (role === "session") return "会话名";
    return source === "codex" ? "Codex" : "Claude";
  };

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

  // Filter search results by global tag filter
  const filteredResults =
    globalTagFilter.length > 0
      ? searchResults.filter((r) =>
          globalTagFilter.every((t) => r.tags?.includes(t))
        )
      : searchResults;

  // Group results by session (filePath) for session mode
  const groupedSessions = useMemo(() => {
    if (searchMode !== "sessions") return [];
    const groups = new Map<string, {
      projectId: string;
      projectName: string;
      alias: string | null;
      firstPrompt: string | null;
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
      } else {
        groups.set(r.filePath, {
          projectId: r.projectId,
          projectName: r.projectName,
          alias: r.alias,
          firstPrompt: r.firstPrompt,
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
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">全局搜索</h1>

      {/* Search input */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="搜索所有会话内容..."
          className="w-full pl-10 pr-4 py-2.5 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
          autoFocus
        />
        {searchLoading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Mode toggle */}
      <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5 w-fit mb-4">
        <button
          onClick={() => setSearchMode("messages")}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            searchMode === "messages"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          消息
        </button>
        <button
          onClick={() => setSearchMode("sessions")}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            searchMode === "sessions"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <MessagesSquare className="w-3.5 h-3.5" />
          会话
        </button>
      </div>

      {/* Tag filter bar */}
      {allGlobalTags.length > 0 && (
        <div className="flex items-center gap-2 mb-6 flex-wrap">
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

      {/* Results */}
      {filteredResults.length > 0 ? (
        searchMode === "messages" ? (
          /* Message mode */
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              找到 {filteredResults.length} 条结果
              {globalTagFilter.length > 0 && searchResults.length !== filteredResults.length && (
                <span>（共 {searchResults.length} 条，已按标签筛选）</span>
              )}
            </p>
            {filteredResults.map((result, i) => (
              <div
                key={i}
                onClick={() => handleResultClick(result)}
                className="bg-card border border-border rounded-lg p-4 hover:border-primary/50 hover:bg-accent/30 transition-all cursor-pointer"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs px-2 py-0.5 bg-muted rounded font-medium">
                    {result.projectName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {getRoleLabel(result.role)}
                  </span>
                  {result.timestamp && (
                    <span className="text-xs text-muted-foreground">
                      {new Date(result.timestamp).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {(result.alias || result.firstPrompt) && (
                  <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                    <MessageSquare className="w-3 h-3" />
                    {result.alias || result.firstPrompt}
                  </p>
                )}
                {/* Tags */}
                {result.tags && result.tags.length > 0 && (
                  <div className="flex items-center gap-1.5 mb-2">
                    {result.tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-block px-2 py-0.5 text-xs rounded-full bg-primary/15 text-primary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-sm font-mono whitespace-pre-wrap break-all">
                  {highlightMatch(result.matchedText, query)}
                </p>
              </div>
            ))}
          </div>
        ) : (
          /* Session mode */
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              找到 {groupedSessions.length} 个会话（共 {filteredResults.length} 条匹配）
              {globalTagFilter.length > 0 && searchResults.length !== filteredResults.length && (
                <span>（已按标签筛选）</span>
              )}
            </p>
            {groupedSessions.map((session) => (
              <div
                key={session.filePath}
                onClick={() => {
                  const encodedProjectId = encodeURIComponent(session.projectId);
                  const encodedFilePath = encodeURIComponent(session.filePath);
                  const scrollParam = session.firstMatchedMessageId
                    ? `?scrollTo=${encodeURIComponent(session.firstMatchedMessageId)}`
                    : "";
                  navigate(`/projects/${encodedProjectId}/session/${encodedFilePath}${scrollParam}`);
                }}
                className="bg-card border border-border rounded-lg p-4 hover:border-primary/50 hover:bg-accent/30 transition-all cursor-pointer"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs px-2 py-0.5 bg-muted rounded font-medium">
                    {session.projectName}
                  </span>
                  <span className="text-xs px-2 py-0.5 bg-primary/15 text-primary rounded font-medium">
                    {session.matchCount} 条匹配 / 共 {session.totalMessageCount} 条
                  </span>
                  {session.latestTimestamp && (
                    <span className="text-xs text-muted-foreground ml-auto">
                      {new Date(session.latestTimestamp).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {(session.alias || session.firstPrompt) && (
                  <div className="flex items-center gap-1 mb-2 group/title">
                    <MessagesSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm text-foreground truncate flex-1">
                      {session.alias || session.firstPrompt}
                    </span>
                    <button
                      onClick={(e) =>
                        handleCopySessionName(e, session.filePath, session.alias || session.firstPrompt || "")
                      }
                      className="shrink-0 p-1 rounded opacity-0 group-hover/title:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                      title="复制会话名"
                    >
                      {copiedFilePath === session.filePath ? (
                        <Check className="w-3 h-3 text-green-500" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                )}
                {/* Tags */}
                {session.tags && session.tags.length > 0 && (
                  <div className="flex items-center gap-1.5 mb-2">
                    {session.tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-block px-2 py-0.5 text-xs rounded-full bg-primary/15 text-primary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {/* Matched text previews */}
                <div className="space-y-1">
                  {session.matchedTexts.map((text, i) => (
                    <p key={i} className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all line-clamp-1">
                      {highlightMatch(text, query)}
                    </p>
                  ))}
                  {session.matchCount > 3 && (
                    <p className="text-xs text-muted-foreground/70">
                      还有 {session.matchCount - 3} 条匹配...
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : query && !searchLoading ? (
        <div className="text-center text-muted-foreground py-12">
          {globalTagFilter.length > 0 && searchResults.length > 0
            ? "没有匹配标签筛选条件的搜索结果"
            : "未找到匹配的结果"}
        </div>
      ) : !query ? (
        <div className="text-center text-muted-foreground py-12">
          输入关键词搜索所有会话内容
        </div>
      ) : null}
    </div>
  );
}
