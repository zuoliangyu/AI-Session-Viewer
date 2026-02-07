import { useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { Search, Loader2, MessageSquare } from "lucide-react";

export function SearchPage() {
  const navigate = useNavigate();
  const { searchResults, searchLoading, search } = useAppStore();
  const [query, setQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

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

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">全局搜索</h1>

      {/* Search input */}
      <div className="relative mb-6">
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

      {/* Results */}
      {searchResults.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            找到 {searchResults.length} 条结果
          </p>
          {searchResults.map((result, i) => (
            <div
              key={i}
              onClick={() =>
                navigate(
                  `/projects/${result.encodedName}/${result.sessionId}`
                )
              }
              className="bg-card border border-border rounded-lg p-4 hover:border-primary/50 hover:bg-accent/30 transition-all cursor-pointer"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs px-2 py-0.5 bg-muted rounded font-medium">
                  {result.projectName}
                </span>
                <span className="text-xs text-muted-foreground">
                  {result.role === "user" ? "用户" : "Claude"}
                </span>
                {result.timestamp && (
                  <span className="text-xs text-muted-foreground">
                    {new Date(result.timestamp).toLocaleDateString()}
                  </span>
                )}
              </div>
              {result.firstPrompt && (
                <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" />
                  {result.firstPrompt}
                </p>
              )}
              <p className="text-sm font-mono whitespace-pre-wrap break-all">
                {highlightMatch(result.matchedText, query)}
              </p>
            </div>
          ))}
        </div>
      ) : query && !searchLoading ? (
        <div className="text-center text-muted-foreground py-12">
          未找到匹配的结果
        </div>
      ) : !query ? (
        <div className="text-center text-muted-foreground py-12">
          输入关键词搜索所有会话内容
        </div>
      ) : null}
    </div>
  );
}
