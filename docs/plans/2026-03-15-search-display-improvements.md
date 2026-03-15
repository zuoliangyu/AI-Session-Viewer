# Search & Display Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix ANSI special characters in AI responses, enhance search-sessions view (message count, copy name, jump to match, session name search), and fix the misleading scrollbar caused by message pagination.

**Architecture:** Backend Rust changes extend `SearchResult` struct with two new fields (`total_message_count`, `matched_message_id`) and add session-name matching. Frontend changes apply ANSI stripping utilities and update SearchPage + MessagesPage UI. No new dependencies required.

**Tech Stack:** Rust (session-core crate), React + TypeScript, Tailwind CSS

---

## Task 1: Add `stripAnsi` utility and apply to tool output

**Files:**
- Modify: `src/components/message/utils.ts`
- Modify: `src/components/message/ToolOutputMessage.tsx`
- Modify: `src/components/message/AssistantMessage.tsx`

**Step 1: Add `stripAnsi` to `utils.ts`**

Open `src/components/message/utils.ts` and append at the end:

```typescript
/**
 * Remove ANSI escape codes from terminal output.
 * Covers color codes, cursor movement, erase sequences, etc.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[mGKHFABCDJKST]/g, "")
             // eslint-disable-next-line no-control-regex
             .replace(/\x1b[()][AB012]/g, "");
}
```

**Step 2: Apply `stripAnsi` in `ToolOutputMessage.tsx`**

At line 1, import `stripAnsi`:
```typescript
import { formatTime, stripAnsi } from "./utils";
```

In the `function_call_output` block (around line 27-66), change:
```typescript
const output = block.output;
```
to:
```typescript
const output = stripAnsi(block.output);
```

In the `tool_result` block (around line 68-84), change:
```typescript
{block.content.length > 2000
  ? block.content.slice(0, 2000) + "\n... (truncated)"
  : block.content}
```
to:
```typescript
{(() => {
  const cleaned = stripAnsi(block.content);
  return cleaned.length > 2000
    ? cleaned.slice(0, 2000) + "\n... (truncated)"
    : cleaned;
})()}
```

**Step 3: Apply `stripAnsi` in `AssistantMessage.tsx`**

At line 8, import `stripAnsi`:
```typescript
import { formatTime, stripAnsi } from "./utils";
```

In `ToolCallBlock` (around line 249-258), change:
```typescript
{input.length > 5000
  ? input.slice(0, 5000) + "\n... (truncated)"
  : input}
```
to:
```typescript
{(() => {
  const cleaned = stripAnsi(input);
  return cleaned.length > 5000
    ? cleaned.slice(0, 5000) + "\n... (truncated)"
    : cleaned;
})()}
```

In `FunctionCallBlock` (around line 279-288), same pattern for `args`:
```typescript
{(() => {
  const cleaned = stripAnsi(args);
  return cleaned.length > 5000
    ? cleaned.slice(0, 5000) + "\n... (truncated)"
    : cleaned;
})()}
```

Also strip in assistant text blocks (around line 143), change:
```typescript
>
  {block.text}
</ReactMarkdown>
```
to:
```typescript
>
  {stripAnsi(block.text)}
</ReactMarkdown>
```

**Step 4: Verify manually**

Start `npx tauri dev` or `cargo run -p session-web`, open a session that has bash/terminal tool output. Confirm ANSI codes no longer appear as raw text.

**Step 5: Commit**

```bash
git add src/components/message/utils.ts src/components/message/ToolOutputMessage.tsx src/components/message/AssistantMessage.tsx
git commit -m "fix: strip ANSI escape codes from tool output and assistant text"
```

---

## Task 2: Extend backend `SearchResult` with `total_message_count` and `matched_message_id`

**Files:**
- Modify: `crates/session-core/src/search.rs`

**Step 1: Add new fields to `SearchResult` struct**

