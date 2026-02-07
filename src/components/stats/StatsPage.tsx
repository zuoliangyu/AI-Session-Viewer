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
  const { stats, tokenSummary, statsLoading, loadStats } = useAppStore();

  useEffect(() => {
    loadStats();
  }, []);

  if (statsLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        加载统计数据...
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="p-6 text-muted-foreground">
        未找到统计数据。请确认 ~/.claude/stats-cache.json 文件存在。
      </div>
    );
  }

  // Calculate totals
  const totalMessages = stats.dailyActivity.reduce(
    (sum, d) => sum + d.messageCount,
    0
  );
  const totalSessions = stats.dailyActivity.reduce(
    (sum, d) => sum + d.sessionCount,
    0
  );
  const totalToolCalls = stats.dailyActivity.reduce(
    (sum, d) => sum + d.toolCallCount,
    0
  );

  // Format token count for display
  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  };

  // Prepare chart data
  const activityData = stats.dailyActivity.map((d) => ({
    date: d.date.slice(5), // "MM-DD"
    messages: d.messageCount,
    sessions: d.sessionCount,
    tools: d.toolCallCount,
  }));

  const tokenData = tokenSummary?.dailyTokens.map((d) => ({
    date: d.date.slice(5),
    tokens: d.tokens,
  })) || [];

  // Model breakdown
  const modelBreakdown = tokenSummary
    ? Object.entries(tokenSummary.tokensByModel)
        .sort(([, a], [, b]) => b - a)
        .map(([model, tokens]) => ({
          model: model.replace("claude-", "").replace(/-\d+$/, ""),
          tokens,
          pct: ((tokens / tokenSummary.totalTokens) * 100).toFixed(1),
        }))
    : [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">使用统计</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          icon={<MessageSquare className="w-5 h-5" />}
          label="总消息数"
          value={totalMessages.toLocaleString()}
        />
        <StatCard
          icon={<Calendar className="w-5 h-5" />}
          label="总会话数"
          value={totalSessions.toLocaleString()}
        />
        <StatCard
          icon={<Zap className="w-5 h-5" />}
          label="工具调用"
          value={totalToolCalls.toLocaleString()}
        />
        <StatCard
          icon={<Activity className="w-5 h-5" />}
          label="总 Token"
          value={formatTokens(tokenSummary?.totalTokens || 0)}
        />
      </div>

      {/* Activity chart */}
      <div className="bg-card border border-border rounded-lg p-4 mb-6">
        <h2 className="text-sm font-medium mb-4">每日活动</h2>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={activityData}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "6px",
                fontSize: 12,
              }}
            />
            <Bar dataKey="messages" fill="#3b82f6" name="消息" radius={[2, 2, 0, 0]} />
            <Bar dataKey="tools" fill="#f59e0b" name="工具调用" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Token usage chart */}
      {tokenData.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4 mb-6">
          <h2 className="text-sm font-medium mb-4">Token 用量趋势</h2>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={tokenData}>
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
                dataKey="tokens"
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
