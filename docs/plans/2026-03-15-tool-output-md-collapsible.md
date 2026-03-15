# Tool Output 折叠 + MD 渲染 + ToolViewer 换行 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为历史记录页的 Tool Output 区域添加折叠、MD/源码切换，同时修复 ToolViewer 代码视图中超长字符串的水平溢出问题。

**Architecture:** 提取 MarkdownContent 为独立共享组件；ToolOutputMessage 增加 viewMode / expanded 双 state，标题栏常驻切换控件；ToolViewer 代码视图加 wrapLongLines 一个 prop。

**Tech Stack:** React 19, TypeScript, Tailwind CSS, react-markdown, remark-gfm, react-syntax-highlighter (oneDark), lucide-react

---

## 上下文速查

| 组件 | 路径 |
|------|------|
| 工具输出（历史） | `src/components/message/ToolOutputMessage.tsx` |
| 工具调用查看器 | `src/components/chat/tool-viewers/ToolViewers.tsx` |
| 共享工具函数 | `src/components/message/utils.ts` |
| 新建共享 MD 组件 | `src/components/message/MarkdownContent.tsx` ← 新建 |

ToolOutputMessage 渲染两种 block：
- `block.type === "tool_result"` → `block.content: string, block.isError: boolean`
- `block.type === "function_call_output"` → `block.output: string`

---

## Task 1：提取 MarkdownContent 为共享组件

**Files:**
- Create: `src/components/message/MarkdownContent.tsx`

**Step 1: 新建文件，粘贴提取自 ToolViewers.tsx 的 MarkdownContent**

从 `ToolViewers.tsx` 第 69-128 行复制 MarkdownContent 函数，改为独立文件并 export：

```tsx
// src/components/message/MarkdownContent.tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="p-3 prose prose-sm max-w-none text-xs leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children }) {
            const match = /language-(\w+)/.exec(className || "");
            const codeStr = String(children).replace(/\n$/, "");
            if (match) {
              return (
                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                  className="rounded text-[11px] !mt-1.5 !mb-1.5"
                >
                  {codeStr}
                </SyntaxHighlighter>
              );
            }
            return (
              <code className="bg-muted px-1 py-0.5 rounded text-[11px] font-mono">
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <div className="not-prose my-1.5">{children}</div>;
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="min-w-full text-xs border-collapse border border-border rounded">
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="bg-muted/50 px-3 py-1.5 text-left text-xs font-medium border border-border">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="px-3 py-1.5 text-xs border border-border">
                {children}
              </td>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
```

**Step 2: 验证文件语法正确**

检查 import 路径与 `tsconfig.json` 的 paths 配置一致，无红线。

**Step 3: 在 ToolViewers.tsx 替换本地定义**

在 `src/components/chat/tool-viewers/ToolViewers.tsx`：

- 删除第 69-128 行的本地 `function MarkdownContent(...)` 定义
- 在文件顶部 import 区新增：

```tsx
import { MarkdownContent } from "../../message/MarkdownContent";
```

（相对路径：`tool-viewers/` → `../../message/`）

**Step 4: 确认 ToolViewers.tsx 中调用 MarkdownContent 的两处（ReadContent 和 WriteContent）无报错**

**Step 5: Commit**

```bash
git add src/components/message/MarkdownContent.tsx src/components/chat/tool-viewers/ToolViewers.tsx
git commit -m "refactor: extract MarkdownContent to shared component"
```

---

## Task 2：ToolViewer 代码视图加 wrapLongLines

**Files:**
- Modify: `src/components/chat/tool-viewers/ToolViewers.tsx`（code 模式 SyntaxHighlighter，约第 286 行）

**Step 1: 找到 code 模式的 SyntaxHighlighter**

在 `ToolViewers.tsx` 中搜索 `viewMode === "code"` 对应的 SyntaxHighlighter，大约在：

```tsx
<SyntaxHighlighter
  style={oneDark}
  language="json"
  customStyle={{ margin: 0, borderRadius: 0, fontSize: "11px", maxHeight: "24rem" }}
>
```

**Step 2: 加 wrapLongLines prop**

```tsx
<SyntaxHighlighter
  style={oneDark}
  language="json"
  wrapLongLines={true}
  customStyle={{ margin: 0, borderRadius: 0, fontSize: "11px", maxHeight: "24rem" }}
>
```

**Step 3: 手动验证**

启动 `npx tauri dev`，找一条含大段文本的 Write/Read 工具调用，切换到代码视图，确认超长字符串按容器宽度换行，不出现水平滚动条。

**Step 4: Commit**

```bash
git add src/components/chat/tool-viewers/ToolViewers.tsx
git commit -m "fix: wrap long lines in ToolViewer code view"
```

---

## Task 3：ToolOutputMessage 重构

**Files:**
- Modify: `src/components/message/ToolOutputMessage.tsx`

### 目标效果

```
┌────────────────────────────────────────────────────────┐
│ >_ Tool Output  21:32:01        [<>] [MD]  [∨]        │
├────────────────────────────────────────────────────────┤
│ File created successfully at: C:\...                   │  ← 展开时显示
└────────────────────────────────────────────────────────┘
```

- 内容 ≤ 400 chars：默认展开
- 内容 > 400 chars：默认折叠，标题栏显示"N 字符"
- `<>` / `MD` tab 式切换按钮，始终可见
- 两种 block 类型（`tool_result` / `function_call_output`）复用同一个 `<OutputBlock>` 子组件

