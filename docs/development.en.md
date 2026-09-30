# Development

[简体中文](./development.md) | **English** · [← Back to README](../README.en.md)

Local development, builds, tech stack, architecture, and the REST API.

## Development

## Requirements

- Node.js 22 or newer; `.nvmrc` selects the project's Node version.
- A Rust toolchain compatible with the workspace's Tauri dependencies.
- Session data from at least one supported CLI.

Desktop platform dependencies:

| Platform | Requirements |
|---|---|
| Windows | Visual C++ Build Tools and WebView2 |
| macOS | Xcode command-line tools (`xcode-select --install`) |
| Ubuntu/Debian | `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` |

The web server does not need desktop WebKit/GUI libraries.

## Run locally

```bash
git clone https://github.com/zuoliangyu/AI-Session-Viewer.git
cd AI-Session-Viewer
npm ci
npx tauri dev
```

Use `npx tauri dev` for desktop development: it starts both the Rust backend and Vite. Running Vite alone does not provide a desktop backend.

Windows provides `./menu.ps1`; Linux/macOS provide `./menu.sh`. Script details are in [scripts/README.md](../scripts/README.md). For web development, use `npm run dev:web`.

## Build and validate manually

```bash
# Desktop packages
npx tauri build

# Web executable
npm run build:web && cargo build -p session-web --release

# Docker image
docker build -t ai-session-viewer-web .

# Lightweight regression checks
npm run check:scripts

# Rust lint and TypeScript validation
cargo clippy --workspace -- -D warnings
npx tsc --noEmit
```

Desktop artifacts are in `target/release/bundle/`; the web executable is `target/release/session-web`. Local menu builds disable updater artifacts and do not require a signing key. Release CI uses repository signing secrets.

**AppImage:** the project pins `@tauri-apps/cli` to **2.11.4**, which includes [Tauri #15596](https://github.com/tauri-apps/tauri/pull/15596). It creates relative `.DirIcon` and root `.desktop` symlinks, so they remain valid outside the build machine. Install dependencies from the lockfile. `node scripts/check-appimage.mjs` checks the version pin; Linux artifact extraction and launch still require manual verification. See [the artifact checklist](../scripts/README.md#appimage-产物验证).

The interface remains Chinese by default. Providing an English option alone does not satisfy the AppImage catalog's request for English by default outside Chinese locales.

**Translations:** edit both dictionaries in `src/i18n/locales/`. Components use `useTranslation`; utilities share the same i18next instance. Keep placeholders consistent and do not translate user content. See [src/i18n/README.md](../src/i18n/README.md).

## Architecture

| Layer | Technology |
|---|---|
| Desktop | Tauri v2, Rust, system WebView |
| Web server | Axum + WebSocket |
| Frontend | React 19, TypeScript, Vite 6 |
| UI | Tailwind CSS, lucide-react |
| State | Zustand 5 |
| Localization | i18next + react-i18next |
| Rendering | react-markdown, remark-gfm, react-syntax-highlighter |
| Charts | Recharts |
| Shared backend | `session-core` Rust crate |

The Cargo workspace contains `crates/session-core`, `src-tauri`, and `crates/session-web`. Shared React components use `api.ts`, which selects Tauri IPC or HTTP/WebSocket via the compile-time `__IS_TAURI__` flag. Providers parse source-specific files into shared project, session, and display-message models.

## API overview

The web API uses `source=claude|codex|grok|omp` where applicable. Authenticated deployments require a bearer token.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/projects`, `/api/sessions` | List projects and sessions |
| DELETE | `/api/sessions` | Delete a session |
| GET | `/api/messages` | Paginated messages (`filePath`, `page`, `pageSize`, `fromEnd`) |
| POST | `/api/sessions/fork` | Fork a session |
| PUT | `/api/sessions/meta` | Update alias and tags |
| GET | `/api/trajectory` | Codex trace records |
| GET | `/api/export` | JSON / Markdown / HTML export |
| GET | `/api/scan-progress` | Initial scan progress |
| GET | `/api/search`, `/api/tags`, `/api/cross-tags` | Search and tags |
| GET | `/api/stats`, `/api/stats/requests`, `/api/stats/projects`, `/api/stats/session` | Usage and cost statistics |
| GET, POST | `/api/bookmarks` | List or add bookmarks |
| DELETE | `/api/bookmarks/:id` | Remove a bookmark |
| GET | `/api/cli/detect`, `/api/cli/config` | CLI detection and masked configuration |
| POST | `/api/models` | List models |
| GET, DELETE | `/api/skills` | List or delete skills |
| GET | `/api/skills/content` | Read SKILL.md |
| POST | `/api/skills/import` | Import a ZIP archive |
| GET | `/api/provider-sync/status` | Provider metadata status |
| POST | `/api/provider-sync/sync`, `/api/provider-sync/switch` | Sync or change provider |
| POST | `/api/provider-sync/restore`, `/api/provider-sync/prune` | Restore or prune backups |
| WS | `/ws`, `/ws/chat` | File events and CLI chat |
