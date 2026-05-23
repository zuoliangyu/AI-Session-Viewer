import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../services/api";
import type { RequestRecord } from "../../types";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  ReferenceLine,
} from "recharts";
import {
  MessageSquare,
  Zap,
  Activity,
  Loader2,
  Calendar,
  DollarSign,
  Database,
  FolderOpen,
  Receipt,
  Eye,
  EyeOff,
} from "lucide-react";

type TimePreset = "today" | "week" | "month" | "30d" | "all" | "custom";

function getDateRange(
  preset: TimePreset,
  customStart: string,
  customEnd: string
): { start: string; end: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = fmt(now);

  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "week": {
      const d = new Date(now);
      const dayOfWeek = now.getDay(); // 0=Sunday
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      d.setDate(now.getDate() - daysFromMonday);
      return { start: fmt(d), end: today };
    }
    case "month": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: fmt(d), end: today };
    }
    case "30d": {
      const d = new Date(now);
      d.setDate(now.getDate() - 29);
      return { start: fmt(d), end: today };
    }
    case "custom":
      return { start: customStart, end: customEnd };
    default:
      return { start: "", end: "" };
  }
}

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

// Stable color per model so the cache-hit and cost-by-model charts agree.
const MODEL_COLORS = [
  "#3b82f6",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

function modelColor(model: string, index: number): string {
  return MODEL_COLORS[index % MODEL_COLORS.length] ?? `hsl(${(index * 67) % 360},70%,55%)`;
}

interface BucketRow {
  /** Display label on the X axis ("MM-DD" for days, "HH:00" for hours). */
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  cost: number;
  messages: number;
  /** Per-model cache hit ratio, %. */
  cacheRatioByModel: Record<string, number>;
}

/** Group request records into hourly buckets for the given UTC-day. */
function bucketByHour(records: RequestRecord[]): BucketRow[] {
  const buckets = new Map<number, BucketRow>();
  // Pre-seed all 24 hours so the chart shows a smooth axis instead of
  // collapsing to whichever hours had activity.
  for (let h = 0; h < 24; h++) {
    buckets.set(h, {
      label: `${String(h).padStart(2, "0")}:00`,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
      cost: 0,
      messages: 0,
      cacheRatioByModel: {},
    });
  }
  // For cache hit ratio per model: accumulate numerator (cache_read) and
  // denominator (input + cache_read + cache_creation) separately, then
  // divide at the end.
  const ratioNum = new Map<number, Record<string, number>>();
  const ratioDen = new Map<number, Record<string, number>>();

  for (const r of records) {
    if (!r.timestamp || r.timestamp.length < 13) continue;
    // Use the local-time hour so the user sees their own clock.
    const ts = new Date(r.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    const hour = ts.getHours();
    const bucket = buckets.get(hour);
    if (!bucket) continue;
    bucket.input += r.inputTokens;
    bucket.output += r.outputTokens;
    bucket.cacheRead += r.cacheReadTokens;
    bucket.cacheCreation += r.cacheCreationTokens;
    bucket.total += r.totalTokens;
    bucket.cost += r.costUsd;
    bucket.messages += 1;

    const inputSide = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
    if (inputSide > 0) {
      const num = ratioNum.get(hour) ?? {};
      const den = ratioDen.get(hour) ?? {};
      num[r.model] = (num[r.model] ?? 0) + r.cacheReadTokens;
      den[r.model] = (den[r.model] ?? 0) + inputSide;
      ratioNum.set(hour, num);
      ratioDen.set(hour, den);
    }
  }

  // Compute ratios.
  for (const [hour, bucket] of buckets) {
    const num = ratioNum.get(hour) ?? {};
    const den = ratioDen.get(hour) ?? {};
    const out: Record<string, number> = {};
    for (const [model, d] of Object.entries(den)) {
      if (d > 0) out[model] = ((num[model] ?? 0) / d) * 100;
    }
    bucket.cacheRatioByModel = out;
  }

  return Array.from(buckets.values());
}

/** Build the cache-hit-rate trend rows in wide format (one column/model). */
function buildCacheTrend(rows: BucketRow[]): {
  rows: Record<string, number | string>[];
  models: string[];
} {
  const modelSet = new Set<string>();
  for (const r of rows) for (const m of Object.keys(r.cacheRatioByModel)) modelSet.add(m);
  const models = Array.from(modelSet).sort();
  const out = rows.map((r) => {
    const row: Record<string, number | string> = { label: r.label };
    for (const m of models) {
      const v = r.cacheRatioByModel[m];
      if (typeof v === "number") row[m] = Math.round(v * 10) / 10;
    }
    return row;
  });
  return { rows: out, models };
}

export function StatsPage() {
  const navigate = useNavigate();
  const {
    source,
    tokenSummary,
    statsLoading,
    statsIsFirstBuild,
    loadStats,
    projectCosts,
    projectCostsLoading,
    loadProjectCosts,
  } = useAppStore();
  const [preset, setPreset] = useState<TimePreset>("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadStats();
    loadProjectCosts();
  }, [source]);

  const { start, end } = useMemo(
    () => getDateRange(preset, customStart, customEnd),
    [preset, customStart, customEnd]
  );

  const isSingleDay = !!start && !!end && start === end;

  // Single-day mode: fetch the day's per-request records so we can rebuild
  // the trend at hourly resolution. The cached daily-summary only has one
  // datapoint for the day, which is useless for "今天" view.
  const [hourlyRecords, setHourlyRecords] = useState<RequestRecord[]>([]);
  const [hourlyLoading, setHourlyLoading] = useState(false);

  useEffect(() => {
    if (!isSingleDay) {
      setHourlyRecords([]);
      return;
    }
    let cancelled = false;
    setHourlyLoading(true);
    (async () => {
      try {
        // Pull everything for the day in one shot; even an extremely heavy
        // user rarely makes more than a few thousand requests per day, and
        // the per-record payload is small.
        const page = await api.getRequestLog(source, {
          startDate: start,
          endDate: end,
          page: 0,
          pageSize: 100_000,
        });
        if (!cancelled) {
          setHourlyRecords(page.records);
          setHourlyLoading(false);
        }
      } catch (e) {
        console.error("Failed to load hourly request log:", e);
        if (!cancelled) {
          setHourlyRecords([]);
          setHourlyLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSingleDay, source, start, end]);

  // Build the chart rows. Two paths:
  //  - single-day  → bucket by hour from the freshly fetched records
  //  - multi-day   → reuse the cached `dailyTokens` summary
  const bucketRows: BucketRow[] = useMemo(() => {
    if (isSingleDay) {
      return bucketByHour(hourlyRecords);
    }
    if (!tokenSummary) return [];
    const days = tokenSummary.dailyTokens.filter(
      (d) => (!start || d.date >= start) && (!end || d.date <= end),
    );
    return days.map<BucketRow>((d) => ({
      label: d.date.slice(5),
      input: d.inputTokens,
      output: d.outputTokens,
      cacheRead: d.cacheReadTokens,
      cacheCreation: d.cacheCreationTokens,
      total: d.totalTokens,
      cost: d.costUsd,
      messages: d.messageCount ?? 0,
      cacheRatioByModel: Object.fromEntries(
        Object.entries(d.cacheHitRatioByModel ?? {}).map(([m, v]) => [
          m,
          Math.round(v * 1000) / 10,
        ]),
      ),
    }));
  }, [isSingleDay, hourlyRecords, tokenSummary, start, end]);

  const filteredTotals = useMemo(() => {
    const totalTokens = bucketRows.reduce((s, d) => s + d.total, 0);
    const totalInputTokens = bucketRows.reduce((s, d) => s + d.input, 0);
    const totalOutputTokens = bucketRows.reduce((s, d) => s + d.output, 0);
    const totalCacheRead = bucketRows.reduce((s, d) => s + d.cacheRead, 0);
    const totalCacheCreation = bucketRows.reduce((s, d) => s + d.cacheCreation, 0);
    const totalCost = bucketRows.reduce((s, d) => s + d.cost, 0);

    // Approximate per-model breakdown by scaling the cross-history totals
    // proportionally to the share of tokens in the date window.
    const ratio =
      tokenSummary && tokenSummary.totalTokens > 0
        ? totalTokens / tokenSummary.totalTokens
        : 0;
    const tokensByModel: Record<string, number> = {};
    const costByModel: Record<string, number> = {};
    if (tokenSummary) {
      for (const [model, tokens] of Object.entries(tokenSummary.tokensByModel)) {
        tokensByModel[model] = Math.round(tokens * ratio);
      }
      for (const [model, cost] of Object.entries(tokenSummary.costByModel)) {
        costByModel[model] = cost * ratio;
      }
    }

    return {
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheRead,
      totalCacheCreation,
      totalCost,
      tokensByModel,
      costByModel,
    };
  }, [bucketRows, tokenSummary]);

  const cacheTrend = useMemo(() => buildCacheTrend(bucketRows), [bucketRows]);

  // When the underlying model set changes, drop any hidden models that no
  // longer exist so toggles don't get stuck.
  useEffect(() => {
    setHiddenModels((prev) => {
      const next = new Set<string>();
      for (const m of prev) if (cacheTrend.models.includes(m)) next.add(m);
      return next.size === prev.size ? prev : next;
    });
  }, [cacheTrend.models.join(",")]);

  const overallCacheHitRate = useMemo(() => {
    const den =
      filteredTotals.totalInputTokens +
      filteredTotals.totalCacheRead +
      filteredTotals.totalCacheCreation;
    if (den === 0) return 0;
    return filteredTotals.totalCacheRead / den;
  }, [filteredTotals]);

  const isAllRange = !start && !end;

  if (statsLoading) {
    const mayBeFirstBuild = statsIsFirstBuild !== false;
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>{mayBeFirstBuild ? "正在建立统计索引..." : "加载统计数据..."}</span>
        </div>
        {mayBeFirstBuild && (
          <p className="text-xs text-center max-w-sm leading-relaxed px-4">
            首次使用需要扫描所有会话文件建立索引，会话较多时可能需要一些时间，请耐心等待。
            <br />
            <span className="text-muted-foreground/60">索引完成后将缓存到本地，下次打开会非常快。</span>
          </p>
        )}
      </div>
    );
  }

  if (!tokenSummary) {
    const hint =
      source === "claude"
        ? "请确认 ~/.claude/ 目录下存在统计数据。"
        : "请确认 ~/.codex/sessions/ 目录下存在会话数据。";
    return (
      <div className="p-6 text-muted-foreground">
        未找到统计数据。{hint}
      </div>
    );
  }

  const chartData = bucketRows.map((d) => ({
    label: d.label,
    input: d.input,
    output: d.output,
    cacheRead: d.cacheRead,
    cacheCreation: d.cacheCreation,
    total: d.total,
    cost: d.cost,
  }));

  // Model breakdown
  const modelBreakdown = Object.entries(filteredTotals.tokensByModel)
    .sort(([, a], [, b]) => b - a)
    .map(([model, tokens]) => ({
      model,
      tokens,
      cost: filteredTotals.costByModel[model] ?? 0,
      pct:
        filteredTotals.totalTokens > 0
          ? ((tokens / filteredTotals.totalTokens) * 100).toFixed(1)
          : "0",
    }));

  // Top-10 project ranking (sorted by cost desc on the backend already).
  // 仅保留项目名（路径最后一段），全路径在 Tooltip 里展示。
  const topProjects = projectCosts.slice(0, 10).map((p) => {
    const trimmed = p.displayName.replace(/[\\/]+$/, "");
    const segs = trimmed.split(/[\\/]/).filter(Boolean);
    const shortName = segs.length > 0 ? segs[segs.length - 1] : p.displayName;
    return { ...p, shortName };
  });

  // 数据实际覆盖的日期范围（多日模式下，用于解释为什么"全部"看起来等同于"最近 N 天"）。
  const allDates = tokenSummary.dailyTokens.map((d) => d.date).sort();
  const dataMinDate = allDates[0];
  const dataMaxDate = allDates[allDates.length - 1];
  const dataDayCount = allDates.length;

  const granularityLabel = isSingleDay ? "按小时" : "按日";
  const messageCount = bucketRows.reduce((s, b) => s + b.messages, 0);

  // Build a quick lookup so the cache trend chart can hide lines by model.
  const visibleModels = cacheTrend.models.filter((m) => !hiddenModels.has(m));

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">
          使用统计
          <span className="text-sm font-normal text-muted-foreground ml-2">
            ({source === "claude" ? "Claude" : "Codex"})
          </span>
        </h1>
        <button
          onClick={() => navigate("/stats/requests")}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-card hover:bg-accent transition-colors"
        >
          <Receipt className="w-3.5 h-3.5" />
          查看逐请求账单
        </button>
      </div>

      {/* Time range filter */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {(["today", "week", "month", "30d", "all"] as const).map((p) => {
          const labels: Record<string, string> = {
            today: "今天", week: "本周", month: "本月", "30d": "最近30天", all: "全部",
          };
          return (
            <button
              key={p}
              onClick={() => { setPreset(p); setCustomStart(""); setCustomEnd(""); }}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                preset === p
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {labels[p]}
            </button>
          );
        })}
        <span className="text-xs text-muted-foreground ml-2">自定义：</span>
        <input
          type="date"
          value={customStart}
          onChange={(e) => {
            const val = e.target.value;
            setCustomStart(val);
            if (!val && !customEnd) setPreset("all");
            else setPreset("custom");
          }}
          className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground"
        />
        <span className="text-xs text-muted-foreground">~</span>
        <input
          type="date"
          value={customEnd}
          onChange={(e) => {
            const val = e.target.value;
            setCustomEnd(val);
            if (!val && !customStart) setPreset("all");
            else setPreset("custom");
          }}
          className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground"
        />
        {isSingleDay && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground bg-muted/50 px-2 py-1 rounded">
            <Calendar className="w-3 h-3" />
            按小时显示
            {hourlyLoading && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
          </span>
        )}
        {!isSingleDay && dataMinDate && dataMaxDate && (
          <span
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground bg-muted/50 px-2 py-1 rounded"
            title={`仅扫描 ~/.claude/projects 下现存的 .jsonl，更早的会话若被清理或不在本机则不会被纳入统计。`}
          >
            <Calendar className="w-3 h-3" />
            数据覆盖 {dataMinDate} ~ {dataMaxDate}（共 {dataDayCount} 天）
          </span>
        )}
      </div>

      {/* Summary cards: tokens + cost */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatCard
          icon={<Calendar className="w-5 h-5" />}
          label="总会话数（全期）"
          value={tokenSummary.sessionCount.toLocaleString()}
        />
        <StatCard
          icon={<MessageSquare className="w-5 h-5" />}
          label={
            isAllRange
              ? "总消息数（全期）"
              : isSingleDay
                ? "当日请求数"
                : "区间消息数"
          }
          value={(isAllRange
            ? tokenSummary.messageCount
            : messageCount
          ).toLocaleString()}
        />
        <StatCard
          icon={<Zap className="w-5 h-5" />}
          label="输入 Token"
          value={formatTokens(filteredTotals.totalInputTokens)}
        />
        <StatCard
          icon={<Activity className="w-5 h-5" />}
          label="总 Token"
          value={formatTokens(filteredTotals.totalTokens)}
        />
      </div>

      {/* Cost + cache row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          icon={<DollarSign className="w-5 h-5" />}
          label="累计花费 (USD)"
          value={formatCost(filteredTotals.totalCost)}
          accent="text-green-500"
        />
        <StatCard
          icon={<Database className="w-5 h-5" />}
          label="缓存读取 Token"
          value={formatTokens(filteredTotals.totalCacheRead)}
        />
        <StatCard
          icon={<Database className="w-5 h-5" />}
          label="缓存写入 Token"
          value={formatTokens(filteredTotals.totalCacheCreation)}
        />
        <StatCard
          icon={<Activity className="w-5 h-5" />}
          label="缓存命中率"
          value={`${(overallCacheHitRate * 100).toFixed(1)}%`}
          accent={
            overallCacheHitRate < 0.6
              ? "text-yellow-500"
              : "text-green-500"
          }
        />
      </div>

      {/* Daily token chart (stacked input + output + cache) */}
      {chartData.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4 mb-6">
          <h2 className="text-sm font-medium mb-4">
            Token 用量
            <span className="text-xs text-muted-foreground ml-2">({granularityLabel})</span>
          </h2>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickFormatter={(v) => formatTokens(v)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "6px",
                  fontSize: 12,
                }}
                formatter={(value: number, name: string) => {
                  const label =
                    name === "input"
                      ? "输入"
                      : name === "output"
                        ? "输出"
                        : name === "cacheRead"
                          ? "缓存读"
                          : name === "cacheCreation"
                            ? "缓存写"
                            : name;
                  return [formatTokens(value), label];
                }}
              />
              <Bar dataKey="input" stackId="a" fill="#3b82f6" name="input" />
              <Bar dataKey="cacheCreation" stackId="a" fill="#a855f7" name="cacheCreation" />
              <Bar dataKey="cacheRead" stackId="a" fill="#14b8a6" name="cacheRead" />
              <Bar dataKey="output" stackId="a" fill="#f59e0b" name="output" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Cost trend */}
      {chartData.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4 mb-6">
          <h2 className="text-sm font-medium mb-4">
            花费趋势 (USD)
            <span className="text-xs text-muted-foreground ml-2">({granularityLabel})</span>
          </h2>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickFormatter={(v) => formatCost(v)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "6px",
                  fontSize: 12,
                }}
                formatter={(value: number) => [formatCost(value), "花费"]}
              />
              <Area
                type="monotone"
                dataKey="cost"
                stroke="#22c55e"
                fill="#22c55e"
                fillOpacity={0.2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Cache hit rate trend by model */}
      {cacheTrend.rows.length > 0 && cacheTrend.models.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4 mb-6">
          <div className="flex items-start justify-between mb-1">
            <div>
              <h2 className="text-sm font-medium">
                缓存命中率走势
                <span className="text-xs text-muted-foreground ml-2">({granularityLabel})</span>
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                横线为 60% 经验值。点击下方模型胶囊隐藏/显示对应曲线。
              </p>
            </div>
          </div>

          {/* Clickable custom legend */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {cacheTrend.models.map((m, idx) => {
              const hidden = hiddenModels.has(m);
              const color = modelColor(m, idx);
              return (
                <button
                  key={m}
                  onClick={() =>
                    setHiddenModels((prev) => {
                      const next = new Set(prev);
                      if (next.has(m)) next.delete(m);
                      else next.add(m);
                      return next;
                    })
                  }
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
                    hidden
                      ? "border-border bg-muted/30 text-muted-foreground"
                      : "border-border bg-background hover:bg-accent text-foreground"
                  }`}
                  title={hidden ? "显示" : "隐藏"}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: hidden ? "transparent" : color, borderColor: color, borderWidth: 1, borderStyle: "solid" }}
                  />
                  <span className="font-mono">{m}</span>
                  {hidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
              );
            })}
            {hiddenModels.size > 0 && (
              <button
                onClick={() => setHiddenModels(new Set())}
                className="text-[11px] text-primary hover:underline ml-1"
              >
                全部显示
              </button>
            )}
          </div>

          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={cacheTrend.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickFormatter={(v) => `${v}%`}
                domain={[0, 100]}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "6px",
                  fontSize: 12,
                }}
                formatter={(value: number, name: string) => [
                  `${value.toFixed(1)}%`,
                  name,
                ]}
              />
              <ReferenceLine y={60} stroke="#ef4444" strokeDasharray="4 4" label={{ value: "60%", position: "right", fill: "#ef4444", fontSize: 10 }} />
              {visibleModels.map((m) => (
                <Line
                  key={m}
                  type="monotone"
                  dataKey={m}
                  stroke={modelColor(m, cacheTrend.models.indexOf(m))}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Project cost ranking */}
      {!projectCostsLoading && topProjects.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4 mb-6">
          <h2 className="text-sm font-medium mb-1 flex items-center gap-1.5">
            <FolderOpen className="w-4 h-4" />
            项目花费排行 (Top 10)
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            点击柱形过滤到该项目的逐请求账单。
          </p>
          <ResponsiveContainer width="100%" height={Math.max(40 + topProjects.length * 26, 200)}>
            <BarChart
              data={topProjects}
              layout="vertical"
              margin={{ top: 0, right: 30, bottom: 0, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
              <XAxis
                type="number"
                tickFormatter={(v) => formatCost(v)}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              />
              <YAxis
                type="category"
                dataKey="shortName"
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                width={140}
                tickFormatter={(v) =>
                  typeof v === "string" && v.length > 18 ? `${v.slice(0, 16)}…` : v
                }
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "6px",
                  fontSize: 12,
                }}
                labelFormatter={
                  // recharts Tooltip 的 labelFormatter 签名被泛型推断成
                  // `Payload<number, "花费">[]`，和我们想直接读 payload.displayName
                  // 的写法不兼容。这里整体 cast any 绕过 —— payload 上确实有
                  // 我们 BarChart data 里塞进去的 displayName 字段。
                  (((_label: unknown, items: any[]) =>
                    items?.[0]?.payload?.displayName ?? "") as any)
                }
                formatter={(value: number, _name: string, item) => [
                  `${formatCost(value)} · ${item?.payload?.requestCount ?? 0} 次请求`,
                  "花费",
                ]}
              />
              <Bar
                dataKey="costUsd"
                fill="#22c55e"
                radius={[0, 4, 4, 0]}
                cursor="pointer"
                onClick={(payload) => {
                  const pid = (payload as { payload?: { projectId?: string } })
                    ?.payload?.projectId;
                  if (pid) {
                    navigate(`/stats/requests?projectId=${encodeURIComponent(pid)}`);
                  }
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Model breakdown */}
      {modelBreakdown.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4">
          <h2 className="text-sm font-medium mb-4">
            模型用量分布
            <span className="text-xs font-normal text-muted-foreground ml-1">（按比例估算）</span>
          </h2>
          <div className="space-y-3">
            {modelBreakdown.map(({ model, tokens, cost, pct }) => (
              <div key={model}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-mono text-xs truncate mr-2">{model}</span>
                  <span className="text-muted-foreground text-xs shrink-0">
                    {formatTokens(tokens)} · {formatCost(cost)} ({pct}%)
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className="bg-primary rounded-full h-2 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 text-muted-foreground mb-2">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${accent ?? ""}`}>{value}</div>
    </div>
  );
}
