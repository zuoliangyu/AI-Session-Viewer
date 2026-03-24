import { useEffect, useState, useMemo } from "react";
import { useAppStore } from "../../stores/appStore";
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
} from "recharts";
import {
  MessageSquare,
  Zap,
  Activity,
  Loader2,
  Calendar,
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

export function StatsPage() {
  const { source, tokenSummary, statsLoading, statsIsFirstBuild, loadStats } = useAppStore();
  const [preset, setPreset] = useState<TimePreset>("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  useEffect(() => {
    loadStats();
  }, [source]);

  const { start, end } = useMemo(
    () => getDateRange(preset, customStart, customEnd),
    [preset, customStart, customEnd]
  );

  const filteredDays = useMemo(() => {
    if (!tokenSummary) return [];
    const days = tokenSummary.dailyTokens;
    if (!start && !end) return days;
    return days.filter(
      (d) => (!start || d.date >= start) && (!end || d.date <= end)
    );
  }, [tokenSummary, start, end]);

  const filteredTotals = useMemo(() => {
    const totalTokens = filteredDays.reduce((s, d) => s + d.totalTokens, 0);
    const totalInputTokens = filteredDays.reduce((s, d) => s + d.inputTokens, 0);
    const totalOutputTokens = filteredDays.reduce((s, d) => s + d.outputTokens, 0);

    const ratio =
      tokenSummary && tokenSummary.totalTokens > 0
        ? totalTokens / tokenSummary.totalTokens
        : 0;
    const tokensByModel: Record<string, number> = {};
    if (tokenSummary) {
      for (const [model, tokens] of Object.entries(tokenSummary.tokensByModel)) {
        tokensByModel[model] = Math.round(tokens * ratio);
      }
    }

    return { totalTokens, totalInputTokens, totalOutputTokens, tokensByModel };
  }, [filteredDays, tokenSummary]);

  if (statsLoading) {
    // statsIsFirstBuild === null means "unknown" (loading hasn't finished yet to tell us)
    // We only know it's a first build AFTER completion, so on next load statsIsFirstBuild
    // will be false (cached). Show hint when: null (unknown = possibly first time) or true.
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

  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  };

  // Daily token chart data
  const dailyData = filteredDays.map((d) => ({
    date: d.date.slice(5), // "MM-DD"
    input: d.inputTokens,
    output: d.outputTokens,
    total: d.totalTokens,
  }));

  // Model breakdown
  const modelBreakdown = Object.entries(filteredTotals.tokensByModel)
    .sort(([, a], [, b]) => b - a)
    .map(([model, tokens]) => ({
      model,
      tokens,
      pct:
        filteredTotals.totalTokens > 0
          ? ((tokens / filteredTotals.totalTokens) * 100).toFixed(1)
          : "0",
    }));

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">
        使用统计
        <span className="text-sm font-normal text-muted-foreground ml-2">
          ({source === "claude" ? "Claude" : "Codex"})
        </span>
      </h1>

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
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          icon={<Calendar className="w-5 h-5" />}
          label="总会话数（全期）"
          value={tokenSummary.sessionCount.toLocaleString()}
        />
        <StatCard
          icon={<MessageSquare className="w-5 h-5" />}
          label="总消息数（全期）"
          value={tokenSummary.messageCount.toLocaleString()}
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

      {/* Daily token chart */}
      {dailyData.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4 mb-6">
          <h2 className="text-sm font-medium mb-4">每日 Token 用量</h2>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="date"
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
                formatter={(value: number, name: string) => [
                  formatTokens(value),
                  name === "input" ? "输入" : name === "output" ? "输出" : "总计",
                ]}
              />
              <Bar dataKey="input" fill="#3b82f6" name="input" radius={[2, 2, 0, 0]} stackId="a" />
              <Bar dataKey="output" fill="#f59e0b" name="output" radius={[2, 2, 0, 0]} stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Token trend */}
      {dailyData.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4 mb-6">
          <h2 className="text-sm font-medium mb-4">Token 用量趋势</h2>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="date"
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
                formatter={(value: number) => [formatTokens(value), "Tokens"]}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke="#8b5cf6"
                fill="#8b5cf6"
                fillOpacity={0.2}
              />
            </AreaChart>
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
            {modelBreakdown.map(({ model, tokens, pct }) => (
              <div key={model}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-mono text-xs">{model}</span>
                  <span className="text-muted-foreground text-xs">
                    {formatTokens(tokens)} ({pct}%)
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
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 text-muted-foreground mb-2">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
