import { useEffect } from "react";
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

export function StatsPage() {
  const { source, tokenSummary, statsLoading, loadStats } = useAppStore();

  useEffect(() => {
    loadStats();
  }, [source]);

  if (statsLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        加载统计数据...
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
  const dailyData = tokenSummary.dailyTokens.map((d) => ({
    date: d.date.slice(5), // "MM-DD"
    input: d.inputTokens,
    output: d.outputTokens,
    total: d.totalTokens,
  }));

  // Model breakdown
  const modelBreakdown = Object.entries(tokenSummary.tokensByModel)
    .sort(([, a], [, b]) => b - a)
    .map(([model, tokens]) => ({
      model,
      tokens,
      pct:
        tokenSummary.totalTokens > 0
          ? ((tokens / tokenSummary.totalTokens) * 100).toFixed(1)
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

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          icon={<Calendar className="w-5 h-5" />}
          label="总会话数"
          value={tokenSummary.sessionCount.toLocaleString()}
        />
        <StatCard
          icon={<MessageSquare className="w-5 h-5" />}
          label="总消息数"
          value={tokenSummary.messageCount.toLocaleString()}
        />
        <StatCard
          icon={<Zap className="w-5 h-5" />}
          label="输入 Token"
          value={formatTokens(tokenSummary.totalInputTokens)}
        />
        <StatCard
          icon={<Activity className="w-5 h-5" />}
          label="总 Token"
          value={formatTokens(tokenSummary.totalTokens)}
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
          <h2 className="text-sm font-medium mb-4">模型用量分布</h2>
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
