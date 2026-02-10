# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-02-10

### Fixed

#### Ctrl+C 退出的会话在列表中丢失
- **根因**: Claude CLI 的 `sessions-index.json` 由 CLI 自身维护，当用户通过 Ctrl+C 强制退出时，CLI 可能来不及将当前会话写入索引。`get_sessions()` 优先信任索引，如果索引存在就只返回索引中的会话，忽略磁盘上存在但不在索引中的 `.jsonl` 文件
- **修复**: `get_sessions()` 现在执行合并逻辑——先读取索引条目，再扫描磁盘上所有 `.jsonl` 文件，对不在索引中的会话执行 fallback 扫描并合并到结果中

### Changed

#### 重构: 提取 `scan_single_session()` 函数
- 从 `scan_sessions_from_dir()` 的循环体中提取单文件扫描逻辑为独立的 `scan_single_session()` 函数
- `scan_sessions_from_dir()` 和合并逻辑共同复用此函数，消除代码重复

---

## [0.5.0] - 2026-02-07

### Highlights

**项目合并**: 将 `claude-memory-viewer` 和 `codex-session-viewer` 合并为统一应用 **AI Session Viewer**，在同一界面中同时支持 Claude Code 和 Codex CLI 两种 AI 编程助手的会话浏览。

### Added

#### Dual Data Source — Claude Code + Codex CLI
- 侧边栏顶部新增 Claude / Codex Tab 切换，一键切换数据源
- Claude Tab 使用橙色主题，Codex Tab 使用绿色主题
- 切换时自动清理所有状态（项目、会话、消息）并重新加载

#### Codex CLI Support
- 新增 `provider/codex.rs`，扫描 `~/.codex/sessions/{year}/{month}/{day}/rollout-*.jsonl`
- 按 `cwd` 工作目录聚合会话为项目
- 从 `session_meta` 首行提取元数据（cwd、model、cli_version）
- 支持 Codex 特有的消息格式：`reasoning` 推理块、`function_call` 函数调用、`function_call_output` 函数返回

#### Provider Architecture
- 新增 `provider/` 模块，将数据源解析从命令层解耦
- `provider/claude.rs` — 从原 `parser/jsonl.rs` 提取，处理 Claude Code 数据
- `provider/codex.rs` — 从 codex-session-viewer 移植，处理 Codex CLI 数据
- 所有 Tauri Commands 新增 `source` 参数，统一调度到对应 provider

#### Unified Models
- `DisplayContentBlock` 枚举扩展为 7 种变体：Text、Thinking、ToolUse、ToolResult、Reasoning、FunctionCall、FunctionCallOutput
- `ProjectEntry` 新增 `source`、`modelProvider` 字段
- `SessionIndexEntry` 新增 `source`、`filePath`、`cwd`、`modelProvider`、`cliVersion` 字段
- `TokenUsageSummary` 统一双数据源的 Token 统计格式

#### New Components
- `ToolOutputMessage.tsx` — 渲染 `function_call_output`（Codex）和 `tool_result`（Claude）的独立组件
- `AssistantMessage.tsx` 扩展支持 `reasoning` 和 `function_call` 块类型

### Fixed

#### Mac 搜索闪退（Critical）
- **根因**: `search.rs` 使用字节索引切片 UTF-8 字符串（`&text[..100]`、`text[start..end]`），遇到中文/emoji 时 panic
- **修复**: 全面替换为字符级安全操作 — `safe_truncate()` 使用 `chars().take(n)`，`extract_context()` 使用字符数组 + `windows()` 滑动窗口

#### Codex 会话消息数统计不准
- **根因**: `count_messages()` 使用 `contains("response_item") && contains("message")` 宽松匹配，如果函数返回内容中碰巧包含这些字面字符串会被误计
- **修复**: 改用精确匹配 `"type":"response_item"` 和 `"type":"message"` 的紧邻组合