In `search.rs` at the struct definition (line 9-23), add two fields:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub source: String,
    pub project_id: String,
    pub project_name: String,
    pub session_id: String,
    pub first_prompt: Option<String>,
    pub alias: Option<String>,
    pub tags: Option<Vec<String>>,
    pub matched_text: String,
    pub role: String,
    pub timestamp: Option<String>,
    pub file_path: String,
    // NEW
    pub total_message_count: u32,
    pub matched_message_id: Option<String>,
}
```

**Step 2: Update `search_claude` to populate new fields**

Inside the `if let Ok(messages) = claude::parse_all_messages(file_path)` block (around line 128), add at the top of the block:

```rust
let total_message_count = messages.len() as u32;
```

Then in the `file_results.push(SearchResult { ... })` call (around line 146-160), add the two fields:

```rust
file_results.push(SearchResult {
    source: "claude".to_string(),
    project_id: encoded_name.clone(),
    project_name: project_name.clone(),
    session_id: session_id.clone(),
    first_prompt: first_prompt.clone(),
    alias: alias.clone(),
    tags: tags.clone(),
    matched_text,
    role: msg.role.clone(),
    timestamp: msg.timestamp.clone(),
    file_path: file_path.to_string_lossy().to_string(),
    total_message_count,                    // NEW
    matched_message_id: msg.uuid.clone(),   // NEW
});
```

**Step 3: Update `search_codex` to populate new fields**

Same pattern in `search_codex` (around line 221-251):

Add after `if let Ok(messages) = codex::parse_all_messages(file_path) {`:
```rust
let total_message_count = messages.len() as u32;
```

Add to the push call:
```rust
total_message_count,
matched_message_id: msg.uuid.clone(),
```

**Step 4: Verify compilation**

```bash
cargo check --workspace
```

Expected: no errors.

**Step 5: Commit**

```bash
git add crates/session-core/src/search.rs
git commit -m "feat: add total_message_count and matched_message_id to SearchResult"
```

---

## Task 3: Add session-name search to backend

**Files:**
- Modify: `crates/session-core/src/search.rs`

**Step 1: Understand current flow**

In `search_claude`, after the metadata lookup (alias/tags at around line 119-126), the code enters `if let Ok(messages) = parse_all_messages(...)`. We need to check alias **before** entering the message loop, and check first_prompt **as soon as it's computed**.

**Step 2: Add alias check before message loop in `search_claude`**

After the alias/tags lookup block and before `if let Ok(messages) = ...`, add:

```rust
// Check if session alias matches the query (session-name search)
let mut session_name_matched = false;
if let Some(a) = &alias {
    if a.to_lowercase().contains(query_lower) {
        file_results.push(SearchResult {
            source: "claude".to_string(),
            project_id: encoded_name.clone(),
            project_name: project_name.clone(),
            session_id: session_id.clone(),
            first_prompt: None,
            alias: alias.clone(),
            tags: tags.clone(),
            matched_text: a.clone(),
            role: "session".to_string(),
            timestamp: None,
            file_path: file_path.to_string_lossy().to_string(),
            total_message_count: 0,       // will be updated below
            matched_message_id: None,
        });
        session_name_matched = true;
    }
}
```

Note: `total_message_count` is 0 here because we haven't parsed messages yet. After parsing, update the last pushed result if it was a session match.

**Step 3: Alternative — simpler approach: check inside parse block**

A cleaner approach: move the alias check inside the `parse_all_messages` block where we already have `total_message_count`:

```rust
if let Ok(messages) = claude::parse_all_messages(file_path) {
    let total_message_count = messages.len() as u32;
    let mut session_name_matched = false;

    // Check alias for session-name match
    if let Some(a) = &alias {
        if a.to_lowercase().contains(query_lower) && !session_name_matched {
            session_name_matched = true;
            file_results.push(SearchResult {
                source: "claude".to_string(),
                project_id: encoded_name.clone(),
                project_name: project_name.clone(),
                session_id: session_id.clone(),
                first_prompt: None,
                alias: alias.clone(),
                tags: tags.clone(),
                matched_text: a.clone(),
                role: "session".to_string(),
                timestamp: None,
                file_path: file_path.to_string_lossy().to_string(),
                total_message_count,
                matched_message_id: None,
            });
        }
    }

    let mut first_prompt: Option<String> = None;
    for msg in &messages {
        if msg.role == "user" && first_prompt.is_none() {
            for block in &msg.content {
                if let DisplayContentBlock::Text { text } = block {
                    first_prompt = Some(safe_truncate(text, 100));
                    // Check first_prompt for session-name match (only if alias didn't already match)
                    if !session_name_matched && text.to_lowercase().contains(query_lower) {
                        session_name_matched = true;
                        file_results.push(SearchResult {
                            source: "claude".to_string(),
                            project_id: encoded_name.clone(),
                            project_name: project_name.clone(),
                            session_id: session_id.clone(),
                            first_prompt: first_prompt.clone(),
                            alias: alias.clone(),
                            tags: tags.clone(),
                            matched_text: safe_truncate(text, 100),
                            role: "session".to_string(),
                            timestamp: msg.timestamp.clone(),
                            file_path: file_path.to_string_lossy().to_string(),
                            total_message_count,
                            matched_message_id: msg.uuid.clone(),
                        });
                    }
                    break;
                }
            }
        }
        // ... existing content search loop continues
    }
}
```

Use this inside-parse-block approach. Apply the same pattern to `search_codex`.

**Step 4: Verify compilation**

```bash
cargo check --workspace
```

**Step 5: Commit**

```bash
git add crates/session-core/src/search.rs
git commit -m "feat: search session names (alias and firstPrompt) in global search"
```

---

## Task 4: Update TypeScript types for new SearchResult fields

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add new fields to `SearchResult` interface**

In `src/types/index.ts`, update the `SearchResult` interface (line 74-86):

```typescript
export interface SearchResult {
  source: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  firstPrompt: string | null;
  alias: string | null;
  tags: string[] | null;
  matchedText: string;
  role: string;
  timestamp: string | null;
  filePath: string;
  // NEW
  totalMessageCount: number;
  matchedMessageId: string | null;
}
```

**Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors related to `SearchResult`.

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add totalMessageCount and matchedMessageId to SearchResult TS type"
```

---

## Task 5: Update SearchPage — message count + copy button + jump to match + session role

**Files:**
- Modify: `src/components/search/SearchPage.tsx`

**Step 1: Add imports**

At line 4, update imports to add `Copy, Check`:
```typescript
import { Search, Loader2, MessageSquare, MessagesSquare, Tag, Copy, Check } from "lucide-react";
```

Also add `useState` for copy feedback (it's already imported).

**Step 2: Update `groupedSessions` type and logic**

In the `useMemo` for `groupedSessions` (around line 97), update the Map value type:

```typescript
const groups = new Map<string, {
  projectId: string;
  projectName: string;
  alias: string | null;
  firstPrompt: string | null;
  tags: string[] | null;
  filePath: string;
  matchCount: number;
  totalMessageCount: number;    // NEW
  latestTimestamp: string;
  matchedTexts: string[];
  firstMatchedMessageId: string | null;  // NEW
}>();
```

In the `else` branch (when creating a new group entry), add:
```typescript
groups.set(r.filePath, {
  projectId: r.projectId,
  projectName: r.projectName,
  alias: r.alias,
  firstPrompt: r.firstPrompt,
  tags: r.tags,
  filePath: r.filePath,
  matchCount: 1,
  totalMessageCount: r.totalMessageCount,                                          // NEW
  latestTimestamp: r.timestamp || "",
  matchedTexts: [r.matchedText],
  firstMatchedMessageId: r.matchedMessageId ?? null,                               // NEW
});
```

The `existing` branch does not need totalMessageCount update (it's the same session).

**Step 3: Add copy state**

Near the top of `SearchPage` function body (after `const [searchMode, ...]`), add:
```typescript
const [copiedFilePath, setCopiedFilePath] = useState<string | null>(null);

const handleCopySessionName = (e: React.MouseEvent, filePath: string, name: string) => {
  e.stopPropagation();
  navigator.clipboard.writeText(name);
  setCopiedFilePath(filePath);
  setTimeout(() => setCopiedFilePath(null), 2000);
};
```

**Step 4: Update session card click handler to use `scrollTo`**

Find the session card's `onClick` (around line 280-284):
```typescript
onClick={() => {
  const encodedProjectId = encodeURIComponent(session.projectId);
  const encodedFilePath = encodeURIComponent(session.filePath);
  navigate(`/projects/${encodedProjectId}/session/${encodedFilePath}`);
}}
```

Replace with:
```typescript
onClick={() => {
  const encodedProjectId = encodeURIComponent(session.projectId);
  const encodedFilePath = encodeURIComponent(session.filePath);
  const scrollParam = session.firstMatchedMessageId
    ? `?scrollTo=${encodeURIComponent(session.firstMatchedMessageId)}`
    : "";
  navigate(`/projects/${encodedProjectId}/session/${encodedFilePath}${scrollParam}`);
}}
```

**Step 5: Update session card display — add message count + copy button**

Find the `matchCount` badge in the session card (around line 291-293):
```tsx
<span className="text-xs px-2 py-0.5 bg-primary/15 text-primary rounded font-medium">
  {session.matchCount} 条匹配
</span>
```

Replace with:
```tsx
<span className="text-xs px-2 py-0.5 bg-primary/15 text-primary rounded font-medium">
  {session.matchCount} 条匹配 / 共 {session.totalMessageCount} 条
</span>
```

Find the session title line (around line 300-304):
```tsx
{(session.alias || session.firstPrompt) && (
  <p className="text-sm text-foreground mb-2 flex items-center gap-1">
    <MessagesSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
    <span className="truncate">{session.alias || session.firstPrompt}</span>
  </p>
)}
```

Replace with:
```tsx
{(session.alias || session.firstPrompt) && (
  <div className="flex items-center gap-1 mb-2 group/title">
    <MessagesSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
    <span className="text-sm text-foreground truncate flex-1">
      {session.alias || session.firstPrompt}
    </span>
    <button
      onClick={(e) =>
        handleCopySessionName(e, session.filePath, session.alias || session.firstPrompt || "")
      }
      className="shrink-0 p-1 rounded opacity-0 group-hover/title:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
      title="复制会话名"
    >
      {copiedFilePath === session.filePath ? (
        <Check className="w-3 h-3 text-green-500" />
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </button>
  </div>
)}
```

**Step 6: Handle `role: "session"` in message mode**

In the message mode result card (around line 224-266), after the `getRoleLabel` display, the role `"session"` should show with `MessagesSquare` icon. Find the role label span (line 233-236):
```tsx
<span className="text-xs text-muted-foreground">
  {getRoleLabel(result.role)}
</span>
```

Update `getRoleLabel` function:
```typescript
const getRoleLabel = (role: string) => {
  if (role === "user") return "用户";
  if (role === "tool") return "Tool";
  if (role === "session") return "会话名";   // NEW
  return source === "codex" ? "Codex" : "Claude";
};
```

**Step 7: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

**Step 8: Commit**

```bash
git add src/components/search/SearchPage.tsx
git commit -m "feat: search page — show message count, copy session name, jump to matched message"
```

---

## Task 6: Fix misleading scrollbar (pagination position indicator)

**Background:** Messages load from the **end** in pages (`page=0` = last page). As the user scrolls up, older pages load. The native browser scrollbar only reflects the currently loaded DOM, so for a 500-message session showing 50 messages, the scrollbar looks "full" when only 10% is loaded.

**Solution:** Show a compact position indicator in the MessagesPage header showing how many messages are loaded vs total, so the user has a reference point.

**Files:**
- Modify: `src/components/message/MessagesPage.tsx`

**Step 1: Add position indicator to the header**

In `MessagesPage.tsx`, find the header section (around line 289-342). Find the subtitle line:
```tsx
<p className="text-xs text-muted-foreground">
  {messagesTotal} 条消息
  {session?.gitBranch && ` · ${session.gitBranch}`}
  {` · ${assistantName}`}
</p>
```

Replace with:
```tsx
<p className="text-xs text-muted-foreground">
  {messages.length < messagesTotal
    ? `已加载 ${messages.length} / ${messagesTotal} 条消息`
    : `${messagesTotal} 条消息`}
  {session?.gitBranch && ` · ${session.gitBranch}`}
  {` · ${assistantName}`}
</p>
```

This tells the user exactly how many messages are loaded. When `messagesHasMore` is false, it simply shows the total (all loaded).

**Step 2: Add a thin progress bar below the header**

After the header `<div>` closing tag (around line 342), before the resume error toast, add:

```tsx
{/* Load progress bar — only visible when not all messages are loaded */}
{messagesHasMore && messages.length < messagesTotal && (
  <div className="h-0.5 bg-muted">
    <div
      className="h-full bg-primary/40 transition-all"
      style={{ width: `${Math.round((messages.length / messagesTotal) * 100)}%` }}
    />
  </div>
)}
```

This adds a subtle 2px bar at the top showing loading progress (0% when just entered, grows as older pages load).

**Step 3: Verify manually**

Open a large session (100+ messages). Confirm:
- Header shows "已加载 50 / 247 条消息" (or similar)
- Blue progress bar is visible at top
- As you scroll up and more messages load, the count and bar update

**Step 4: Commit**

```bash
git add src/components/message/MessagesPage.tsx
git commit -m "fix: show loaded/total message count and progress bar to fix misleading scrollbar"
```

---

## Task 7: Build and test everything together

**Step 1: Full Rust build**

```bash
cargo clippy --workspace -- -D warnings
```

Fix any warnings before proceeding.

**Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

**Step 3: Test search session name**

1. Start the app
2. Go to Search, type a word that appears in a session's alias or first message title
3. Confirm session-mode and message-mode both show results with role "会话名"

**Step 4: Test copy session name**

1. In Search → session mode, hover over a session card
2. Hover over the session title — a copy icon appears
3. Click it — confirm clipboard has the session name, icon flips to checkmark

**Step 5: Test jump to matched message**

1. Search for a keyword that matches a message deep in a session
2. In session mode, click the session card
3. Confirm MessagesPage loads and scrolls to / highlights the matching message

**Step 6: Test ANSI stripping**

1. Find a session with bash tool calls that produced colored terminal output
2. Confirm no raw `\x1b[...m` codes visible in tool output

**Step 7: Test scrollbar indicator**

1. Open a session with many messages
2. Confirm header shows "已加载 X / Y 条消息"
3. Scroll up to load more — confirm count updates

**Step 8: Final commit**

```bash
git add -A
git commit -m "feat: v2.0.0 — search enhancements, ANSI fix, pagination indicator"
```

---

## Summary of Changed Files

| File | Change |
|------|--------|
| `crates/session-core/src/search.rs` | SearchResult 新增2字段 + 会话名搜索 |
| `src/types/index.ts` | SearchResult TS 类型同步 |
| `src/components/message/utils.ts` | 新增 `stripAnsi` |
| `src/components/message/ToolOutputMessage.tsx` | 应用 stripAnsi |
| `src/components/message/AssistantMessage.tsx` | 应用 stripAnsi |
| `src/components/search/SearchPage.tsx` | 消息数 + 复制按钮 + 跳转 UUID + session role |
| `src/components/message/MessagesPage.tsx` | 加载进度指示器 |
