# 设计文档：工具调用 Code/Preview 切换 + 用量统计时间段过滤

**日期**：2026-03-15
**状态**：已批准

---

## 一、工具调用 Code/Preview 切换

### 背景

`ToolViewers.tsx` 中的 `ToolViewer` 展开后通过 `ToolContent` 分发到各专用渲染器（Read/Edit/Write/Bash/Grep/Glob/Default），每个渲染器都有精心设计的预览效果。部分用户希望看到原始 JSON 数据而非渲染后的视图。

### 设计目标

在工具调用折叠按钮旁边增加一个 `<>` 图标按钮，允许用户在 **Preview**（当前渲染视图）和 **Code**（原始 JSON）之间切换。

### Header UI 变更

```
┌─────────────────────────────────────────────────────────┐
│ [🔧] Read  filename.rs L10-20          [<>]  [▶]       │
└─────────────────────────────────────────────────────────┘
```

- `<>` 按钮使用 `lucide-react` 的 `Code2` 图标
- 点击行为：
  - 当前折叠 → 展开并进入 code 模式
  - 当前展开（preview）→ 切换到 code 模式
  - 当前展开（code）→ 切换回 preview 模式
- 按钮点击需 `e.stopPropagation()` 防止触发折叠/展开

### 展开区域内容

- **preview 模式**（默认）：保持现有 `ToolContent` 渲染不变
- **code 模式**：用 `SyntaxHighlighter`（oneDark 主题）渲染 `rawInput`（原始 JSON 字符串），语言设置为 `json`；超过 15000 字符时截断并提示

### 状态

```typescript
const [expanded, setExpanded] = useState(false);
const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
```

切换数据源（`setSource`）或重新加载不需要重置 viewMode（状态由各 ToolViewer 实例独立持有）。

---

## 二、用量统计时间段过滤

### 背景

`StatsPage.tsx` 目前展示全时段汇总，没有时间范围过滤。后端 `stats.rs` 已返回完整 `dailyTokens`（每日记录），以及 `dailyActivity`（每日会话/消息数）。

### 设计目标

在统计页面提供快捷时间段按钮 + 自定义日期范围输入，所有汇总数据实时响应过滤。

### UI 布局

```
使用统计 (Claude)

[ 今天 ] [ 本周 ] [ 本月 ] [ 最近30天 ] [ 全部★ ]   自定义: [____-__-__] ~ [____-__-__]
```

- 快捷按钮 5 个：今天 / 本周 / 本月 / 最近30天 / 全部（默认选中）
- 选中状态：`bg-primary text-primary-foreground`，未选中：`bg-muted text-muted-foreground`
- 自定义日期输入框：`<input type="date">`，任一填写后自动切换为"自定义"模式，清空后回到"全部"

### 数据派生（纯前端，useMemo）

```
filteredDays  = dailyTokens.filter(d => start <= d.date <= end)
filteredAct   = dailyActivity.filter(d => start <= d.date <= end)

derivedTotals = {
  totalTokens        : sum(filteredDays.totalTokens)
  totalInputTokens   : sum(filteredDays.inputTokens)
  totalOutputTokens  : sum(filteredDays.outputTokens)
  sessionCount       : sum(filteredAct.sessionCount)
  messageCount       : sum(filteredAct.messageCount)
  tokensByModel      : 按比例估算（filteredDays.total / allDays.total * tokenSummary.tokensByModel）
}
```

> `tokensByModel` 无法精确到时间段（后端 `tokensByModel` 是全量的），采用按 token 比例缩放的近似值，图表标注"模型分布（按比例估算）"。

### 状态定义

```typescript
type TimePreset = "today" | "week" | "month" | "30d" | "all" | "custom";
const [preset, setPreset] = useState<TimePreset>("all");
const [customStart, setCustomStart] = useState("");  // "YYYY-MM-DD"
const [customEnd, setCustomEnd] = useState("");      // "YYYY-MM-DD"
```

### 日期范围计算

使用纯字符串比较（格式 `YYYY-MM-DD` 可直接字典序比较），不引入新依赖：

```typescript
function getDateRange(preset: TimePreset, customStart: string, customEnd: string) {
  const today = new Date().toISOString().slice(0, 10);
  switch (preset) {
    case "today": return { start: today, end: today };
    case "week":  // 本周一 ~ 今天
    case "month": // 本月1日 ~ 今天
    case "30d":   // 今天-30天 ~ 今天
    case "all":   return { start: "", end: "" };  // 空字符串 = 不过滤
    case "custom": return { start: customStart, end: customEnd };
  }
}
```

---

## 受影响文件

| 文件 | 变更类型 |
|------|----------|
| `src/components/chat/tool-viewers/ToolViewers.tsx` | 修改：`ToolViewer` 增加 viewMode 状态和 `<>` 按钮 |
| `src/components/stats/StatsPage.tsx` | 修改：增加时间段过滤 UI 和 useMemo 派生逻辑 |

后端无需变更。
