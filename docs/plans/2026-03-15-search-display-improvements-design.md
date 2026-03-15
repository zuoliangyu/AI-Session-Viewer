# 设计文档：搜索增强 + 对话显示优化

日期：2026-03-15

## 背景

在 Rocky Linux 9 环境下发现以下问题，需要修复或增强：

1. AI 回答中出现 ANSI 转义码等特殊字符，显示不清晰
2. 搜索-会话视图缺少总消息数、无法复制会话名、点击后不跳转匹配消息
3. 全局搜索无法匹配会话名称（alias / firstPrompt）
4. 删除会话功能已存在于 SessionsPage，无需新增

---

## Feature 1：对话显示优化——清理特殊字符

### 根因
工具输出（Bash 命令结果、terminal stdout）包含 ANSI 转义码（如 `\x1b[32m`、`\x1b[0m`），这些码在 `<pre>` 标签中以原始字符形式显示，导致输出混乱不清晰。

### 方案
- 在 `src/components/message/utils.ts` 添加 `stripAnsi(text: string): string` 工具函数
- 正则：`/\x1b\[[0-9;]*[mGKHFABCDJKST]/g`（覆盖颜色码、光标控制、擦除指令等常见序列）
- 应用位置：
  - `ToolOutputMessage.tsx`：`tool_result.content` 和 `function_call_output.output`
  - `AssistantMessage.tsx`：`ToolCallBlock.input` 和 `FunctionCallBlock.arguments`
  - `AssistantMessage.tsx`：text block 传入 ReactMarkdown 前

---

## Feature 2：搜索-会话视图改进

### 2a：每个会话显示总消息数

**后端变更（`crates/session-core/src/search.rs`）**
- `SearchResult` struct 新增 `total_message_count: u32`
- `search_claude`：进入 `parse_all_messages` 后立即记录 `let total = messages.len() as u32`，注入每条结果
- `search_codex`：同上

**前端变更（`src/types/index.ts`）**
- `SearchResult` 接口新增 `totalMessageCount: number`

**前端变更（`src/components/search/SearchPage.tsx`）**
- `groupedSessions` 新增 `totalMessageCount: number` 字段（取第一条结果的值）
- 会话卡片显示：`{session.matchCount} 条匹配 / 共 {session.totalMessageCount} 条`

### 2b：可复制会话名

**前端变更（`src/components/search/SearchPage.tsx`）**
- 在会话卡片标题行右侧添加 Copy 图标按钮
- `onClick: e.stopPropagation()` + `navigator.clipboard.writeText(alias || firstPrompt || '')`
- 短暂显示"已复制"反馈（2 秒后恢复）

### 2c：点击跳转到第一条匹配消息

**后端变更（`crates/session-core/src/search.rs`）**
- `SearchResult` struct 新增 `matched_message_id: Option<String>`
- `search_claude`：匹配时记录 `msg.uuid.clone()` 注入结果
- `search_codex`：同上

**前端变更（`src/types/index.ts`）**
- `SearchResult` 接口新增 `matchedMessageId: string | null`

**前端变更（`src/components/search/SearchPage.tsx`）**
- `groupedSessions` 新增 `firstMatchedMessageId: string | null`（取第一条有 UUID 的结果）
- 会话卡片点击时：若有 `firstMatchedMessageId`，导航到 `?scrollTo=<uuid>`
  - MessagesPage 已原生支持 `scrollTo` 参数（高亮 + 滚动到目标消息）

---

## Feature 3：搜索会话名称

### 方案
**后端变更（`crates/session-core/src/search.rs`）**
- 在 `search_claude` 每个会话处理块内，检查 alias 和 first_prompt 是否包含 `query_lower`
- 若匹配：插入一条 `role: "session"` 的 SearchResult，`matched_text` 为匹配的名称
- 时序：在进入消息循环**之前**先检查 alias；first_prompt 在消息循环中首次计算到时检查
- 去重：使用 `session_name_matched: bool` 标志避免同一会话插入两次会话名匹配结果
- `search_codex`：同上

**前端变更（`src/components/search/SearchPage.tsx`）**
- Message 模式：`role: "session"` 结果以 `MessagesSquare` 图标展示，区别于普通消息
- Session 模式：`role: "session"` 结果参与 groupedSessions 聚合（match 算一条），不影响现有逻辑

---

## 涉及文件

| 文件 | 变更类型 |
|------|---------|
| `crates/session-core/src/search.rs` | 修改：新增 struct 字段 + 会话名搜索逻辑 |
| `src/types/index.ts` | 修改：SearchResult 接口新增字段 |
| `src/components/message/utils.ts` | 修改：新增 `stripAnsi` 函数 |
| `src/components/message/ToolOutputMessage.tsx` | 修改：应用 stripAnsi |
| `src/components/message/AssistantMessage.tsx` | 修改：应用 stripAnsi |
| `src/components/search/SearchPage.tsx` | 修改：消息数 + 复制按钮 + 跳转 UUID + session role 展示 |

---

## 不在本次范围内

- 删除会话：已在 SessionsPage 实现，用户确认无需扩展
- Rocky Linux 专属构建：现有 musl 静态二进制已覆盖
