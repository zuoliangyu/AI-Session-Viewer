# AI Session Viewer

[简体中文](./README.md) | **English**

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="AI Session Viewer">
</p>

<p align="center">
  <strong>A unified local session browser for Claude Code, Codex CLI, Grok CLI, and Oh My Pi</strong>
</p>

<p align="center">
  <a href="https://github.com/zuoliangyu/AI-Session-Viewer/releases"><img src="https://img.shields.io/github/v/release/zuoliangyu/AI-Session-Viewer?style=flat-square" alt="Release"></a>
  <a href="https://github.com/zuoliangyu/AI-Session-Viewer/actions"><img src="https://img.shields.io/github/actions/workflow/status/zuoliangyu/AI-Session-Viewer/build.yml?style=flat-square&label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/zuoliangyu/AI-Session-Viewer?style=flat-square" alt="License"></a>
</p>

Browse, search, export, organize, and resume local AI coding conversations in one interface. All four sources support session browsing, search, export, tags, aliases, deletion, forking, and resume commands. Claude and Codex also support chatting inside the app through the locally installed CLI.

The viewer reads local session files. Browsing does not upload them to a cloud service. Editing metadata, deleting sessions, connecting to remote nodes, syncing configuration, or starting a CLI conversation are explicit user actions.

**Interface language:** Chinese is the default on every system. To use English, click **设置 (Settings)** in the lower-left corner, open **显示设置 (Display)**, and select **English** under **界面语言 / Language**. The change takes effect immediately and is remembered after restarting. Session content and custom names are not translated.

**What's new in v3.0.0:** a reworked layout — breadcrumb page headers, a dedicated Settings page, a compact source switcher with a "recent projects" sidebar, and question ticks on the long-session position rail. A new chat moves to its session page once the first reply finishes, and the session page keeps its composer docked. The web server is hardened: loopback by default, a token is required for network binds, and WebSocket origins are checked. In-app chat now focuses on Claude and Codex, and web deletion goes to the recycle bin. Streaming and search are noticeably faster.

> ⚠️ **Upgrading from 2.x:** this release contains breaking changes (web bind address, token requirement, chat scope). See [CHANGELOG.md](./CHANGELOG.md#300---2026-09-30).

## Screenshots

<table>
  <tr>
    <td><img src="./img/messages.png" width="400" alt="Message view and position rail"></td>
    <td><img src="./img/projects.png" width="400" alt="Projects"></td>
  </tr>
  <tr>
    <td><img src="./img/tool-viewers.png" width="400" alt="Tool call viewers"></td>
    <td><img src="./img/stats.png" width="400" alt="Token and cost statistics"></td>
  </tr>
</table>

More screenshots (search, settings, Codex, dark theme, …) are in [docs/screenshots.en.md](./docs/screenshots.en.md). They use fictional demo data.

## Quick start

### Desktop

Download an installer or portable package from [Releases](https://github.com/zuoliangyu/AI-Session-Viewer/releases).

| Platform | Packages |
|---|---|
| Windows | `.msi`, NSIS `.exe`, or portable `.zip` |
| macOS (Universal) | `.dmg` for Intel and Apple Silicon |
| Linux | `.deb` or `.AppImage` |

Open the application to scan local session directories. You must have used at least one supported CLI and have its session files available.

| Source | Session location |
|---|---|
| Claude Code | `~/.claude/projects/` |
| Codex CLI | `~/.codex/sessions/` |
| Grok CLI | `$GROK_HOME/sessions/`, or `~/.grok/sessions/` |
| Oh My Pi | Default/named profile session directories under `~/.omp/agent/`, or an initialized `$XDG_DATA_HOME/omp/` on Linux/macOS |

### Web server

Run it on a headless server and open it in a browser:

```bash
./session-web                                  # loopback only: http://127.0.0.1:3000
./session-web --host 0.0.0.0 --token my-secret  # LAN / public (token required)
```

Options, Docker, security advice, and multiple machines: [docs/deployment.en.md](./docs/deployment.en.md).

## Features at a glance

| Feature | What it does |
|---|---|
| Four sources | Browse local Claude Code, Codex CLI, Grok CLI, and Oh My Pi sessions in one place |
| Reading | Markdown and highlighting, tool viewers, question index and position rail, question summary, Codex trace |
| Organizing | Aliases, tags, bookmarks, export (JSON / Markdown / HTML), batch delete to the recycle bin |
| Keep working | One-click terminal resume, fork from any question; in-app chat for Claude and Codex |
| Search and stats | Cross-project full-text search; Claude / Codex tokens, costs, and per-request bills |
| Web and machines | `session-web` in the browser, multiple nodes, token and origin checks |
| More | Skills / MCP / plugin management, Codex provider sync, invalid-item cleanup, Chinese/English UI, in-app updates |

Full details are in [docs/features.en.md](./docs/features.en.md).

## Documentation

| Document | Contents |
|---|---|
| [Screenshots](./docs/screenshots.en.md) | Every screen |
| [Features](./docs/features.en.md) | Full description of each feature |
| [Web server and deployment](./docs/deployment.en.md) | Options, Docker, security, multiple machines |
| [Development](./docs/development.en.md) | Local setup, builds, tech stack, architecture, REST API, release, roadmap |
| [CHANGELOG](./CHANGELOG.md) | Release history |

## Releases and contributing

The version in `package.json` is authoritative. Run `npm run sync-version` to synchronize Cargo manifests and Tauri configuration. Pushing a version tag triggers desktop packages, the Linux web executable, Docker images, updater signatures, and the release manifest.

Issues and pull requests are welcome. See [CHANGELOG.md](./CHANGELOG.md) for release history and the [Chinese README](./README.md#路线图) for the feature checklist.

## License

[MIT](./LICENSE). Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
