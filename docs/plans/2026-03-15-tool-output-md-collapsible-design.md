# 设计文档：Tool Output 折叠 + MD 渲染 + ToolViewer 换行修复

**日期**：2026-03-15
**状态**：已批准，待实现

---

## 背景

历史记录页面中，`>_ Tool Output` 区域（`ToolOutputMessage.tsx`）存在以下问题：

1. `tool_result` 块始终展开，无折叠控制，截断逻辑不统一
2. 两种 block 类型（`tool_result` / `function_call_output`）无 Markdown 渲染，输出含 MD 格式时只能看到原始文本
3. ToolViewer 代码视图（深色 JSON 块）中超长字符串不换行，出现水平滚动条

---

## 目标

- **Tool Output** 支持折叠（内容 > 400 chars 默认折叠）
- **Tool Output** 标题栏常驻 `<>` / `MD` 切换按钮，始终可在源码和 Markdown 渲染间切换
- **ToolViewer 代码视图** 超长字符串按容器宽度自动换行

---

## 方案选择

选择方案 A（统一升级 ToolOutputMessage），理由：
- 改动集中于 3 个文件，不涉及后端
- 复用现有 `MarkdownContent` 组件，无重复逻辑
- 不引入新文件

放弃方案 B（提取共享 ToolOutputBlock）：当前需求不需要跨组件复用 result 区域。
放弃方案 C（仅最小改动）：缺少 MD 渲染，体验不完整。

---

## 详细设计

### 1. 提取 `MarkdownContent` 为共享导出

**文件**：`src/components/message/utils.tsx`

将 `ToolViewers.tsx` 内部的 `MarkdownContent` 函数移至 `utils.tsx` 并 export。

`utils.tsx` 已被两个组件 import，路径天然合适，无需新建文件。

`ToolViewers.tsx` 删除本地定义，改为 import：

```ts
import { formatTime, stripAnsi, MarkdownContent } from "../message/utils";
```

（路径根据实际相对位置调整）

---

### 2. ToolOutputMessage 改造

**文件**：`src/components/message/ToolOutputMessage.tsx`

#### 2a. 标题栏新增控件

```
>_ Tool Output  21:32:01        [<>源码] [MD]  [∨折叠]
```

- `viewMode` state：`"source" | "md"`，初始值 `"source"`
- `expanded` state：内容 ≤ 400 chars 时初始 `true`，否则初始 `false`
- 切换按钮和折叠箭头始终渲染在标题栏右侧

#### 2b. 折叠策略

| 内容长度 | 默认状态 | 折叠按钮 |
|---------|---------|---------|
| ≤ 400 chars | 展开 | 可手动折叠 |
| > 400 chars | 折叠 | 显示"N 字符，点击展开" |

#### 2c. 内容区渲染

**源码模式（`<>`）**

```tsx
<pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all
                max-h-80 overflow-y-auto text-muted-foreground">
  {content.length > 10000 ? content.slice(0, 10000) + "\n... (truncated)" : content}
</pre>
```

**MD 模式**

```tsx
<MarkdownContent content={content} />
```

#### 2d. 两种 block 统一处理

`tool_result` 和 `function_call_output` 共用同一套标题栏 + 折叠 + 切换逻辑，通过提取 `<OutputBlock>` 子组件实现，减少重复代码。

---

### 3. ToolViewer 代码视图换行

**文件**：`src/components/chat/tool-viewers/ToolViewers.tsx`

在 code 模式的 `SyntaxHighlighter` 加一个 prop：

```tsx
<SyntaxHighlighter
  style={oneDark}
  language="json"
  wrapLongLines={true}          // ← 新增
  customStyle={{ margin: 0, borderRadius: 0, fontSize: "11px", maxHeight: "24rem" }}
>
```

---

## 改动文件汇总

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/components/message/utils.tsx` | 新增 export | 提取 `MarkdownContent` |
| `src/components/chat/tool-viewers/ToolViewers.tsx` | 小改 | 删本地 `MarkdownContent`，加 `wrapLongLines` |
| `src/components/message/ToolOutputMessage.tsx` | 主要改动 | 折叠 + MD/源码切换 |

**无后端改动，无新文件。**

---

## 验收标准

1. Tool Output 内容 > 400 chars 时默认折叠，点击可展开
2. 标题栏始终显示 `<>` / `MD` 切换按钮，切换后内容即时重渲染
3. MD 模式下 Markdown 格式正确渲染（标题、列表、表格、代码块）
4. 源码模式下内容完整显示，超 10000 chars 截断提示
5. ToolViewer 代码视图中超长 JSON 字符串按容器宽度换行，无水平滚动条
6. `tool_result` 和 `function_call_output` 两种 block 行为一致
