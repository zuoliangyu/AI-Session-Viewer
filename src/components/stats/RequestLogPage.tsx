import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  Loader2,
  Receipt,
  X,
  ExternalLink,
  Clock,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { RequestLogFilter, RequestRecord } from "../../types";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd > 0) return `$${usd.toFixed(4)}`;
  return "$0";
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m${secs}s`;
}

function formatTimestamp(ts: string): string {
  if (!ts) return "—";
  // ISO 8601: 2026-05-23T14:30:11.123Z → "05-23 14:30:11"
  const date = ts.slice(5, 10);
  const time = ts.slice(11, 19);
  return `${date} ${time}`;
}

/** Truncate the middle of a path so the "interesting" tail is preserved. */
function truncatePath(p: string, max = 32): string {
  if (p.length <= max) return p;
  const head = Math.floor((max - 1) / 2);
  const tail = max - 1 - head;
  return `${p.slice(0, head)}…${p.slice(-tail)}`;
}

export function RequestLogPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    source,
    requestLog,
    requestLogTotal,
    requestLogTotalCost,
    requestLogLoading,
    requestLogFilter,
    loadRequestLog,
    setRequestLogFilter,
    projects,
    loadProjects,
  } = useAppStore();

  const initialFilter: RequestLogFilter = useMemo(() => ({
    projectId: searchParams.get("projectId"),
    sessionId: searchParams.get("sessionId"),
    startDate: searchParams.get("startDate"),
    endDate: searchParams.get("endDate"),
    model: searchParams.get("model"),
    page: 0,
    pageSize: 500,
  }), [searchParams]);

  const [projectId, setProjectId] = useState(initialFilter.projectId ?? "");
  const [modelFilter, setModelFilter] = useState(initialFilter.model ?? "");
  const [startDate, setStartDate] = useState(initialFilter.startDate ?? "");
  const [endDate, setEndDate] = useState(initialFilter.endDate ?? "");

  useEffect(() => {
    if (projects.length === 0) loadProjects();
    loadRequestLog(initialFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const applyFilters = () => {
    const next: RequestLogFilter = {
      projectId: projectId || null,
      model: modelFilter || null,
      startDate: startDate || null,
      endDate: endDate || null,
      sessionId: null,
      page: 0,
      pageSize: 500,
    };
    setRequestLogFilter(next);
    loadRequestLog(next);

    // Reflect filters in the URL for shareability / back-nav.
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (modelFilter) params.set("model", modelFilter);
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    setSearchParams(params, { replace: true });
  };

  const resetFilters = () => {
    setProjectId("");
    setModelFilter("");
    setStartDate("");
    setEndDate("");
    const next: RequestLogFilter = { page: 0, pageSize: 500 };
    setRequestLogFilter(next);
    loadRequestLog(next);
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  // Discover model options actually present in the log so the filter
  // dropdown only shows real values.
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of requestLog) set.add(r.model);
    return Array.from(set).sort();
  }, [requestLog]);

  // Virtual list — 100k rows still scrolls smoothly.
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: requestLog.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 12,
  });

  const handleRowClick = (record: RequestRecord) => {
    // Deep-link to the session message view. Hash includes the message uuid
    // so MessagesPage can highlight + scroll there.
    if (!record.projectId || !record.filePath) return;
    const fragment = record.messageUuid ? `#m=${record.messageUuid}` : "";
    navigate(
      `/projects/${encodeURIComponent(record.projectId)}/session/${encodeURIComponent(
        record.filePath,
      )}${fragment}`,
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-3 flex items-center gap-3">
        <button
          onClick={() => navigate("/stats")}
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          title="返回统计"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Receipt className="w-5 h-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">逐请求账单</h1>
        <span className="text-xs text-muted-foreground">
          ({source === "claude" ? "Claude" : "Codex"})
        </span>
        <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
          <span>
            共 <span className="font-semibold text-foreground">{requestLogTotal.toLocaleString()}</span> 条
          </span>
          <span>
            累计花费 <span className="font-semibold text-green-500">{formatCost(requestLogTotalCost)}</span>
          </span>
        </div>
      </div>

      {/* Filter row */}
      <div className="border-b border-border bg-card px-6 py-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">项目：</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="bg-background border border-border rounded px-2 py-1 text-foreground min-w-[12rem] max-w-[20rem]"
          >
            <option value="">全部</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.alias ?? p.shortName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">模型：</span>
          <select
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            className="bg-background border border-border rounded px-2 py-1 text-foreground"
          >
            <option value="">全部</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">起：</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="bg-background border border-border rounded px-2 py-1 text-foreground"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">止：</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="bg-background border border-border rounded px-2 py-1 text-foreground"
          />
        </label>
        <button
          onClick={applyFilters}
          className="px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          应用
        </button>
        <button
          onClick={resetFilters}
          className="px-3 py-1 rounded border border-border hover:bg-accent transition-colors flex items-center gap-1"
        >
          <X className="w-3 h-3" /> 重置
        </button>
        {requestLogLoading && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            加载中...
          </span>
        )}
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[10rem_1fr_10rem_8rem_5rem_5rem_5rem_5rem_4.5rem_5rem] gap-2 px-6 py-2 text-[11px] font-medium text-muted-foreground bg-muted/40 border-b border-border sticky top-0 z-10">
        <span>时间</span>
        <span>项目</span>
        <span>模型</span>
        <span>会话</span>
        <span className="text-right">input</span>
        <span className="text-right">cache 读</span>
        <span className="text-right">cache 写</span>
        <span className="text-right">output</span>
        <span className="text-right">耗时</span>
        <span className="text-right">花费</span>
      </div>

      {/* Virtual list body */}
      <div ref={scrollRef} className="flex-1 overflow-auto bg-background">
        {requestLog.length === 0 && !requestLogLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {projectId || modelFilter || startDate || endDate
              ? "当前筛选下没有匹配的请求。"
              : "暂无请求记录。"}
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const record = requestLog[virtualItem.index];
              return (
                <button
                  key={virtualItem.key}
                  onClick={() => handleRowClick(record)}
                  className="grid grid-cols-[10rem_1fr_10rem_8rem_5rem_5rem_5rem_5rem_4.5rem_5rem] gap-2 items-center text-xs hover:bg-accent/40 transition-colors border-b border-border/50 cursor-pointer w-full text-left"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: virtualItem.size,
                    transform: `translateY(${virtualItem.start}px)`,
                    paddingLeft: "1.5rem",
                    paddingRight: "1.5rem",
                  }}
                  title={`${record.filePath}\n${record.timestamp}`}
                >
                  <span className="text-muted-foreground font-mono">
                    {formatTimestamp(record.timestamp)}
                  </span>
                  <span className="truncate text-foreground">
                    {projectDisplay(projects, record.projectId)}
                  </span>
                  <span className="font-mono text-[10.5px] truncate text-foreground/80">
                    {record.model}
                  </span>
                  <span className="font-mono text-[10.5px] truncate text-muted-foreground">
                    {record.sessionId.slice(0, 8)}
                  </span>
                  <span className="text-right font-mono text-foreground">
                    {formatTokens(record.inputTokens)}
                  </span>
                  <span className="text-right font-mono text-teal-500">
                    {record.cacheReadTokens > 0 ? formatTokens(record.cacheReadTokens) : "—"}
                  </span>
                  <span className="text-right font-mono text-purple-500">
                    {record.cacheCreationTokens > 0 ? formatTokens(record.cacheCreationTokens) : "—"}
                  </span>
                  <span className="text-right font-mono text-amber-500">
                    {formatTokens(record.outputTokens)}
                  </span>
                  <span className="text-right font-mono text-muted-foreground flex items-center justify-end gap-0.5">
                    {record.durationMs !== null && <Clock className="w-2.5 h-2.5 opacity-50" />}
                    {formatDuration(record.durationMs)}
                  </span>
                  <span className="text-right font-mono text-green-500 flex items-center justify-end gap-1">
                    {formatCost(record.costUsd)}
                    <ExternalLink className="w-2.5 h-2.5 opacity-40" />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function projectDisplay(
  projects: { id: string; shortName: string; alias: string | null }[],
  projectId: string,
): string {
  const found = projects.find((p) => p.id === projectId);
  if (found) return found.alias ?? found.shortName;
  return truncatePath(projectId);
}
