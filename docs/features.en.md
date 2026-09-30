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
- The recycle bin supports restoring original paths, removing orphan directories, and permanent deletion after confirmation. Deleting a whole Oh My Pi or Grok project creates a single recycle-bin entry.

## Reading conversations

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

Search across projects by message content, session names, and tags. Switch between individual matches and results grouped by session. Selecting a result jumps to the matching message.

Token and cost statistics currently support **Claude and Codex**. They include input/output/cache tokens, USD costs, cache hit rates, daily/hourly trends, model usage, and the top ten projects by cost. Models without pricing are marked **Unpriced**.

Per-request costs support project, model, and date filters; a row opens the corresponding message. Session cost details can be copied as a Markdown table. Time-zone selection controls date boundaries. Statistics cover files present on the selected machine and source.

## In-app chat

Choose **New chat**, select a working directory, and chat through the installed Claude or Codex CLI (on this machine, or on the machine running the web server). Once the first reply finishes, the conversation moves to its session page, where the composer stays docked at the bottom. Replies stream with Markdown and tool viewers for Read, Edit, Write, Bash, Grep, and Glob. Long conversations use virtual scrolling. If the CLI isn't detected, the page links straight to Settings → Chat.

By default the web server rejects client requests to skip permissions or to supply their own API key / base URL; enable them explicitly with `--allow-skip-permissions` / `--allow-client-credentials`.

The app remembers model choices, supports custom model IDs, and attempts to match the historical model when resuming. Use `/model` or Ctrl+K to switch models. Chat settings include CLI paths, API/base-URL overrides, Windows terminal choice, and permission mode.

## Skills, MCP, and plugins

Browse global, project, and plugin skills, view `SKILL.md`, and import ZIP archives. Plugin skills are read-only. Deleting a symbolic-link skill removes the link only; deleting a real skill directory is permanent.

Global Claude skills can be synchronized between two accessible `session-web` nodes after reviewing additions and conflicts. Overwrites are backed up, written files are checked, and failed writes restore the previous version. Backups live in the target's `ai-session-viewer/skill-backups/` configuration directory.

MCP sync compares Claude `mcpServers` and Codex `mcp_servers`. Sensitive and machine-specific values are redacted from transfers. Existing target secrets are preserved, stale previews are rejected, and writes are backed up to `ai-session-viewer/config-backups/`.

Plugin declarations are preview-only. Plugin caches, installation directories, artifacts, and credentials are not copied; install plugins using the target machine's normal CLI workflow.

## Codex provider sync

After changing providers, old rollouts and SQLite metadata may still reference the previous provider and disappear from Codex Desktop or `/resume`. Provider sync aligns rollout headers, SQLite threads, and global-state paths, optionally updating `model_provider` in `config.toml`.

Changes are backed up to `~/.codex/backups_state/provider-sync/`; restoration can select configuration, database, sessions, and global state separately. Encrypted history may still fail to resume across providers with `invalid_encrypted_content`. Use the original provider when reliable resume is required.

## Updates and file watching

Installed desktop packages use the in-app updater. Windows portable packages link to GitHub Releases. Updates can be checked in Settings, and individual versions can be skipped.

Desktop and web file watchers batch changed paths to refresh affected projects. Desktop also performs a periodic background refresh. Metadata, indexes, and bookmarks use atomic writes.
