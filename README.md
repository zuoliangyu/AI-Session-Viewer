# AI Session Viewer

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="AI Session Viewer">
</p>

<p align="center">
  <strong>Claude Code & Codex CLI 本地会话记忆的统一可视化浏览器</strong>
</p>

<p align="center">
  <a href="https://github.com/zuoliangyu/AI-Session-Viewer/releases">
    <img src="https://img.shields.io/github/v/release/zuoliangyu/AI-Session-Viewer?style=flat-square" alt="Release">
  </a>
  <a href="https://github.com/zuoliangyu/AI-Session-Viewer/actions">
    <img src="https://img.shields.io/github/actions/workflow/status/zuoliangyu/AI-Session-Viewer/build.yml?style=flat-square&label=CI" alt="CI">
  </a>
  <a href="https://github.com/zuoliangyu/AI-Session-Viewer/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/zuoliangyu/AI-Session-Viewer?style=flat-square" alt="License">
  </a>
</p>

---

**AI Session Viewer** 是一个轻量级应用，让你可以在一个统一界面中浏览、搜索、统计来自 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 和 [OpenAI Codex CLI](https://github.com/openai/codex) 的所有本地会话记忆，并支持一键恢复（Resume）到对应 CLI 中继续对话。

本应用**只读取本地文件**，不联网、不上传任何数据。

## 截图

<table>
  <tr>
    <td><img src="./img/1.png" width="400" alt="项目列表"></td>
    <td><img src="./img/2.png" width="400" alt="会话列表"></td>
  </tr>
  <tr>
    <td><img src="./img/3.png" width="400" alt="消息详情"></td>
    <td><img src="./img/4.png" width="400" alt="全局搜索"></td>
  </tr>
  <tr>
    <td><img src="./img/5.png" width="400" alt="Token 统计"></td>
    <td><img src="./img/6.png" width="400" alt="暗色主题"></td>
  </tr>
</table>

## 快速开始

### 桌面应用（推荐）

前往 [Releases](https://github.com/zuoliangyu/AI-Session-Viewer/releases) 下载对应平台的安装包：

| 平台 | 安装包 |
|------|--------|
| Windows | `.msi`（安装版）或 `.zip`（便携版） |
| macOS | `.dmg` |
| Linux | `.deb` / `.AppImage` |

安装后打开即可使用，应用会自动扫描本地的 Claude / Codex 会话数据。

> 前提：至少使用过 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex CLI](https://github.com/openai/codex)，对应的 `~/.claude/projects/` 或 `~/.codex/sessions/` 目录存在。

### Web 服务器

适合无 GUI 的服务器环境，通过浏览器远程访问。二进制为 musl 静态编译，**零系统依赖**，任何 Linux 发行版（Ubuntu、Debian、Rocky、CentOS、Alpine 等）下载即可运行。

**直接运行（推荐）：**

```bash
# 最简启动（默认监听 0.0.0.0:3000，所有网卡可访问）
./session-web

# 限制只监听本机（仅 localhost 可访问）
./session-web --host 127.0.0.1

# 完整参数（公网暴露时务必设置 --token）
./session-web --host 0.0.0.0 --port 8080 --token my-secret

# 环境变量
ASV_HOST=0.0.0.0 ASV_PORT=8080 ASV_TOKEN=my-secret ./session-web
```

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `--host` | `ASV_HOST` | `0.0.0.0` | 监听地址（`0.0.0.0` = 所有网卡，`127.0.0.1` = 仅本机） |
| `--port` | `ASV_PORT` | `3000` | 监听端口 |
| `--token` | `ASV_TOKEN` | *(无)* | Bearer Token 认证，不设则**免认证**（局域网/公网部署必须设置） |

**直接运行 vs Docker：**

|  | 直接运行二进制（推荐） | Docker |
|---|---|---|
| CLI 对话 / Resume | ✅ 完整支持（直接调用宿主机 CLI） | ❌ 容器隔离，无法访问宿主机 CLI |
| 系统依赖 | 无（musl 静态编译） | 需要 Docker |
| 部署方式 | 下载 → `chmod +x` → 运行 | `docker compose up` |
| 适用场景 | **个人服务器、需要对话功能** | **团队共享、只浏览历史记录** |

> **建议**：如果你在服务器上安装了 Claude CLI 并且需要对话/Resume 功能，请使用直接运行。Docker 由于容器隔离，无法调用宿主机的 CLI 工具，仅适合纯浏览历史会话记录的场景。

**Docker 运行：**

```bash
docker compose up
```

挂载路径、端口、Token 等参数在 [`docker-compose.yml`](docker-compose.yml) 中配置。

**公网访问：**

```bash
# 直接运行（必须设置 Token）
./session-web --host 0.0.0.0 --port 8080 --token my-secret

# Docker
docker compose up -d
```

Docker 默认已监听 `0.0.0.0`，在 `docker-compose.yml` 中取消 `ASV_TOKEN` 注释并设置密钥即可安全使用：

```yaml
environment:
  ASV_TOKEN: my-secret
```

> ⚠️ **安全警告**
>
> 应用会读取服务器上的 `~/.claude/projects/` 和 `~/.codex/sessions/`，包含**完整会话记录（含 API Key、代码、隐私对话）**。
>
> | 场景 | 建议措施 |
> |------|---------|
> | **仅本机使用** | 使用默认 `0.0.0.0` 或 `127.0.0.1`，防火墙封闭端口 |
> | **局域网共享** | 设置 `ASV_TOKEN`，防火墙限制端口仅内网可达 |
> | **公网暴露** | 必须设置 `ASV_TOKEN` + 前置 Nginx/Caddy 反向代理 + 启用 HTTPS/TLS |
>
> 应用本身**不提供 HTTPS**，明文 HTTP 场景下 Token 亦以明文传输，生产环境务必在反向代理层终止 TLS。

### Web 版与桌面版的差异

| 功能 | 桌面应用 | Web 服务器 |
|------|---------|-----------|
| 恢复会话 | 打开系统终端 | 复制命令到剪贴板 |
| 会话分叉 | 创建新会话 + 终端打开 | 不适用 |
| CLI 对话 | 本地 spawn CLI 进程 | WebSocket 转发 |
| 快速问答 | Tauri 事件流 | SSE 流式响应 |
| 自动更新 | 应用内更新 | 不适用 |
| 文件监听 | Tauri 事件 | WebSocket 推送 |
| 认证 | 不需要 | 可选 Bearer Token |

## 功能特性

### 双数据源

通过侧边栏顶部的 Tab 一键切换 Claude / Codex 数据源：

| 数据源 | CLI 工具 | 本地存储路径 | 特色 |
|--------|---------|-------------|------|
| **Claude** (橙色主题) | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `~/.claude/projects/` | Thinking 块、Tool Use、sessions-index 索引 |
| **Codex** (绿色主题) | [Codex CLI](https://github.com/openai/codex) | `~/.codex/sessions/` | Reasoning 块、Function Call、按日期归档 |

切换时自动清理状态并重新加载，互不干扰。

### 项目浏览

- 自动扫描对应数据源目录，列出所有项目
- Claude：按 `~/.claude/projects/{encoded-path}` 聚合
- Codex：按会话元数据中的 `cwd` 工作目录聚合
- 显示每个项目的会话数量、最后活跃时间
- 按最近活跃时间排序

### 会话列表

- Claude：读取 `sessions-index.json` 索引文件并与磁盘 `.jsonl` 文件合并，确保 Ctrl+C 退出的会话不会丢失
- Codex：扫描 `~/.codex/sessions/` 目录下所有 `rollout-*.jsonl` 文件，提取元数据，自动过滤非交互式会话（SubAgent、Exec 等内部会话）
- 展示每个会话的首条 Prompt、消息数量、Git 分支、创建/修改时间
- 支持删除会话（带确认弹窗）

### 标签与别名

- 为任意会话设置**自定义别名**（替代首条 Prompt 作为标题）和**多个标签**
- 标签数据存储在 `.session-viewer-meta.json`，不侵入原始会话文件
- **项目列表页**：按标签筛选项目——只显示拥有匹配标签的项目
- **会话列表页**：按标签筛选当前项目内的会话
- **搜索结果页**：按标签筛选全局搜索结果
- 标签输入支持已有标签自动补全

### 消息详情

完整渲染会话中的所有消息，支持两种 AI 的不同内容块格式：

| 内容块类型 | Claude | Codex | 说明 |
|-----------|--------|-------|------|
| 文本 | ✅ | ✅ | Markdown 渲染 + 语法高亮 |
| 思考过程 | ✅ | — | Claude Thinking 块，可折叠 |
| 推理过程 | — | ✅ | Codex Reasoning 块，可折叠 |
| 工具调用 | ✅ | — | 工具名称、参数、返回结果 |
| 工具结果 | ✅ | — | 工具返回结果 |
| 函数调用 | — | ✅ | Codex 函数调用 |
| 函数返回 | — | ✅ | 函数调用返回结果 |

- 分页加载，大会话（上千条消息）也不会卡顿
- 默认从最新消息加载，进入会话直接看到最近对话
- 向上滚动自动加载更早的消息，滚动位置自动保持
- **加载进度指示器**：顶部显示"已加载 N / M 条消息"及细进度条，全部加载后自动隐藏
- 浮动"跳转到顶部/底部"双向按钮
- 时间戳 / 模型标签可切换显示，偏好持久化
- **ANSI 转义码过滤**：工具输出中的颜色码等控制字符自动清除，终端输出干净可读

### 恢复会话

选中任意会话，一键在系统终端中恢复：

- **Claude** → 执行 `claude --resume {sessionId}`
- **Codex** → 执行 `codex resume {sessionId}`

终端完全独立于本应用——关闭 Viewer 后终端继续运行。跨平台支持：

| 平台 | 实现方式 |
|------|---------|
| Windows | `cmd /c start /d` 启动独立终端进程 |
| macOS | AppleScript 调用 Terminal.app |
| Linux | 自动检测 gnome-terminal / konsole / xfce4-terminal / xterm，`setsid` 脱离父进程 |

### 会话分叉（Fork）

在消息详情页中，hover 任意用户消息时右侧会出现操作按钮组：

| 按钮 | 图标 | 功能 |
|------|------|------|
| Resume | ▶ Play | 在终端中恢复当前会话 |
| Fork | 🔀 GitFork | 从此消息处分叉出新会话 |
| Star | ⭐ Star | 收藏此消息 |

**Fork 流程**：复制当前消息及之前的所有会话内容到新的 JSONL 文件（生成新 sessionId）→ 自动注册到 `sessions-index.json` → 在系统终端中用 `claude --resume {新ID}` 打开。适用于想从历史对话的某个节点开始新的分支探索。

> 仅在 Tauri 桌面模式 + Claude 数据源下可用。

### 全局搜索

- 在当前数据源下跨所有项目、所有会话全文搜索
- **同时匹配会话名称**：搜索词可命中会话的自定义别名（alias）和首条 Prompt，结果中标注"会话名"区分
- 支持两种视图模式：**消息模式**（逐条匹配平铺）和**会话模式**（按会话分组，显示"X 条匹配 / 共 N 条"）
- **点击会话直接跳转到第一条匹配消息**并高亮，无需手动翻找
- **复制会话名**：会话卡片标题悬停时显示复制按钮，一键复制别名或首条 Prompt
- 基于 Rayon 并行扫描 JSONL 文件
- UTF-8 安全的字符级切片，中文/emoji 不会崩溃
- 关键词高亮，按标签筛选全局搜索结果

### Token 统计

- Claude：读取 `stats-cache.json` 统计缓存
- Codex：从每个会话文件提取 `usage` 字段聚合
- 展示：会话总数、消息总数、Input/Output Token 用量
- 每日 Token 用量柱状图
- Token 趋势面积图
- 按模型分组的 Token 消耗

### 应用内更新

| 安装方式 | 更新行为 |
|---------|---------|
| **安装版** (MSI/NSIS/DMG/DEB) | 应用内一键下载 + 自动安装 + 重启 |
| **便携版** (Windows Portable ZIP) | 检测到新版后引导跳转 GitHub Release 下载 |

- 启动后自动检查，设置弹窗「更新检查」选项卡中显示完整更新面板
- 有更新时可在设置中查看版本变化、Release Notes 并一键更新
- 支持忽略特定版本，不再重复提示
- 基于 `tauri-plugin-updater` + Ed25519 签名验证

### CLI 对话

在应用内直接与 Claude Code CLI 进行对话，无需切换到终端：

- 侧边栏点击「CLI 对话」进入，选择工作目录后即可开始
- 自动检测本地已安装的 Claude CLI
- 流式输出，实时渲染 AI 回复（Markdown + 代码高亮）
- **工具调用专用查看器**：Read（语法高亮 + 行号）、Edit（Diff 对比）、Write（代码预览）、Bash（终端风格）、Grep/Glob（搜索参数 + 结果）
- **对话轮次分组**：自动按用户→助手对话分组，显示轮次编号和 token 用量
- **Token 详细统计**：header 显示累计输入/输出/缓存读写 token，每条消息显示分项明细
- **虚拟化滚动**：超过 30 轮自动启用虚拟滚动，长对话不卡顿
- 支持 `--resume` 继续已有会话（消息详情页的「继续对话」按钮）
- **模型智能记忆**：自动记住上次使用的模型，下次打开无需重新选择；历史会话续聊时自动匹配原始会话模型
- 输入框支持 `/model` 命令或 `Ctrl+K` 切换模型

### 快速问答

不依赖 CLI，直接调用 Anthropic API 进行纯文本对话：

- 侧边栏点击「快速问答」进入
- 自动读取本地 Claude CLI 配置文件中的 API Key（无需手动输入）
- SSE 流式输出，Markdown 实时渲染
- 无需选择工作目录，适合快速提问

### 实时刷新

- 使用 `notify` crate 同时监听两个目录的文件系统变化
- 新会话创建、会话更新时自动刷新界面
- Docker 挂载卷优化：静默后台刷新 + 1 秒防抖，避免频繁 inotify 事件导致界面闪烁

## 开发

### 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/tools/install) >= 1.75
- 至少使用过以下一种 CLI：
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`~/.claude/projects/` 目录存在）
  - [Codex CLI](https://github.com/openai/codex)（`~/.codex/sessions/` 目录存在）

**平台依赖（仅桌面应用需要）：**

- **Windows:** [Visual C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) + [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)（Win10/11 通常已内置）
- **macOS:** `xcode-select --install`
- **Linux (Ubuntu/Debian):** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

> Web 服务器版本不需要上述 WebKit/GUI 依赖，只需 Rust 工具链。

### 本地开发

```bash
git clone https://github.com/zuoliangyu/AI-Session-Viewer.git
cd AI-Session-Viewer
npm install

# 桌面应用开发（Tauri + Vite HMR）
npx tauri dev

# Web 服务器开发
npm run dev:web
```

> **注意**: 桌面应用不能只运行 `npm run dev`，那只会启动 Vite 前端。必须用 `npx tauri dev` 才能同时编译 Rust 后端并启动完整应用。

### 构建

**桌面应用：**

```bash
npx tauri build
```

产物位于 `target/release/bundle/`（`.msi` / `.exe` / `.dmg` / `.deb` / `.AppImage`）。

**Web 服务器：**

```bash
npm run build:web && cargo build -p session-web --release
```

产出单文件可执行：`target/release/session-web`

**Docker：**

```bash
docker build -t ai-session-viewer-web .
```

### 代码检查

```bash
cargo clippy --workspace -- -D warnings   # Rust lint
npx tsc --noEmit                           # TypeScript 类型检查
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | [Tauri v2](https://v2.tauri.app/) (Rust + WebView) |
| Web 服务器 | [Axum](https://github.com/tokio-rs/axum) 0.8 + WebSocket |
| 前端 | React 19 + TypeScript + Vite 6 |
| 样式 | Tailwind CSS 3 + @tailwindcss/typography |
| 状态管理 | Zustand 5 |
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

### REST API

Web 服务器暴露以下 REST API，可供自定义客户端调用：

| 方法 | 路径 | Query 参数 | 说明 |
|------|------|-----------|------|
| GET | `/api/projects` | `source` | 获取项目列表 |
| GET | `/api/sessions` | `source, projectId` | 获取会话列表 |
| DELETE | `/api/sessions` | `filePath` | 删除会话 |
| GET | `/api/messages` | `source, filePath, page, pageSize, fromEnd` | 分页加载消息 |
| GET | `/api/search` | `source, query, maxResults` | 全局搜索 |
| GET | `/api/stats` | `source` | Token 统计 |
| PUT | `/api/sessions/meta` | *(JSON body)* | 更新会话别名和标签 |
| GET | `/api/tags` | `source, projectId` | 获取项目内所有标签 |
| GET | `/api/cross-tags` | `source` | 获取跨项目全局标签 |
| GET | `/api/bookmarks` | `source` (可选) | 获取收藏列表 |
| POST | `/api/bookmarks` | *(JSON body)* | 添加收藏 |
| DELETE | `/api/bookmarks/:id` | — | 删除收藏 |
| GET | `/api/cli/detect` | — | 检测本地已安装的 CLI 工具 |
| GET | `/api/cli/config` | `source` | 读取 CLI 配置（API Key 遮罩） |
| POST | `/api/models` | *(JSON body)* | 获取模型列表 |
| POST | `/api/quick-chat` | *(JSON body)* | 快速问答（SSE 流式响应） |
| WS | `/ws` | — | 文件变更实时推送 |
| WS | `/ws/chat` | — | CLI 对话 WebSocket |

## 发布

标签触发：`git tag v1.x.0 && git push origin v1.x.0`。GitHub Actions 会自动：

1. 在 Windows、macOS（Intel + Apple Silicon）、Linux 上并行构建桌面应用
2. 构建 Web 服务器 Linux 二进制 + Docker 镜像（推送到 GHCR）
3. 生成各平台安装包 + `.sig` 签名文件 + `latest.json` 更新清单
4. 创建 GitHub Release 并上传所有产物

版本工作流：修改 `package.json` 中的 version → 执行 `npm run sync-version` → 提交并打标签。

## 路线图

- [x] 双数据源支持（Claude Code + Codex CLI）
- [x] 消息详情渲染（Markdown / 代码高亮 / 工具调用 / 思考过程）
- [x] Resume 会话（跨平台终端启动）
- [x] 全局搜索 + Token 统计面板
- [x] 暗色 / 亮色主题切换
- [x] 应用内自动更新
- [x] Web 服务器变体（Axum + Docker）
- [x] 关于作者信息弹窗
- [x] 会话标签与别名系统 + 跨项目标签筛选
- [x] 全局搜索会话分组模式 + 应用内使用说明
- [x] 应用内 CLI 对话 + 快速问答模式
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

## Star History

<a href="https://star-history.com/#zuoliangyu/AI-Session-Viewer&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=zuoliangyu/AI-Session-Viewer&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=zuoliangyu/AI-Session-Viewer&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=zuoliangyu/AI-Session-Viewer&type=Date" />
 </picture>
</a>

## 贡献

欢迎提交 Issue 和 Pull Request。

## 许可证

[MIT](LICENSE)
