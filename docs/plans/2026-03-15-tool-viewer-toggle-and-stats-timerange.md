# Tool Viewer Code/Preview Toggle + Stats Time Range Filter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在工具调用展开区域旁添加 Code/Preview 切换按钮（显示原始 JSON），并为用量统计页面添加时间段过滤（快捷按钮 + 自定义日期范围）。

**Architecture:** 两个功能均为纯前端修改，不涉及后端。Task 1 修改 `ToolViewers.tsx`，在 `ToolViewer` 组件 header 增加 `Code2` 图标按钮，通过 `viewMode` 状态控制展开区域渲染。Task 2 修改 `StatsPage.tsx`，用 `useMemo` 派生过滤后的聚合数据，后端 `TokenUsageSummary` 结构不变。

**Tech Stack:** React + TypeScript + Tailwind CSS + lucide-react + react-syntax-highlighter（已有依赖）

---

### Task 1: 工具调用 Code/Preview 切换

**Files:**
- Modify: `src/components/chat/tool-viewers/ToolViewers.tsx`（主要改动区域：`ToolViewer` 函数，约第 208-252 行）

---

**Step 1: 在 import 列表中添加 `Code2` 图标**

找到文件顶部 import 块（第 1-15 行），在 lucide-react 的 import 中加入 `Code2`：

```typescript
import {
  FileText,
  Pencil,
  FilePlus,
  Terminal,
  Search,
  FolderSearch,
  Globe,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  AlertCircle,
  Code2,
} from "lucide-react";
```

---

**Step 2: 修改 `ToolViewer` 函数，增加 `viewMode` 状态**

找到 `ToolViewer` 函数（第 208 行），修改状态声明部分：

```typescript
export function ToolViewer({ name, input, result }: ToolViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const parsed = useMemo(() => tryParseJson(input), [input]);
  const summary = useMemo(() => toolSummary(name, parsed), [name, parsed]);
  const hasError = result?.isError ?? false;
```

---

**Step 3: 修改 Header 按钮区域，添加 `<>` 切换按钮**

找到 `ToolViewer` 函数中的 header `<button>` 元素（第 221-242 行），将整个 header 区域替换为：

```tsx
  return (
    <div
      className={`mt-2 mb-2 border rounded-md overflow-hidden ${
        hasError ? "border-red-500/30" : "border-border"
      }`}
    >
      {/* Header */}
      <div
        className={`flex items-center text-xs transition-colors ${
          hasError
            ? "bg-red-500/5 hover:bg-red-500/10"
            : "bg-muted/50 hover:bg-muted"
        }`}
      >
        {/* 主点击区域：展开/折叠 */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 flex items-center gap-2 px-3 py-2 min-w-0"
        >
          {toolIcon(name) || <div className="w-3.5 h-3.5" />}
          <span className="font-mono font-medium">{name}</span>
          {summary && (
            <span className="text-muted-foreground truncate max-w-[20rem]">
              {summary}
            </span>
          )}
          {hasError && <AlertCircle className="w-3 h-3 text-red-400" />}
        </button>

        {/* Code/Preview 切换按钮 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!expanded) {
              setExpanded(true);
              setViewMode("code");
            } else {
              setViewMode(viewMode === "code" ? "preview" : "code");
            }
          }}
          className={`shrink-0 px-2 py-2 transition-colors ${
            viewMode === "code" && expanded
              ? "text-blue-400"
              : "text-muted-foreground hover:text-foreground"
          }`}
          title={viewMode === "code" ? "切换到预览模式" : "切换到原始 JSON"}
        >
          <Code2 className="w-3.5 h-3.5" />
        </button>

        {/* 折叠/展开箭头 */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 px-2 py-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </button>
      </div>
```

---

**Step 4: 修改展开内容区域，支持 code 模式渲染**

找到 `ToolViewer` 函数中展开内容的 `{expanded && ...}` 部分（第 245-250 行），替换为：

```tsx
      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border">
          {viewMode === "code" ? (
            <div className="relative group">
              <div className="absolute right-2 top-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                <CopyButton text={input} />
              </div>
              <SyntaxHighlighter
                style={oneDark}
                language="json"
                customStyle={{ margin: 0, borderRadius: 0, fontSize: "11px", maxHeight: "24rem" }}
              >
                {input.length > 15000
                  ? input.slice(0, 15000) + "\n... (truncated)"
                  : input}
              </SyntaxHighlighter>
            </div>
          ) : (
            <ToolContent name={name} parsed={parsed} rawInput={input} result={result} />
          )}
        </div>
      )}
    </div>
  );
}
```

---

**Step 5: 编译验证**

代码修改完毕后，请运行以下命令验证无类型错误：

```bash
npx tsc --noEmit
```

