# 开发指南

**简体中文** | [English](./development.en.md) · [← 返回 README](../README.md)

本地开发、构建、技术栈、架构与 REST API。

## 开发

## 前置要求

- [Node.js](https://nodejs.org/) >= 22（项目统一使用 22.x，仓库提供 `.nvmrc`）
- [Rust](https://www.rust-lang.org/tools/install) >= 1.75
- 至少使用过以下一种 CLI：
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`~/.claude/projects/` 目录存在）
  - [Codex CLI](https://github.com/openai/codex)（`~/.codex/sessions/` 目录存在）

**平台依赖（仅桌面应用需要）：**

- **Windows:** [Visual C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) + [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)（Win10/11 通常已内置）
- **macOS:** `xcode-select --install`
- **Linux (Ubuntu/Debian):** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

> Web 服务器版本不需要上述 WebKit/GUI 依赖，只需 Rust 工具链。

## 本地开发

```bash
git clone https://github.com/zuoliangyu/AI-Session-Viewer.git
cd AI-Session-Viewer
npm install
```

Windows 可直接打开统一菜单：

```powershell
.\menu.ps1
```

Linux/macOS 使用对应的 Bash 菜单：

```bash
./menu.sh
```

完整脚本和参数说明见 [scripts/README.md](../scripts/README.md)。

也可以继续直接执行底层命令：

```bash
# 桌面应用开发（Tauri + Vite HMR）
npx tauri dev

# Web 服务器开发
npm run dev:web
```

> **注意**: 桌面应用不能只运行 `npm run dev`，那只会启动 Vite 前端。必须用 `npx tauri dev` 才能同时编译 Rust 后端并启动完整应用。

## 构建

Windows 使用 `.\menu.ps1`，Linux/macOS 使用 `./menu.sh`。菜单中的桌面构建仅生成本地安装包，会临时关闭 updater 产物生成，因此不需要发布签名私钥；正式发布仍由 CI 使用仓库 Secrets 完成签名。下列命令仍可独立使用。

**桌面应用：**

```bash
npx tauri build
```

产物位于 `target/release/bundle/`（`.msi` / `.exe` / `.dmg` / `.deb` / `.AppImage`）。

Linux AppImage 打包使用锁定的 `@tauri-apps/cli` **2.11.4**。该版本包含 [Tauri #15596](https://github.com/tauri-apps/tauri/pull/15596) 的修复，将 `.DirIcon` 和根目录 `.desktop` 改为相对符号链接，避免产物离开构建机器后链接失效。请使用仓库的 `package-lock.json` 安装依赖；无需额外配置 `bundle.linux.appimage.files`。Linux 产物验证方式见 [scripts/README.md](../scripts/README.md#appimage-产物验证)。

**Web 服务器：**

```bash
npm run build:web && cargo build -p session-web --release
```

产出单文件可执行：`target/release/session-web`

**Docker：**

```bash
docker build -t ai-session-viewer-web .
```

## 代码检查

```bash
npm run check:scripts                     # 轻量脚本与 i18n 回归检查
cargo clippy --workspace -- -D warnings   # Rust lint
npx tsc --noEmit                           # TypeScript 类型检查
```

> Linux 上如果 `cargo check --workspace` / `cargo clippy --workspace` 报 `glib`、`gobject`、`gio`、`libsoup` 等原生库缺失，通常不是 Rust 代码错误，而是桌面端 Tauri 依赖未安装完整。请先按上面的 Linux 桌面依赖说明补齐环境后再检查；如果你当前只开发 Web 服务器，可先只验证 `session-web` 相关目标。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | [Tauri v2](https://v2.tauri.app/) (Rust + WebView) |
| Web 服务器 | [Axum](https://github.com/tokio-rs/axum) 0.8 + WebSocket |
| 前端 | React 19 + TypeScript + Vite 6 |
| 样式 | Tailwind CSS 3 + @tailwindcss/typography |
| 状态管理 | Zustand 5 |
| 国际化 | i18next + react-i18next（简体中文 / English） |
| Markdown | react-markdown 9 + remark-gfm + react-syntax-highlighter |
| 图表 | Recharts 2 |
| 共享核心 | session-core（Rust crate，models/provider/search/stats） |
| 并行搜索 | Rayon 1.10 (Rust) |
| 自动更新 | tauri-plugin-updater 2 (Rust) |

## 架构

```
              React 前端（100% 复用）
   ┌──────────────────────────────────────┐
   │  Zustand Store + Components          │
   │  ┌──────────┐    ┌────────────────┐  │
   │  │tauriApi.ts│    │  webApi.ts     │  │
   │  │(invoke)   │    │  (fetch/ws)    │  │
   │  └─────┬─────┘    └───────┬────────┘  │
   └────────┼───────────────────┼──────────┘
            │                   │
    Tauri IPC              REST + WebSocket
            │                   │
   ┌────────┴────────┐  ┌──────┴─────────┐
   │   src-tauri/    │  │  session-web/  │
   │  (Tauri 桌面)   │  │  (Axum HTTP)   │
   └────────┬────────┘  └──────┬─────────┘
            │                  │
            └────────┬─────────┘
                     │
           ┌─────────┴─────────┐
           │   session-core    │  ← 共享 Rust 核心
           │ models / provider │
           │ search / stats    │
           └─────────┬─────────┘
                     │
          ┌──────────┼──────────┐
          │          │          │
     ~/.claude/  ~/.codex/   文件系统
```

前端通过编译时变量 `__IS_TAURI__` 自动切换 API 层（Tauri invoke vs HTTP fetch），组件代码 100% 复用。

## REST API

Web 服务器暴露以下 REST API，可供自定义客户端调用：

| 方法 | 路径 | Query 参数 | 说明 |
|------|------|-----------|------|
| GET | `/api/projects` | `source` | 获取项目列表 |
| GET | `/api/sessions` | `source, projectId` | 获取会话列表 |
| DELETE | `/api/sessions` | `filePath` | 删除会话 |
| GET | `/api/messages` | `source, filePath, page, pageSize, fromEnd` | 分页加载消息 |
| GET | `/api/trajectory` | `source, filePath, maxRecords?, beforeRecord?` | 加载 Codex Turn / Step 轨迹与事件账本 |
| GET | `/api/export` | `source, filePath, format` | 导出会话为 JSON / Markdown / HTML |
| GET | `/api/scan-progress` | — | 冷启动扫描进度 |
| GET | `/api/skills` | `projectPath?` | 列出全局 / 插件 / 项目级 skills |
| GET | `/api/skills/content` | `path` | 读取单个 `SKILL.md` 全文 |
| POST | `/api/skills/import` | `scope, projectPath?, overwrite?, archiveName?` + *(zip body)* | 导入 skill 压缩包 |
| DELETE | `/api/skills` | `scope, projectPath?, slug` | 删除全局 / 项目 skill |
| GET | `/api/search` | `source, query, maxResults` | 全局搜索 |
| GET | `/api/stats` | `source, timeZone?` | Token 统计汇总（含 cache / cost，IANA 时区默认 UTC） |
| GET | `/api/stats/requests` | `source, projectId?, sessionId?, startDate?, endDate?, model?, page?, pageSize?, timeZone?` | 按所选时区筛选逐请求账单 |
| GET | `/api/stats/projects` | `source` | 项目花费排行（按 cost 降序） |
| GET | `/api/stats/session` | `source, filePath` | 单会话累计账单 + 每条请求明细 |
| PUT | `/api/sessions/meta` | *(JSON body)* | 更新会话别名和标签 |
| GET | `/api/tags` | `source, projectId` | 获取项目内所有标签 |
| GET | `/api/cross-tags` | `source` | 获取跨项目全局标签 |
| GET | `/api/bookmarks` | `source` (可选) | 获取收藏列表 |
| POST | `/api/bookmarks` | *(JSON body)* | 添加收藏 |
| DELETE | `/api/bookmarks/:id` | — | 删除收藏 |
| GET | `/api/cli/detect` | — | 检测本地已安装的 CLI 工具 |
| GET | `/api/cli/config` | `source` | 读取 CLI 配置（API Key 遮罩） |
| POST | `/api/models` | *(JSON body)* | 获取模型列表 |
| GET | `/api/provider-sync/status` | — | Codex provider 同步状态总览 |
| POST | `/api/provider-sync/sync` | *(JSON body)* | 同步老 rollout / SQLite 到当前 provider |
| POST | `/api/provider-sync/switch` | *(JSON body)* | 改 config.toml + 同步到新 provider |
| POST | `/api/provider-sync/restore` | *(JSON body)* | 从备份恢复（粒度可选） |
| POST | `/api/provider-sync/prune` | `keep` | 清理旧备份只保留 N 份 |
| WS | `/ws` | — | 文件变更实时推送 |
| WS | `/ws/chat` | — | CLI 对话 WebSocket |

## 发布

标签触发：`git tag v2.x.0 && git push origin v2.x.0`。GitHub Actions 会自动：

1. 在 Windows、macOS（Intel + Apple Silicon）、Linux 上并行构建桌面应用
2. 构建 Web 服务器 Linux 二进制 + Docker 镜像（推送到 GHCR）
3. 生成各平台安装包 + `.sig` 签名文件 + `latest.json` 更新清单
4. 创建 GitHub Release 并上传所有产物

版本工作流：修改 `package.json` 中的 version → 执行 `npm run sync-version` → 提交并打标签。

## 路线图

- [x] 中英文界面切换（默认中文）与双语 README
- [x] 四数据源支持（Claude Code + Codex CLI + Grok CLI + Oh My Pi）
- [x] 消息详情渲染（Markdown / 代码高亮 / 工具调用 / 思考过程）
- [x] Resume 会话（跨平台终端启动）
- [x] 全局搜索 + Token 统计面板
- [x] 暗色 / 亮色主题切换
- [x] 应用内自动更新
- [x] Web 服务器变体（Axum + Docker）
- [x] 关于作者信息弹窗
- [x] 会话标签与别名系统 + 跨项目标签筛选
- [x] 全局搜索会话分组模式 + 应用内使用说明
- [x] 应用内 CLI 对话（Claude `--resume` / Codex `app-server` 续聊）
- [x] CLI 配置自动检测（API Key / Base URL / 默认模型）
- [x] 工具调用专用查看器（Read/Edit/Write/Bash/Grep/Glob）
- [x] 对话轮次分组 + Token 详细统计 + 虚拟化滚动
- [x] 模型智能记忆与自动选择（持久化 + 历史会话模型匹配）
- [x] 收藏系统（会话级 + 消息级收藏，跳转导航）
- [x] 会话分叉（Fork）— 从任意用户消息处分叉新会话
- [x] 终端类型选择（Windows CMD / PowerShell）
- [x] Docker GLIBC 兼容性修复 + CI 构建流水线加速
- [x] 侧边栏布局优化（macOS 兼容）+ 更新检测移入设置弹窗
- [x] Web 服务器 musl 静态编译 — 零依赖跨发行版运行
- [x] Web 模式 CLI 对话稳定性修复（错误反馈 + 权限确认卡死）
- [x] Web 服务器默认监听 0.0.0.0，局域网/远程直接可达 + crypto.randomUUID HTTP 兼容修复
- [x] CLI 对话自定义路径 + 流式增量输出 + ASCII 图表渲染优化
- [x] 项目路径智能解码（文件系统验证）+ 路径不存在警告 + 切换竞态修复
- [x] Codex Provider 同步工具（rollout / SQLite / global-state 三处元数据对齐 + 自动备份与粒度恢复）
- [x] 逐请求账单 / 会话级账单徽标 / 项目花费排行 / 缓存命中率走势（内置模型价格表 + 单日按小时聚合 + 可点选 Legend + 进程内 cache 50ms 响应）
- [x] 会话导出（JSON / Markdown / HTML，单个 + 批量）
- [x] 批量删除会话 / 项目（移入回收站可还原）+ 补齐 Codex 项目删除
- [x] 冷启动扫描进度条 + rayon 限流留核给 UI + 会话/项目列表虚拟化（`@tanstack/react-virtual`）
- [x] Skills 浏览 / 查看全文 / 导入压缩包 / 删除（全局 + 插件 + 项目级，软链安全 + zip-slip 防护）