### Step 1: 重写 ToolOutputMessage.tsx

完整替换文件内容如下：

```tsx
import { useState } from "react";
import type { DisplayMessage } from "../../types";
import { Terminal, ChevronDown, ChevronRight, Code, FileText } from "lucide-react";
import { formatTime, stripAnsi } from "./utils";
import { MarkdownContent } from "./MarkdownContent";

interface Props {
  message: DisplayMessage;
  showTimestamp: boolean;
}

const COLLAPSE_THRESHOLD = 400;

/* ── 单个输出块（source / md 切换 + 折叠） ──────────── */

function OutputBlock({
  content,
  isError = false,
}: {
  content: string;
  isError?: boolean;
}) {
  const isLong = content.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);
  const [viewMode, setViewMode] = useState<"source" | "md">("source");

  return (
    <div className={`mt-1 border rounded-md overflow-hidden ${
      isError ? "border-destructive/30" : "border-border"
    }`}>
      {/* 标题栏 */}
      <div className={`flex items-center gap-1 px-2 py-1 text-xs ${
        isError ? "bg-destructive/5" : "bg-muted/30"
      }`}>
        {/* 折叠/展开主区域 */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />
          )}
          {!expanded && (
            <span className="text-muted-foreground truncate">
              {content.length} 字符
            </span>
          )}
        </button>

        {/* <> / MD 切换 */}
        <div className="flex shrink-0 rounded overflow-hidden border border-border/50">
          <button
            onClick={() => setViewMode("source")}
            className={`flex items-center gap-1 px-1.5 py-0.5 transition-colors ${
              viewMode === "source"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="源码"
          >
            <Code className="w-3 h-3" />
            <span className="text-[10px]">&lt;/&gt;</span>
          </button>
          <button
            onClick={() => setViewMode("md")}
            className={`flex items-center gap-1 px-1.5 py-0.5 transition-colors ${
              viewMode === "md"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Markdown 渲染"
          >
            <FileText className="w-3 h-3" />
            <span className="text-[10px]">MD</span>
          </button>
        </div>
      </div>

      {/* 内容区 */}
      {expanded && (
        <div className="border-t border-border">
          {viewMode === "md" ? (
            <MarkdownContent content={content} />
          ) : (
            <pre
              className={`px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all
                max-h-80 overflow-y-auto ${
                isError
                  ? "text-destructive bg-destructive/5"
                  : "text-muted-foreground"
              }`}
            >
              {content.length > 10000
                ? content.slice(0, 10000) + "\n... (truncated)"
                : content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ── ToolOutputMessage ───────────────────────────────── */

export function ToolOutputMessage({ message, showTimestamp }: Props) {
  return (
    <div className="flex gap-3 ml-10">
      <div className="flex-1 min-w-0">
        {/* 标题行 */}
        <div className="flex items-center gap-2 mb-1">
          <Terminal className="w-3 h-3 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Tool Output</span>
          {showTimestamp && message.timestamp && (
            <span className="text-xs text-muted-foreground">
              {formatTime(message.timestamp)}
            </span>
          )}
        </div>

        {/* 输出块 */}
        {message.content.map((block, i) => {
          if (block.type === "function_call_output") {
            const output = stripAnsi(block.output);
            return <OutputBlock key={i} content={output} />;
          }
          if (block.type === "tool_result") {
            const cleaned = stripAnsi(block.content);
            return <OutputBlock key={i} content={cleaned} isError={block.isError} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
```

**Step 2: 验证 TypeScript 类型**

检查 `block.output`（`function_call_output`）和 `block.content` / `block.isError`（`tool_result`）字段是否与 `src/types/` 中的类型定义匹配。若字段名不符，按实际类型定义调整。

> 查看类型定义：`src/types/index.ts` 或 `src/types.ts`，找 `DisplayContentBlock` 的 union 类型。

**Step 3: 手动验证**

启动 `npx tauri dev`，打开含 Tool Output 的历史会话，验证：

| 场景 | 预期 |
|------|------|
| 内容 ≤ 400 chars（如"File created successfully"） | 默认展开，显示内容 |
| 内容 > 400 chars | 默认折叠，显示"N 字符" |
| 点击折叠区域 | 正确切换展开/收起 |
| 点击 `</>` 按钮 | 显示原始文本 pre 块 |
| 点击 `MD` 按钮 | 显示 Markdown 渲染结果 |
| `tool_result` isError = true | 红色边框和背景 |
| 内容含 Markdown（# 标题、\| 表格） | MD 模式正确渲染 |

**Step 4: Commit**

```bash
git add src/components/message/ToolOutputMessage.tsx
git commit -m "feat: add collapsible and MD/source toggle to ToolOutputMessage"
```

---

## 验收清单

- [ ] Task 1：`MarkdownContent.tsx` 已创建，`ToolViewers.tsx` 中本地定义已删除，无编译错误
- [ ] Task 2：ToolViewer 代码视图超长字符串按容器宽度换行
- [ ] Task 3：Tool Output 默认折叠（长内容）、展开、MD 渲染、源码查看均正常
- [ ] 无 TypeScript 错误（`npx tsc --noEmit`）
- [ ] 无 Tailwind 异常样式