#### Codex 会话黑屏
- **根因**: `MessagesPage.tsx` 使用 `location.pathname` 手动切片提取 filePath，对于 Codex 文件路径中含 `:` `\` 等特殊字符时 URL 编码/解码不一致导致前缀不匹配 → 空 filePath → 后端找不到文件
- **修复**: 改用 React Router 的 `params["*"]` 通配符参数，由框架负责解码

#### SessionsPage 重复解码
- `useParams()` 已自动解码 URL 参数，但代码又调了一次 `decodeURIComponent`，导致 `%25` 等被双重解码。移除多余的 decode 调用。

#### SearchPage 字段不匹配
- SearchPage 引用了旧的 `result.encodedName` 字段（统一模型中已不存在），改为使用 `result.projectId` 和 `result.filePath`

#### StatsPage 状态引用错误
- StatsPage 引用了已移除的 `stats`（旧 StatsCache），完全重写为使用 `tokenSummary`（统一 TokenUsageSummary），支持双数据源

### Changed

- 项目更名：Claude Memory Viewer → **AI Session Viewer**
- 应用标识符：`com.zuolan.claude-memory-viewer` → `com.zuolan.ai-session-viewer`
- 版本号：0.4.0 → **0.5.0**
- `watcher/fs_watcher.rs` 同时监听 `~/.claude/projects/` 和 `~/.codex/sessions/` 两个目录
- `terminal.rs` 根据 source 分别执行 `claude --resume` 或 `codex resume`
- 前端所有 API 调用和状态管理加入 `source` 参数
- `MessageThread.tsx` 支持三种角色路由：user → UserMessage，tool → ToolOutputMessage，其他 → AssistantMessage

---

## [0.4.0] - 2026-02-07

### Added

#### Session Deletion
- Delete individual sessions from the session list page
- Backend `delete_session` command removes the `.jsonl` file and updates `sessions-index.json`
- Trash icon button on each session card (visible on hover, alongside Resume)
- Confirmation dialog before deletion with loading state
- Session is removed from the local store immediately after successful deletion

---

## [0.3.0] - 2026-02-07

### Added

#### Scroll-to-Bottom Button
- Added a floating scroll-to-bottom button in the session message view for quickly jumping to the latest messages

---

## [0.2.0] - 2026-02-07

### Fixed

#### Resume Session — Terminal Lifetime
- **Critical**: Resumed terminals no longer get killed when the app exits
  - **Windows**: Replaced direct `cmd` spawn with `cmd /c start /d` — the `start` command launches a fully independent process owned by Windows shell, not by our app. The intermediate `cmd /c` exits immediately, breaking the parent-child link. `CREATE_NO_WINDOW` hides the brief intermediate cmd flash.
  - **Linux**: Added `process_group(0)` (calls `setsid`) to create an independent process session that survives parent exit.
  - **macOS**: Already independent (Terminal.app owns the process via AppleScript).

#### Linux Build
- Fixed `AsRef<OsStr>` type inference ambiguity caused by `glib` crate on Linux — removed unnecessary `.as_ref()` call in `Command::args`.
- Fixed `format!` temporary `String` lifetime issue — pre-bind formatted strings with `let` before referencing in array.

---

## [0.1.0] - 2026-02-07

First release of Claude Memory Viewer.

### Added

#### Project Browser
- Auto-scan `~/.claude/projects/` directory to discover all Claude Code projects
- Display project path, session count, and last active time
- Sort projects by most recently active

#### Session List
- Read Claude Code's `sessions-index.json` for instant loading
- Show session summary, first prompt preview, message count, Git branch, created/modified timestamps
- One-click Resume button to open `claude --resume {sessionId}` in system terminal

#### Message Detail
- Full conversation rendering with paginated loading (infinite scroll)
- **User messages** — plain text and tool result display
- **Assistant messages** — Markdown rendering with GFM support (tables, task lists, strikethrough)
- **Code blocks** — Syntax highlighting via Prism (oneDark theme), supporting 100+ languages
- **Thinking blocks** — Collapsible display of Claude's reasoning process
- **Tool calls** — Collapsible display of tool name, input parameters, and results
- Large content truncation (2000 chars) with expand option

#### Global Search
- Cross-project, cross-session full-text search
- Parallel scanning powered by Rayon (Rust)
- Case-insensitive matching with keyword highlighting
- Click results to navigate directly to the matching message

#### Token Statistics
- Read `stats-cache.json` for usage data
- Summary cards: total messages, sessions, tool calls, tokens
- Daily activity bar chart (messages + tool calls)
- Token usage trend area chart (input / output over time)
- Model usage distribution with progress bars

#### Resume Session (Cross-platform)
- **Windows** — Opens new CMD window via `cmd /c start`
- **macOS** — Uses AppleScript to open Terminal.app
- **Linux** — Auto-detects gnome-terminal / konsole / xfce4-terminal / xterm

#### Infrastructure
- Tauri v2 desktop app (Rust backend + React frontend)
- React 19 + TypeScript + Vite 6 + Tailwind CSS
- Zustand state management
- GitHub Actions CI (cargo check + clippy + tsc)
- GitHub Actions Release workflow for multi-platform builds (Windows / macOS Intel / macOS ARM / Linux)
- MIT License

### Technical Details

- **JSONL Parser**: Stream-based parsing with `BufReader` + line-level pre-filtering, skips `progress` and `file-history-snapshot` records for performance
- **Session Index**: Leverages Claude Code's built-in `sessions-index.json` for millisecond-level session list loading
- **Search**: Rayon parallel brute-force search across all JSONL files
- **Path Handling**: Cross-platform Claude home detection (`%USERPROFILE%\.claude` on Windows, `~/.claude` on Unix)

[0.6.0]: https://github.com/zuoliangyu/claude-memory-viewer/releases/tag/v0.6.0
[0.5.0]: https://github.com/zuoliangyu/claude-memory-viewer/releases/tag/v0.5.0
[0.4.0]: https://github.com/zuoliangyu/claude-memory-viewer/releases/tag/v0.4.0
[0.3.0]: https://github.com/zuoliangyu/claude-memory-viewer/releases/tag/v0.3.0
[0.2.0]: https://github.com/zuoliangyu/claude-memory-viewer/releases/tag/v0.2.0
[0.1.0]: https://github.com/zuoliangyu/claude-memory-viewer/releases/tag/v0.1.0
