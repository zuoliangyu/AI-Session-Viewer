# Features

[简体中文](./features.md) | **English** · [← Back to README](../README.en.md)

Detailed description of every feature. For an overview see the [README](../README.en.md#features-at-a-glance).

## Navigation and display

- Switch between Claude, Codex, Grok, and Oh My Pi with the row of source icons at the top of the sidebar. Hide unused agents in **Settings → Display**, keeping at least one visible. Source-agnostic pages (search, bookmarks, settings, tools) stay put when you switch; other pages return to the project list. The active source is remembered across reloads.
- Main navigation provides projects, search, bookmarks, and statistics. Skills, invalid items, the recycle bin, and provider sync are under **Tools & management**; Settings is its own page, linked at the bottom left.
- The sidebar lists the five most recently viewed sessions (per machine and source) and the eight most recently active projects, with a link to all projects; typing in the filter searches every project.
- Page headers use a **source › project › session** breadcrumb.
- Long sessions show a position rail with a tick for every question — hover to preview, click or drag to jump.
- Load failures show the reason and a Retry button; every dialog closes with Escape.
- Projects and sessions use card grids by default. List/grid preferences are saved independently, with virtualized rows for large collections.
- Below 1024px, navigation becomes a drawer. Below 1280px, the question index overlays the reader and can be dismissed with Escape.
- Select Chinese or English in **Settings → Display → Language**. The default is Chinese regardless of system locale; language preference is saved per browser or desktop WebView. UI labels, dialogs, application hints, and relative times follow this choice. Raw session text and CLI/server diagnostics remain unchanged.
- Time zone is configured independently. Choose the system zone or an IANA zone; timestamps and statistics date boundaries follow it without changing stored UTC data.
- Light, dark, and system themes are available at the bottom of the sidebar.

## Projects and sessions

Projects are sorted by recent activity and show session counts and timestamps. Incremental caches re-read new or changed history files, including changes made while the app was closed. Manual cache refresh is also available.

The project Actions menu offers path copying and session-data deletion. Claude additionally supports project aliases and related configuration cleanup. Batch selection supports deleting multiple projects, with recoverable operations moved to the recycle bin.

Session cards show the first prompt or alias, message count, branch, and creation/modification times. Codex internal/noninteractive sessions are filtered out. Grok reads `summary.json` and `chat_history.jsonl`. Oh My Pi supports named profiles, initialized XDG directories, and related artifact directories.

- Export one or many sessions as JSON, Markdown, or HTML. Desktop uses a file dialog; web mode downloads through the browser.
- Add aliases and tags, filter by tags, and bookmark entire sessions or individual messages.
- Claude aliases synchronize with Claude Code's `/rename`.
- Review empty or corrupt sessions in the invalid-items page before deleting them. Deletion moves sessions to the recycle bin on both desktop and web.
- The recycle bin supports restoring original paths, removing orphan directories, and permanent deletion after confirmation. Deleting a whole Codex, Oh My Pi, or Grok project creates a single recycle-bin entry. The orphan-directory scan moves orphan Claude UUID directories to the recycle bin and deletes empty Codex date folders directly.

## Reading conversations

Pagination and jumps validate both session and window identity before applying results. Load all stays with its original session and stops on navigation or window replacement. Directory jumps are disabled while messages load.

Markdown, syntax highlighting, tool calls/results, and collapsible thinking/reasoning blocks are supported. The latest 30 messages load first; earlier messages load on demand without losing the scroll position. Large blocks initially use plain-text previews, with Markdown rendering available explicitly.

The reader provides message, question-summary, and Codex trace views. Display options control timestamps, model names, expansion, and split panes. The Details menu contains session metadata, costs, and resume commands. The question index starts collapsed and remembers your preference.

The Codex trace view includes turns, approximate steps, tool duration and failures, reasoning, sub-agents, context compaction, and token breakdowns. It handles legacy and `history_base` segmented rollouts; see [TRAJECTORY.md](../TRAJECTORY.md).

## Resume and fork

Resume a session through its CLI or continue Claude and Codex conversations from the composer at the bottom of the session page. Grok and Oh My Pi provide a terminal command.

Fork buttons appear below user questions and in the question summary. Forking creates an independent session containing earlier history and the selected turn's full reply, including tool calls and results. Later turns are excluded and the original is preserved.

- Desktop local mode opens a terminal and navigates to the new session. If terminal launch fails, the created fork remains available for retry.
- Web and remote-node forks are created on the server hosting the session.
- Codex uses native `codex app-server` fork operations and verifies history boundaries. Unsupported or stale positions fail explicitly rather than silently copying the wrong history.
- Oh My Pi follows the selected node's ancestor chain and copies attachments.
- Grok preserves raw history and prompt context while generating a new session identity.

`POST /api/sessions/fork` accepts `{ source, originalFilePath, userMsgUuid }` and returns `{ newSessionId, newFilePath, projectPath, projectId }`. Existing authentication and source-specific path validation apply.

## Search and statistics

Bookmarks, search results, and billing rows use `?scrollTo=` message links; legacy billing `#m=` links remain supported. User, assistant, and tool messages can be located by absolute index, loading only a nearby 31-message window when needed. Missing targets and read failures offer feedback and retry. Legacy bookmarks without UUIDs that stored a page-relative position cannot reliably recover their original target.

Question navigation and message lookup share a separate compact index containing bounded previews, question relationships, and ID positions. Navigation requests do not populate the full-message cache. Indexes invalidate on file length or high-resolution modification time changes, concurrent requests for a session share a scan, and the cache holds up to 20 sessions.

Clearing a search or changing its source/scope invalidates older requests, so late responses cannot overwrite the current results.

Claude statistics invalidate cached files by length and high-resolution modification time, including appends within one second. Files changing during a scan are retried on a later refresh. Older statistics caches rebuild once after upgrading; original sessions are unchanged.

An empty cross-project tag result is cached instead of triggering repeated requests. Tag read failures offer an explicit Retry action, and changing sources clears the previous source's tag loading state.

Search across projects by message content, session names, and tags. Switch between individual matches and results grouped by session. Selecting a result jumps to the matching message.

Token and cost statistics currently support **Claude and Codex**. They include input/output/cache tokens, USD costs, cache hit rates, daily/hourly trends, model usage, and the top ten projects by cost. Models without pricing are marked **Unpriced**.

Per-request costs support project, model, and date filters; a row opens the corresponding message. Each page contains up to 500 records, with previous/next controls, the current range, total count, and page number. Failed page loads retain the current records and offer a retry; changing filters, source, or time zone returns to the first page. Session cost details can be copied as a Markdown table. Time-zone selection controls date boundaries. Statistics cover files present on the selected machine and source.

Codex costs use each turn's `turn_context.model` and the built-in price table, including model switches within a session. Usage without a recorded model remains `unknown` / Unpriced; a Provider name is never used as a model identifier.

Codex overviews, request bills, project costs, and session costs share an in-process file cache. The first access parses each file; later requests reparse only changed files, and concurrent readers share one build per file. Directory enumeration and file metadata checks still run. Time-zone aggregations are calculated separately, and the cache rebuilds after restarting. Read failures return errors; retry later if files are changing continuously.

## In-app chat

Choose **New chat**, select a working directory, and chat through the installed Claude or Codex CLI (on this machine, or on the machine running the web server). Once the first reply finishes, the conversation moves to its session page, where the composer stays docked at the bottom. Replies stream with Markdown and tool viewers for Read, Edit, Write, Bash, Grep, and Glob. Long conversations use virtual scrolling. If the CLI isn't detected, the page links straight to Settings → Chat.

By default the web server rejects client requests to skip permissions or to supply their own API key / base URL; enable them explicitly with `--allow-skip-permissions` / `--allow-client-credentials`.

The app remembers model choices, supports custom model IDs, and attempts to match the historical model when resuming. Use `/model` or Ctrl+K to switch models. Chat settings include CLI paths, API/base-URL overrides, Windows terminal choice, and permission mode.

Codex chat notifications are routed by thread. Late events for closed or unsubscribed threads are not delivered to other conversations.

If a Codex notification buffer overflows or app-server exits, affected streams report an error and stop waiting. Reload the session to recover. One slow subscriber does not block healthy subscribers.

Cancellation requested during startup is retained. A Codex task interrupts only its own turn in the original runtime; each thread in that runtime permits one active send task. Disconnecting a web chat ends its active streams in the UI, while the server cancels and waits for the connection's tasks to exit. Detached background chat is not supported. Cancellation failures or missing CLI stop confirmations return errors.

## Skills, MCP, and plugins

Skill and MCP previews belong to the selected source and target nodes. Changing either node requires a fresh preview. Node selection stays fixed during synchronization, and stale previews or duplicate submissions cannot start a write.

Browse global, project, and plugin skills, view `SKILL.md`, and import ZIP archives. Plugin skills are read-only. Deleting a symbolic-link skill removes the link only; deleting a real skill directory is permanent.

Global Claude skills can be synchronized between two accessible `session-web` nodes after reviewing additions and conflicts. Overwrites are backed up, written files are checked, and failed writes restore the previous version. Backups live in the target's `ai-session-viewer/skill-backups/` configuration directory.

MCP sync compares Claude `mcpServers` and Codex `mcp_servers`. Sensitive and machine-specific values are redacted from transfers. Existing target secrets are preserved, stale previews are rejected, and writes are backed up to `ai-session-viewer/config-backups/`.

Plugin declarations are preview-only. Plugin caches, installation directories, artifacts, and credentials are not copied; install plugins using the target machine's normal CLI workflow.

## Codex provider sync

Sync, switch, and clone operations save all required backups before changing source data and stop if backup creation fails. Switching preserves the original `config.toml`, including its absence, so restoration can return to the implicit default. Later write failures may still require restoring the backup; changes across files are not one automatically rolled-back transaction.

After changing providers, old rollouts and SQLite metadata may still reference the previous provider and disappear from Codex Desktop or `/resume`. Provider sync aligns rollout headers, SQLite threads, and global-state paths, optionally updating `model_provider` in `config.toml`.

Changes are backed up to `~/.codex/backups_state/provider-sync/`; restoration can select configuration, database, sessions, and global state separately. Encrypted history may still fail to resume across providers with `invalid_encrypted_content`. Use the original provider when reliable resume is required.

**Repair old sessions**: after switching between a third-party login and the official login, `config.toml` may no longer define the provider recorded by old sessions, and Codex fails with ``Model provider `custom` not found``. The page lists providers referenced by rollouts, archived sessions, or SQLite threads that are neither built in nor defined under `[model_providers.*]`, and appends compatibility definitions to `config.toml`: by default the current OpenAI login and default endpoint (`wire_api = "responses"`, `requires_openai_auth = true`, no `base_url`), or a copy of a configured provider. Existing lines are untouched, the result is validated as TOML, and the write stops if the file changed meanwhile. Session files, SQLite, and login data are not modified; `config.toml` is backed up first and can be restored from the backup history.

## Session transfer

Tools → Session transfer moves sessions between computers. Export selected sources (all projects or chosen ones) into one `.zip` containing the original session files, sub-agent and tool-result directories, Claude project memory and index, Codex `threads` rows and thread names, plus Viewer aliases, tags, and bookmarks. Files are streamed, so multi-gigabyte exports do not need much memory.

Importing first shows a preview: sessions per project, sessions that already exist here, and whether the original project path exists. A project can be mapped to a different local directory; recorded working directories (`cwd`) are rewritten so sessions can be continued locally, while message text is left untouched. Existing sessions are skipped by default; overwriting moves the local copy to `~/.claude-code-viewer/transfer/backups/` first. Archive paths are validated before anything is written, and a failed session is rolled back.

Sessions may contain code, command output, and secrets, so keep exports safe. Encrypted Codex history may fail to resume under a different account or provider.

### Move a project (this machine)

**Move project** on the same page relocates a project folder on this machine (rename or reorganize) and takes its sessions along. Preview the changes, then let the app move the folder (same disk partition) or choose "Folder already moved by hand" to update the records only. Claude project directories under `~/.claude/projects/` are renamed to the new encoding (merged if one exists), and transcript `cwd`, `sessions-index.json`, `~/.claude.json` project settings, and `history.jsonl` follow. Codex rollout `cwd`, `threads.cwd` in `state_5.sqlite`, `[projects."<path>"]` trust entries, and Desktop workspace roots are updated, as are Grok / Oh My Pi session `cwd` fields (and their path-named directories when verifiable) and bookmarks. Sub-directory projects move too; message text is untouched. Config and index files are backed up to `transfer/backups/relocate-<timestamp>/` in the app directory. Every step can be re-run, so an interrupted move is finished by running it again with "Folder already moved by hand"; to undo, move the folder back. Quit AI tools and editors using the project first.

## Updates and file watching

Installed desktop packages use the in-app updater. Windows portable packages link to GitHub Releases. Updates can be checked in Settings, and individual versions can be skipped.

Desktop and web file watchers batch changed paths to refresh affected projects. Desktop also performs a periodic background refresh. Metadata, indexes, and bookmarks use atomic writes.

Both modes check configured provider roots every five seconds and restore watches for directories created after startup or deleted and recreated. Restoring a watch refreshes that source and affected open sessions to include files written during the gap. Ordinary file events remain incremental; watches stay within provider roots.

Bookmarks, recycle-bin manifests, and session metadata serialize read-modify-write operations and related file moves across desktop and web processes with `~/.claude-code-viewer/state-write-lock.sqlite`. A write-lock wait exceeding five seconds returns an error and can be retried; do not delete this lock file while the app is running. Saves use unique temporary files in the destination directory and atomic replacement. Only missing files count as empty data; corrupt or unreadable files block writes. The lock does not coordinate external editors or provide an automatic transaction rollback across multiple data files.