预期输出：无错误

---

**Step 6: 提交**

```bash
git add src/components/chat/tool-viewers/ToolViewers.tsx
git commit -m "feat: add code/preview toggle button to ToolViewer"
```

---

### Task 2: 用量统计时间段过滤

**Files:**
- Modify: `src/components/stats/StatsPage.tsx`

**背景说明：**
- `tokenSummary.dailyTokens` 是 `DailyTokenEntry[]`，每项有 `date`（`YYYY-MM-DD`）、`inputTokens`、`outputTokens`、`totalTokens`
- `tokenSummary.tokensByModel` 是全量的 `Record<string, number>`，无法精确按时间过滤，采用按 token 比例缩放
- `dailyActivity`（会话数/消息数）也在 `tokenSummary` 中没有直接暴露；检查后端返回结构

---

**Step 1: 检查 `TokenUsageSummary` 的 TypeScript 类型定义**

找到前端类型定义文件，确认 `tokenSummary` 的形状：

```bash
grep -r "TokenUsageSummary\|dailyTokens\|tokenSummary" src/types.ts src/stores/ --include="*.ts" -l
```

然后阅读对应文件，确认是否有 `dailyActivity` 字段（`session_count`/`message_count` 按日）。

> **如果没有 `dailyActivity`：** 会话数和消息数保持展示全量（不随时间段变化），在 StatCard 上加小标注"（全量）"。

---

**Step 2: 在 `StatsPage.tsx` 顶部添加时间范围状态**

找到 `StatsPage` 函数开头的 `const { source, tokenSummary, ... } = useAppStore();` 行，在其下方添加：

```typescript
  type TimePreset = "today" | "week" | "month" | "30d" | "all" | "custom";
  const [preset, setPreset] = useState<TimePreset>("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
```

同时在文件顶部的 `import { useEffect } from "react";` 改为：

```typescript
import { useEffect, useState, useMemo } from "react";
```

---

**Step 3: 实现 `getDateRange` 辅助函数（放在组件外）**

在 `StatsPage` 函数**上方**（`export function StatsPage()` 前）添加：

```typescript
function getDateRange(
  preset: string,
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
      d.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
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
```

---

**Step 4: 在 `StatsPage` 中添加 `filteredSummary` useMemo**

在 `const formatTokens = ...` 行**上方**，添加：

```typescript
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

    // tokensByModel 按比例缩放
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
```

---

**Step 5: 添加时间段选择 UI**

找到 `return (` 后的 `<div className="p-6 max-w-6xl mx-auto">` 和 `<h1>` 标签，在 `<h1>` **下方**（`{/* Summary cards */}` 前）插入时间段过滤器：

```tsx
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
          onChange={(e) => { setCustomStart(e.target.value); setPreset("custom"); }}
          className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground"
        />
        <span className="text-xs text-muted-foreground">~</span>
        <input
          type="date"
          value={customEnd}
          onChange={(e) => { setCustomEnd(e.target.value); setPreset("custom"); }}
          className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground"
        />
      </div>
```

---

**Step 6: 将 StatCard 和图表的数据源替换为 `filteredTotals` / `filteredDays`**

找到 Summary cards 区域（第 86-107 行），将数据来源替换：

```tsx
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
          value={formatTokens(filteredTotals.totalInputTokens)}
        />
        <StatCard
          icon={<Activity className="w-5 h-5" />}
          label="总 Token"
          value={formatTokens(filteredTotals.totalTokens)}
        />
```

> 注：会话数/消息数保持全量（`tokenSummary.sessionCount`），因后端未按日返回细分数据。

找到图表数据（第 57-62 行的 `dailyData`），改为使用 `filteredDays`：

```typescript
  const dailyData = filteredDays.map((d) => ({
    date: d.date.slice(5), // "MM-DD"
    input: d.inputTokens,
    output: d.outputTokens,
    total: d.totalTokens,
  }));
```

找到模型分布（第 65-74 行的 `modelBreakdown`），改为使用 `filteredTotals.tokensByModel`：

```typescript
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
```

---

**Step 7: 编译验证**

```bash
npx tsc --noEmit
```

预期输出：无错误

---

**Step 8: 提交**

```bash
git add src/components/stats/StatsPage.tsx
git commit -m "feat: add time range filter to stats page"
```

---

## 完成标准

1. 工具调用展开时，header 右侧有 `<>` 图标，点击切换 Code/Preview，Code 模式显示原始 JSON（语法高亮）
2. 统计页面有 5 个快捷时间段按钮 + 自定义日期输入，切换后所有数字和图表实时更新
3. `npx tsc --noEmit` 无报错
4. `cargo clippy --workspace -- -D warnings` 无报错（本次未改 Rust 代码，但确认无意外影响）
