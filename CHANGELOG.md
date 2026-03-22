# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.4.0] - 2026-03-22

### Added

#### 工程操作菜单（⋯ 按钮）
- **统一操作入口**：用 `⋯`（MoreHorizontal）按钮替换原有的 hover 删除图标和右键上下文菜单，鼠标悬停时在项目卡片右上角和侧边栏项目行右侧显示，点击展开 portal dropdown 菜单
- **路径复制**：dropdown 顶部显示工程完整路径，右侧复制图标一键写入剪贴板，成功后 300ms 切换为绿色对勾；剪贴板 API 不可用时静默降级
- **工程别名**（仅 Claude 数据源）：可为工程设置自定义显示名称（不修改磁盘目录），别名持久化存储在各工程目录下的 `.project-meta.json`；已设置别名时卡片标题显示别名，原始目录名以小字辅助显示
- **删除工程**（仅 Claude 数据源）：从 dropdown 进入删除确认对话框，行为与之前一致
- **Codex 数据源**：dropdown 仅显示路径复制，不显示别名/删除入口（与现有 Codex 不可删除的行为一致）

#### 后端实现
- `session-core` 新增 `get_project_alias` / `set_project_alias`，别名存储在 `.project-meta.json`（使用 `serde_json::Map` 原始操作以保留未来扩展字段）；两个函数均包含 `canonicalize + starts_with` 路径遍历防护
- `ProjectEntry` 新增 `alias: Option<String>` 字段，`list_projects` 时自动读取并合并
- Tauri command `set_project_alias` + Axum `PUT /api/projects/alias` 路由双端均已实现

#### 前端
- `ProjectActionsMenu`：新建 portal-based dropdown 共享组件，`ProjectsPage` 和 `Sidebar` 共用
- `appStore.setProjectAlias`：乐观更新（立即更新本地 projects 列表）+ 失败回滚

---

## [2.3.0] - 2026-03-22

### Added

#### 工程删除
- **Hover 删除图标**：鼠标悬停到项目卡片时，右上角显示 `Trash2` 删除图标（仅 Claude 数据源可见），点击弹出确认对话框
- **右键菜单**：项目卡片支持右键呼出上下文菜单，显示工程信息（名称、路径、会话数）及删除入口（仅 Claude 数据源），菜单自动避开视口边缘
- **删除确认对话框**：展示工程名、路径、会话数量，操作不可逆，需二次确认；删除完成后自动导航回项目列表并清空下游状态
- **后端实现**：`session-core` 新增 `delete_project` 函数，调用 `std::fs::remove_dir_all` 递归删除目录（含 `.session-viewer-meta.json`）；同时包含路径遍历防护（`canonicalize + starts_with` 验证）；Tauri command + Axum `DELETE /api/projects` 路由双端均已实现，缺失项目返回 HTTP 404

#### 空会话批量清理
- **清理按钮**：SessionsPage 标题行，当项目内存在 `messageCount === 0` 的空会话时，显示「清理空会话 (N)」按钮
- **清理对话框**：列出所有空会话（SessionID 前缀 + 最后修改日期），支持逐条勾选或全选/取消全选，确认后批量删除并刷新会话列表

### Fixed

#### 流式回复内容重复
- **Web 模式**：`useChatStream` 中 `getChatWebSocket()` 返回模块级单例，断线重建后新旧对象不同，`removeEventListener` 对新对象无效导致监听器泄漏叠加；修复：保存 ws 快照到局部变量，`handleMessage` 定义在 `setupWebSocket` 内部与快照绑定，cleanup 对同一快照调用 `removeEventListener`
- **Tauri 模式**：`setupListeners` 在 `await import(...)` 完成后未检查 `cancelled`，组件卸载后监听器仍可能注册；修复：在 `await import` 之后、`await listen` 之前加 `if (cancelled) return` 检查，并在 cleanup 函数中直接设置 `cancelled = true`

#### 消息不自动刷新
- `refreshInBackground` 仅刷新 projects + sessions，Claude Code 写入 JSONL 后消息区不更新；在函数末尾追加静默消息刷新：仅当 `messagesPage === 0`（用户未上翻历史）时调用 `api.getMessages`，更新 `messages / messagesTotal / messagesHasMore`，不触发 loading 遮罩，失败静默忽略

#### 搜索进入会话无法对话
- 从全局搜索跳转到某个会话时，`appStore.sessions` 为空（用户未先进入项目页），`sessions.find(filePath)` 返回 `undefined`，导致 ChatInput 隐藏；修复：`MessagesPage` 的 `filePath` useEffect 改为异步，当目标 `filePath` 不在当前 sessions 中时先 `await selectProject(projectId)` 加载正确项目，再调用 `selectSession`，全程通过 `cancelled` 标志防止竞态

---

## [2.2.1] - 2026-03-16

### Fixed

#### Web 服务器默认绑定地址
- **默认监听所有网卡**：`session-web` 默认绑定地址从 `127.0.0.1` 改为 `0.0.0.0`，直接用本机 IP 或局域网地址访问无需再手动指定 `--host`
- **旧行为**：仅接受 localhost 连接，非 localhost IP 访问时浏览器无响应
- **新行为**：监听所有网卡，可通过任意 IP 直接访问；如需限制来源仍可用 `--host <ip>` 或 `ASV_HOST=<ip>` 覆盖

#### Web 前端 crypto.randomUUID 兼容性
- **HTTP 非 localhost 场景**：通过 HTTP（非 HTTPS）且非 localhost 访问时，浏览器限制 `crypto.randomUUID()` 仅在安全上下文可用，导致发送消息时报错
- **polyfill 降级**：新增 `generateUUID()` 函数，安全上下文使用原生 `crypto.randomUUID()`，否则自动降级为基于 `crypto.getRandomValues()` 的 RFC 4122 兼容实现（`getRandomValues` 在非安全上下文仍可用）
- **覆盖范围**：`parseClaudeStreamLine`（assistant / user / result 消息）、`startNewChat`、`continueExistingChat` 共 5 处调用全部替换

### Security

> **⚠️ 重要提示**：`0.0.0.0` 意味着服务器会在**所有网络接口**上监听，包括公网网卡。请务必根据部署环境配置以下安全措施：
>
> - **内网自用**：防火墙限制端口仅允许可信 IP，或使用 `--host <局域网IP>` 绑定到指定网卡
> - **公网暴露**：必须设置 `--token` / `ASV_TOKEN` 启用 Bearer Token 认证
> - **生产环境**：前置 Nginx / Caddy 反向代理，启用 HTTPS / TLS，避免明文传输

---

## [2.2.0] - 2026-03-16

### Added

#### Tool Output 折叠与 Markdown 渲染
- **折叠支持**：`>_ Tool Output` 区域内容超过 400 字符时默认折叠，标题栏显示字符数，点击可展开；短内容默认展开，用户可手动折叠
- **MD / 源码切换**：标题栏常驻 `</>` / `MD` 切换按钮，随时在 Markdown 渲染和原始文本之间切换；MD 模式使用 ReactMarkdown + remark-gfm，支持标题、表格、代码块等格式
- **两种 block 统一**：`tool_result` 和 `function_call_output` 两种类型统一使用 `OutputBlock` 子组件，行为完全一致
- **错误状态保留**：`tool_result` isError 时保持红色边框和背景

### Fixed

#### ToolViewer 长行自动换行
- **代码视图**：ToolViewer 切换到 `</>` 代码模式时，JSON 中超长字符串（如 `content` 字段大段文本）现在按容器宽度自动换行，不再出现水平滚动条
- **Read / Write 内容视图**：ReadContent 和 WriteContent 的语法高亮区域同步启用 `wrapLongLines`，读取或写入的长行代码不再水平溢出

### Refactored

- **MarkdownContent 提取为共享组件**：将 `ToolViewers.tsx` 内部的 Markdown 渲染函数提取为 `src/components/message/MarkdownContent.tsx` 独立导出组件，`ToolOutputMessage` 可直接复用，消除重复逻辑

---

## [2.1.0] - 2026-03-15

### Added

#### ToolViewer 代码/预览切换
- **Code/Preview 切换按钮**：ToolViewer 顶栏新增代码/预览双模式切换按钮（Code2 图标），支持在结构化字段视图与原始代码视图之间切换，方便调试时查看完整原始内容

#### 统计页时间范围筛选
- **时间范围过滤器**：统计页新增时间范围下拉筛选（今日 / 本周 / 本月 / 近 3 月 / 近半年 / 今年 / 自定义），精确统计指定时段内的 token 用量和活跃度
- **数据范围标签**：统计摘要卡片新增当前筛选范围说明文字，清晰标注数据来源周期

### Fixed

#### 统计页日期逻辑
- **周预设 Sunday bug**：修复"本周"预设将周日计算为下周起点的问题，改为以周一为一周开始
- **自定义日期重置**：切换预设时正确清空自定义日期输入框，避免残留值干扰筛选

#### ToolViewer 显示优化
- **Bash 工具默认展开**：Bash 工具调用默认展开显示，无需手动点击即可看到命令内容
- **完整命令显示**：修复长命令被截断的问题，现在显示完整命令文本
- **浅色模式文字**：修复 ToolViewer 在浅色主题下文字颜色不可读的问题
- **Code2 按钮折叠状态标题**：优化折叠状态下切换按钮的 title 提示文字，准确反映当前可切换的目标模式

#### 代理兼容
- **Bearer Auth 支持**：快速问答和 CLI 对话检测 API Key 时新增对 `ANTHROPIC_AUTH_TOKEN` 环境变量的读取，使用自定义代理（`ANTHROPIC_BASE_URL`）时发送 `Authorization: Bearer` 认证头，与主流代理服务兼容

---

## [2.0.1] - 2026-03-15

### Fixed

#### 工具调用展开渲染优化
- **统一 tool_use 渲染**：`AssistantMessage` 中的工具调用块改为复用 `ToolViewer`（原先为独立的裸 JSON `<pre>` 显示），现与会话详情页行为一致，支持结构化字段展示和 markdown 渲染
- **Markdown 文件内容渲染**：`Read` / `Write` 工具展开时，若目标文件为 `.md` / `.mdx`，内容改用 `ReactMarkdown + remark-gfm` 渲染（支持表格、代码块、链接），不再显示原始 `\n` 转义字面量
- **DefaultContent 结构化显示**：未识别工具不再裸输出原始 JSON；改为解析后按字段名对齐显示（中文标签 + 固定宽度列），并自动过滤 `timeout`、`run_in_background`、`dangerouslyDisableSandbox` 等噪声字段；短值内联，长值 / 代码值使用深色代码块

#### Linux 环境变量读取
- **Shell rc 文件 fallback**：在 Linux 上，桌面应用（Tauri）和 Web 服务器二进制（session-web）通过 systemd service 或桌面快捷方式启动时，不会自动 source `.bashrc`，导致用户在 shell 中配置的 `ANTHROPIC_API_KEY` 等变量无法读取。新增静态解析 `~/.bashrc`、`~/.bash_profile`、`~/.profile`、`~/.zshrc`、`~/.zprofile` 作为最低优先级 fallback，仅在 `#[cfg(unix)]` 下生效，Windows 无影响

---

## [2.0.0] - 2026-03-15

### Added

#### 搜索增强
- **搜索会话名称**：全局搜索现在同时匹配会话的自定义别名（alias）和首条 Prompt，搜索结果中标记为"会话名"角色，消息模式和会话模式均可展示
- **总消息数显示**：搜索会话模式中，每个会话卡片新增"X 条匹配 / 共 N 条"统计，方便快速判断会话规模
- **复制会话名**：会话卡片标题悬停时右侧出现复制图标，可直接复制别名或首条 Prompt，不触发会话跳转
- **跳转匹配消息**：从搜索结果点击进入会话时，自动滚动定位到第一条匹配消息并高亮（复用现有 `scrollTo` 机制）

#### 消息详情
- **加载进度指示器**：消息详情页顶部新增"已加载 N / M 条消息"文字计数和细进度条，解决分页加载时滚动条位置与实际内容长度不对应的问题；全部加载完成后自动隐藏进度条

### Fixed

#### 显示优化
- **ANSI 转义码清除**：工具调用结果（tool_result）、函数调用输出（function_call_output）、工具调用参数及 AI 文本块中的 ANSI 转义码（颜色码、光标控制、OSC 标题序列、BEL 字符等）现在被正确过滤，终端输出不再显示为 `\x1b[32m` 等乱码
- **ANTHROPIC_AUTH_TOKEN 环境变量未识别**：快速问答 / CLI 对话的 API Key 检测新增对 `ANTHROPIC_AUTH_TOKEN` 环境变量的读取（之前仅检测 `ANTHROPIC_API_KEY`），与 Claude CLI 的环境变量命名保持一致

---

## [1.9.7] - 2026-03-04

### Fixed

#### Web 模式 CLI 对话稳定性修复
- **CLI 启动错误无前端反馈**：当 CLI 未安装或启动失败时，错误仅记录在服务端日志，WebSocket 不发送任何消息，前端永远停留在"等待响应"状态。修复后通过 WebSocket 发送 error + complete 消息，前端正确显示错误信息（如"Claude CLI not found"）
- **CLI 权限确认导致卡死**：Web 模式下 CLI 子进程继承了 session-web 的 stdin，当 CLI 需要交互式权限确认时无限等待，因为 Web 前端无法提供终端输入。修复：将 stdin 设为 `Stdio::null()`，并在 Web 模式下自动传递 `--dangerously-skip-permissions` 参数

### Improved

#### 开发工具链
- `.gitignore` 新增 `.playwright-mcp/` 忽略规则

---

## [1.9.6] - 2026-03-04

### Improved

#### Web 服务器 musl 静态编译 — 彻底解决跨发行版兼容性
- **CI**：web-server 构建目标从 glibc 动态链接改为 `x86_64-unknown-linux-musl` 静态链接，产出零系统依赖的独立二进制
- **效果**：不再依赖特定 GLIBC 版本，Rocky 8/9、Ubuntu 18+、Debian、Alpine、CentOS 等任何 Linux 发行版下载即可运行
- **Docker**：编译阶段从 `rust:1-bookworm` 改为 `rust:1-alpine`（原生 musl 环境），运行时阶段从 `debian:bookworm-slim`（~80MB）改为 `alpine:latest`（~5MB），镜像体积大幅缩减
- **根因回顾**：v1.9.2～v1.9.4 反复修复的 GLIBC 不兼容问题（GitHub Actions runner GLIBC 2.39 vs 运行环境 GLIBC 2.34/2.36），通过 musl 静态编译从根本上消除

#### 更新面板体验优化
- **Release Notes Markdown 渲染**：更新面板中的版本说明从纯文本改为 Markdown 渲染（ReactMarkdown），标题、加粗、代码块等格式正确显示
- **动态 Release Notes**：CI 发布时从 CHANGELOG.md 自动提取当前版本的更新内容作为 GitHub Release body，用户检查更新时直接看到具体改了什么，不再是"See CHANGELOG"链接
- **显示区域扩大**：Release Notes 区域最大高度从 80px 提升到 192px，避免内容被截断

---

## [1.9.4] - 2026-03-03

### Fixed

#### CI Docker 镜像 GLIBC 不兼容
- **根因**：v1.9.2 的 CI 优化将 Docker 镜像构建改为复用 `web-server` job 在 GitHub Actions runner（ubuntu-22.04）上编译的二进制，但 runner 的 GLIBC 已被滚动更新到 2.39，而运行镜像 `debian:bookworm-slim` 只有 GLIBC 2.36，导致容器启动即崩溃（`GLIBC_2.39 not found`）
- **修复**：CI 的 docker job 改回使用仓库的多阶段 Dockerfile 构建（`rust:1-bookworm` 编译 + `debian:bookworm-slim` 运行），确保编译和运行环境 GLIBC 版本一致，移除不再需要的 artifact 传递

---

## [1.9.3] - 2026-03-03

### Improved

#### 侧边栏布局优化（macOS 兼容）
- **标题居中**：「AI Session Viewer」标题改为居中显示，避免与 macOS 左上角窗口控制按钮（红绿灯）重叠
- **左下角版本号**：Sidebar 底部左侧显示当前版本号，取代原来的"N 个项目"文字
- **更新检测移入设置**：桌面端的更新检查面板从 Sidebar 底部移入设置弹窗的「更新检查」选项卡，保持底栏简洁

---

## [1.9.2] - 2026-03-03

### Fixed

#### Docker 镜像 GLIBC 兼容性
- **根因**：Dockerfile 中 `rust:1` 基础镜像已升级到 Debian Trixie（GLIBC 2.39），而运行镜像 `debian:bookworm-slim` 仍是 GLIBC 2.36，导致编译出的二进制在运行镜像中无法启动
- **修复**：将编译镜像固定为 `rust:1-bookworm`，确保编译和运行环境 GLIBC 版本一致（2.36）

### Improved

#### CI Docker 构建加速
- CI 的 `docker` job 不再从源码完整编译 Rust，改为复用 `web-server` job 已编译的二进制（通过 Actions artifact 传递）
- Docker 镜像构建从数十分钟缩短到几秒，且确保镜像中的二进制与 Release 中上传的完全一致

---

## [1.9.1] - 2026-03-03

### Fixed

#### Codex 非交互式会话误显示
- **根因**：Codex 内部的 SubAgent、Exec、Mcp 等非交互式会话也出现在会话列表中，这些会话是 CLI 内部使用的，对用户无意义
- **修复**：解析 Codex session_meta 中的 `source` 字段，仅保留 `cli` 和 `vscode` 来源的交互式会话（与 Codex 自身的 `INTERACTIVE_SESSION_SOURCES` 一致）；`source` 缺失时默认视为交互式（兼容旧格式）

#### Resume 失败无前端反馈
- **根因**：当会话对应的项目路径已被删除时，后端返回"项目路径不存在"错误，但前端仅 `console.error` 静默吞掉，用户看不到任何反馈
- **修复**：会话列表页和消息详情页的 Resume 按钮均新增错误提示条（红色 toast），显示具体错误信息，5 秒后自动消失

#### Codex 会话 ID 提取不准确
- **根因**：当 Codex 会话文件缺少 session_meta 时，fallback 使用完整文件名（如 `rollout-2025-01-05T12-00-00-UUID`）作为 sessionId，导致 `codex resume` 无法识别
- **修复**：新增 `extract_uuid_from_filename()` 函数，从文件名末尾提取标准 UUID 格式的 36 字符 ID

---

## [1.9.0] - 2026-03-02

### Added

#### 会话分叉（Fork）
- 在消息详情页，hover 任意用户消息可看到三个操作按钮：Resume（恢复）、Fork（分叉）、Star（收藏）
- **Fork**：从选中的用户消息处分叉出一个全新会话，复制该消息及之前的所有 JSONL 内容到新文件（生成新 sessionId），自动注册到 `sessions-index.json`，并在系统终端中用 `claude --resume {新ID}` 打开
- **Resume**：直接在终端中恢复当前会话（与顶栏 Resume 按钮效果一致）
- 仅在 Tauri 桌面模式 + Claude 数据源下显示
- Fork 成功后按钮短暂变绿，后台自动刷新会话列表
- 后端新增 `fork_session_from_message()` 核心函数（`session-core`），逐行解析 JSONL 并替换 sessionId
- 后端新增 `fork_and_resume` Tauri 命令，重构终端启动代码为可复用的 `open_terminal()` 私有函数
- 前端 `tauriApi.ts` 新增 `forkAndResume()` API；`webApi.ts` 提供 no-op 实现

#### 终端类型选择（Windows）
- 设置面板新增「终端类型」选项，可切换 CMD 或 PowerShell
- 恢复会话和分叉会话时使用用户选择的终端类型
- 偏好持久化到 localStorage

---

## [1.8.0] - 2026-03-01

### Added

#### 收藏系统
- 支持收藏整个会话和会话中的具体用户消息
- 侧边栏新增「收藏」导航入口（Star 图标），显示当前数据源的收藏数量角标
- 会话列表页：每个会话卡片悬停时显示收藏星标按钮，已收藏时常驻显示
- 消息详情页：每条用户消息右侧悬停时显示收藏星标按钮，已收藏时常驻显示
- 收藏页面（`/bookmarks`）：按项目分组展示所有收藏项，区分会话级和消息级收藏
- 点击收藏项直接跳转到对应会话，消息级收藏自动滚动到目标消息并高亮闪烁 2 秒
- 收藏数据存储在 `~/.session-viewer-bookmarks.json`，原子写入（tmp + rename）
- 后端：`session-core/src/bookmarks.rs` 提供 load/save/add/remove/list 操作
- Tauri 命令：`list_bookmarks`、`add_bookmark`、`remove_bookmark`
- Web 路由：`GET /api/bookmarks`、`POST /api/bookmarks`、`DELETE /api/bookmarks/:id`

### Fixed

#### tool_result 消息误识别为用户消息
- Claude 的 `tool_result` 消息在 JSONL 中以 `role: "user"` 存储，但内容全是 `tool_result` 块
- 修复：解析时检查如果 `role == "user"` 且所有 content blocks 都是 `ToolResult` 类型，则将 role 改为 `"tool"`
- 这些消息现在正确渲染为左侧缩进的工具输出，timeline 导航点也不再将其误计为用户消息

### New Files

| 文件 | 说明 |
|------|------|
| `crates/session-core/src/bookmarks.rs` | 收藏核心逻辑（模型、存储、CRUD） |
| `src-tauri/src/commands/bookmarks.rs` | Tauri 收藏命令 |
| `crates/session-web/src/routes/bookmarks.rs` | Web 收藏路由 |
| `src/components/bookmark/BookmarksPage.tsx` | 收藏列表页面 |

---

## [1.7.1] - 2026-02-27

### Improved

#### 模型智能记忆与自动选择
- 模型选择器切换模型时自动持久化到 localStorage，下次打开应用立即恢复上次使用的模型
- ChatPage 和 QuickChatPage 页面加载时自动获取最新模型列表，不再依赖硬编码默认值
- 模型自动选择优先级：上次使用 > 用户设置默认 > CLI 配置默认 > 列表第一个
- 支持短名称模糊匹配（如 CLI 配置的 "opus" 自动匹配 "claude-opus-4-6"）

#### 历史会话续聊模型匹配
- 在历史会话页面续聊时，自动提取该会话使用的模型并预选（如会话用了 opus 则自动选中 opus）
- 不再固定为 claude-sonnet-4，尊重原始会话的模型选择

### Removed
- 移除 ChatPage 和 QuickChatPage 中的硬编码 `DEFAULT_MODEL` 常量

## [1.7.0] - 2026-02-27

### Added

#### 工具调用专用查看器
- 新增 6 种工具专用查看器，替代原有的纯 JSON 折叠展示：
  - **Read** — 语法高亮代码 + 行号，自动识别文件语言
  - **Edit** — LCS 算法 Diff 对比视图，显示添加/删除行数统计
  - **Write** — 语法高亮代码块，支持复制按钮
  - **Bash** — 终端风格展示（`$` 前缀命令 + 输出），错误高亮
  - **Grep/Glob** — 搜索参数 + 结果展示
  - **Default** — 通用 JSON 输入/输出（兜底）
- 工具调用链接：`tool_use` 与 `tool_result` 跨消息自动配对，在 tool_use 处统一展示输入和输出

#### 对话轮次分组
- 消息按对话轮次（Turn）自动分组，每轮以用户文本消息开始
- 轮次间显示分隔线和轮次编号
- 每轮显示该轮累计 token 用量

#### Token 用量详细展示
- 会话头部显示累计 token 明细：输入 / 输出 / 写入缓存 / 读取缓存
- 每条助手消息显示 token 分项（输入/输出/缓存），hover 查看完整明细
- 对话结束的 result 消息显示完整 token 分项，**不再显示价格**

#### 虚拟化滚动
- 使用 `@tanstack/react-virtual` 在对话轮次级别实现虚拟化
- 超过 30 轮对话时自动启用，低于阈值使用普通渲染
- 支持动态高度测量，适配可变内容

### Changed

#### 对话功能精简为 Claude 专属
- CLI 对话和快速问答移除所有 Codex 相关逻辑，简化为 Claude 专属
- 模型选择器、CLI 配置检测、流式输出均硬编码为 Claude
- 设置面板移除 Codex 配置区域
- **会话历史浏览**保留双数据源支持（Claude + Codex），不受影响

### New Files

| 文件 | 说明 |
|------|------|
| `src/components/chat/tool-viewers/DiffView.tsx` | LCS 算法 Diff 视图组件 |
| `src/components/chat/tool-viewers/ToolViewers.tsx` | 6 种工具专用查看器 |

---

## [1.6.0] - 2026-02-26

### Added

#### CLI 对话模式
- 侧边栏新增「CLI 对话」入口，可直接在应用内与 Claude Code / Codex CLI 进行对话
- 自动检测本地已安装的 CLI 工具（Claude Code、Codex CLI）
- 支持选择工作目录、切换数据源（Claude/Codex）
- 流式输出：CLI 的 stdout 实时转发到前端，支持 Markdown 渲染
- 支持 `--resume` 继续已有会话
- 支持 `--dangerously-skip-permissions` 跳过权限确认
- 支持通过输入框 `/model` 命令自由切换模型（如 `/model claude-opus-4-6`）
- 消息详情页新增「继续对话」按钮，可在 CLI 对话模式中继续该会话

#### 快速问答模式
- 侧边栏新增「快速问答」入口，直接调用 Anthropic/OpenAI API 进行纯文本对话
- 无需选择工作目录，无 CLI 依赖
- 支持 Claude（Anthropic API）和 Codex（OpenAI API）双数据源
- SSE 流式输出，Markdown 实时渲染
- 独立对话历史，与 CLI 对话模式互不干扰

#### CLI 配置自动检测
- 新增 `cli_config` 模块，自动读取本地 CLI 配置文件获取 API Key 和 Base URL
- Claude：从 `~/.claude/settings.json` 读取 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 和代理配置
- Codex：从 `~/.codex/auth.json` 读取 `OPENAI_API_KEY`，从 `~/.codex/config.toml` 读取模型和 provider 配置
- 模型列表获取无需手动输入 API Key，自动使用 CLI 配置
- 设置面板显示检测到的 CLI 配置状态（遮罩 Key、Base URL、默认模型）

#### 模型选择器增强
- 内置 Claude（Sonnet 4.6 / Opus 4.6 / Haiku 4.5）和 Codex（codex-mini / o4-mini / o3 / gpt-4.1）常用模型列表
- 支持 API 动态获取完整模型列表（有 API Key 时自动拉取）
- 搜索无结果时，按回车可直接使用搜索词作为自定义模型 ID

### Fixed

#### CLI 进程环境变量隔离
- **根因**：从 VS Code 终端启动 Tauri 开发服务器时，`CLAUDECODE` 等环境变量会被继承到 spawn 的 CLI 子进程，导致 CLI 运行异常（400 错误）
- **修复**：采用环境变量白名单机制（`env_clear()` + 仅传递 PATH、HOME 等必要系统变量），参考 opcode 项目的隔离方案

#### CLI 模型名 `-latest` 后缀不兼容
- Claude CLI 不接受 `-latest` 后缀的模型名（如 `claude-sonnet-4-6-latest`），传给 CLI 前自动剥离该后缀

### New Files

| 文件 | 说明 |
|------|------|
| `crates/session-core/src/cli.rs` | CLI 安装检测与路径查找 |
| `crates/session-core/src/cli_config.rs` | CLI 配置文件自动读取 |
| `crates/session-core/src/model_list.rs` | 模型列表获取（内置 + API） |
| `crates/session-core/src/quick_chat.rs` | 直接 API 流式对话 |
| `crates/session-web/src/chat_ws.rs` | Web 端 WebSocket 聊天路由 |
| `src-tauri/src/commands/chat.rs` | Tauri 聊天相关命令 |
| `src/components/chat/*.tsx` | CLI 对话页面组件（7 个） |
| `src/components/quick-chat/QuickChatPage.tsx` | 快速问答页面 |
| `src/stores/chatStore.ts` | CLI 对话状态管理 |
| `src/stores/quickChatStore.ts` | 快速问答状态管理 |
| `src/hooks/useChatStream.ts` | 聊天流事件监听 Hook |
| `src/types/chat.ts` | 聊天相关类型定义 |

---

## [1.5.0] - 2026-02-25

### Added

#### 全局搜索 — 会话分组模式
- 搜索页新增"消息 / 会话"分段切换按钮（搜索框下方）
- **会话模式**：搜索结果按会话（`filePath`）分组展示，每张卡片显示项目名、匹配数、最新时间、别名/首条 Prompt、标签 pill、前 3 条匹配文本摘要（带高亮），超出部分显示"还有 N 条匹配..."
- 点击会话卡片直接跳转到完整会话页面
- **消息模式**：保持原有逐条消息的平铺列表行为不变

#### 设置弹窗
- 侧边栏底部"关于作者"文字按钮替换为齿轮图标按钮
- 点击打开"设置"模态框，内含两个 Tab：
  - **使用说明**：分模块介绍侧边栏、项目列表、会话列表、消息详情、全局搜索、主题切换的操作方式
  - **关于作者**：保留原有作者信息（邮箱、QQ 群、哔哩哔哩、GitHub）

---

## [1.4.0] - 2026-02-25

### Added

#### 会话标签与别名系统
- 新增 `metadata.rs` 模块，每个项目的标签和别名持久化存储在 `.session-viewer-meta.json` 文件中
- 会话列表页（SessionsPage）支持为每个会话设置自定义别名和多个标签
- 新增 `SessionMetaEditor` 组件：弹窗编辑器，支持别名输入、标签管理（添加/删除）、已有标签自动补全
- 会话卡片显示标签 pill 和别名（别名替代首条 Prompt 作为标题，原 Prompt 显示为副标题）
- 消息详情页（MessagesPage）标题优先显示别名
- 文件监听器忽略 `.session-viewer-meta.json` 变更，避免编辑标签触发无限刷新

#### 跨项目标签筛选
- 新增 `get_all_cross_project_tags(source)` 后端接口，遍历所有项目收集去重标签
- 项目列表页（ProjectsPage）标题下方新增全局标签筛选栏，按标签过滤项目（仅显示拥有匹配标签的项目）
- 项目卡片显示该项目的标签 pill
- 搜索结果页（SearchPage）搜索框下方新增标签筛选栏，按标签过滤搜索结果
- 搜索结果 `SearchResult` 新增 `tags` 字段，搜索结果卡片显示标签 pill
- 会话列表页（SessionsPage）支持按标签筛选当前项目内的会话
- 切换数据源时自动清空所有标签筛选状态

#### REST API 扩展
- `PUT /api/sessions/meta` — 更新会话别名和标签
- `GET /api/tags` — 获取单个项目的所有标签
- `GET /api/cross-tags` — 获取跨项目的全局标签聚合

### Improved

#### 项目会话数统计更准确
- Claude 项目列表的会话数现在与会话列表一致：优先使用 `sessions-index.json` 索引统计有消息的会话，再加上磁盘上存在但不在索引中的非空文件
- 解决了之前"项目卡片显示 N 个会话"但进入后实际只有 M 个的不一致问题

#### 恢复会话按钮优化
- 所有恢复按钮（会话列表 + 消息详情页）统一支持右键复制恢复命令
- 按钮文字在"已复制"状态与默认状态间正确切换

---

## [1.3.1] - 2026-02-24

### Fixed

#### Docker 环境下项目列表"加载中"持续闪烁
- **根因**: Docker 挂载卷的 inotify 会频繁触发文件变化事件，每次事件通过 WebSocket 推送到前端后调用 `loadProjects()` 和 `selectProject()`，这两个函数都会设置 loading 状态并清空已有数据，导致"加载中"反复闪烁
- **修复**: 新增 `refreshInBackground()` 静默刷新方法，文件变化时仅更新数据而不触发 loading 状态；同时将前后端防抖时间从 300ms/500ms 统一提升至 1000ms，减少 Docker 环境下的事件风暴

---

## [1.3.0] - 2026-02-24

### Added

#### "关于作者"弹窗
- Sidebar 底部新增"关于作者"按钮（带边框文字按钮），点击弹出模态框
- 模态框展示作者信息：作者名称、邮箱、QQ 群号、哔哩哔哩主页、GitHub 仓库链接
- 每项带对应图标（lucide + 自定义 SVG），邮箱/哔哩哔哩/GitHub 均可点击跳转
- Tauri 桌面模式下使用 `@tauri-apps/plugin-shell` 打开外部链接，Web 模式下 fallback 到 `window.open`
- 点击背景遮罩或右上角关闭按钮均可关闭弹窗
- 浅色/暗色主题样式均适配

#### 前端版本号注入
- `vite.config.ts` 新增 `__APP_VERSION__` 编译时变量，从 `package.json` 读取版本号注入前端

### Fixed

#### 文件监听器删除会话后无限刷新
- 添加 debounce 防抖机制，防止删除会话后触发文件变更事件导致界面无限刷新

---

## [1.1.0] - 2026-02-24

### Added

#### Web 服务器变体（session-web）
- 新增 Axum HTTP 服务器，支持在无 GUI 的服务器环境通过浏览器远程访问会话数据
- 单文件可执行，前端通过 `rust-embed` 编译嵌入二进制中
- CLI 参数：`--host`、`--port`、`--token`（均支持环境变量 `ASV_HOST`/`ASV_PORT`/`ASV_TOKEN`）
- 可选 Bearer Token 认证，保护远程访问安全
- REST API：`/api/projects`、`/api/sessions`、`/api/messages`、`/api/search`、`/api/stats`
- WebSocket `/ws` 实时推送文件变更事件
- 新增 Docker 多阶段构建（`node:lts` → `rust:1` → `debian:bookworm-slim`）
- Docker 镜像自动推送到 GHCR（`ghcr.io/{repo}-web`）

#### Cargo Workspace 重构
- 提取共享 Rust 核心逻辑为 `crates/session-core`（models/provider/parser/search/stats/state）
- `src-tauri` 和 `crates/session-web` 共同依赖 `session-core`，消除代码重复
- 搜索逻辑（`search.rs`）和统计逻辑（`stats.rs`）从 Tauri commands 中提取为纯函数

#### 前端 API 层抽象
- 新增编译时变量 `__IS_TAURI__`（Vite define），自动区分桌面/Web 模式
- 新增 `src/services/webApi.ts`（HTTP fetch 封装）和 `src/services/api.ts`（统一入口）
- 前端组件 100% 复用，仅 API 调用层自动切换
- Web 模式下 Resume 按钮改为"复制恢复命令"到剪贴板
- Web 模式下自动隐藏更新检测相关 UI
- 新增 `src/hooks/useFileWatcher.ts`：Tauri 模式用事件监听，Web 模式用 WebSocket

#### CI/CD 扩展
- Release workflow 新增 `web-server` job：构建 Linux x86_64 Web 服务器二进制并上传到 Release
- Release workflow 新增 `docker` job：构建并推送 Docker 镜像到 GHCR
- Build workflow 新增 `check-web` job：独立检查 session-core + session-web 编译（无需 WebKit 系统依赖）

### Changed

- `sync-version.mjs` 现在同步版本号到 3 个 Cargo.toml（src-tauri、session-core、session-web）
- `build.yml` Rust cache workspaces 路径更新为 workspace 根目录
- `release.yml` portable zip 路径修正为 `target/release/`（workspace 模式下 target 在根目录）

---

## [1.0.1] - 2026-02-24

### Changed

#### 更新应用图标
- 替换 `public/logo.png` 源图，重新生成所有平台图标

#### 构建流程优化
- 新增 `scripts/generate-icons.mjs`：构建/开发时自动从 `public/logo.png` 生成全平台图标，仅在 logo 变更时执行
- 新增 `scripts/sync-version.mjs`：以 `package.json` 为版本号唯一来源，一键同步到 `Cargo.toml` + `tauri.conf.json`
- `npm run build` 自动校验三处版本号一致性，不一致则阻止构建
- 新增 `npm run sync-version` 命令

---

## [1.0.0] - 2026-02-24

### Added

#### 应用内更新系统（混合模式）
- **安装版**（MSI/NSIS/DMG/DEB）：集成 `tauri-plugin-updater`，支持应用内一键下载更新并自动重启
- **便携版**（Windows Portable ZIP）：检测到新版本后引导用户跳转 GitHub Release 页面下载
- 启动后 5 秒自动检查更新，每次会话仅检查一次
- Sidebar 底部新增版本号显示，有更新时显示蓝色脉冲圆点动画
- 点击版本号展开更新面板：显示版本变化、Release Notes、操作按钮
- 安装版显示"更新并重启"按钮 + 实时下载进度条
- 便携版显示"前往下载新版本"按钮，打开浏览器跳转 GitHub Release
- 支持"忽略此版本"功能，忽略后不再提示该版本（记忆到 localStorage）
- 新增 `get_install_type` Rust 命令：Windows 下检测 exe 同目录是否有 NSIS uninstaller 判断安装类型

#### CI/CD 自动签名
- Release workflow 注入 `TAURI_SIGNING_PRIVATE_KEY` 签名密钥
- 构建产物自动生成 `.sig` 签名文件和 `latest.json` 更新清单
- 旧版客户端可自动发现并验证新版本的完整性

### Changed

#### Sidebar Footer 布局调整
- 上排：项目数量统计 + 主题切换按钮
- 下排：版本号 + 手动检查更新按钮 + 可展开的更新面板
- 更新面板改为内嵌展开式（非弹窗），避免被 sidebar 滚动区域裁剪
- 新增手动检查更新按钮（刷新图标），用户可随时主动检查

---

## [0.8.0] - 2026-02-24

### Added

#### 消息显示模型名称
- 后端解析 JSONL 记录中的 `model` 字段并传递到前端
- AI 消息头部新增模型标签（如 `claude-sonnet-4-20250514`），一眼看清每条消息使用的模型
- Codex 消息暂无模型字段，保持兼容

#### 时间戳 / 模型标签切换按钮
- 消息页顶栏新增时钟和 CPU 图标按钮，可独立切换时间戳和模型标签的显示
- 偏好持久化到 localStorage，页面刷新后保持设置

#### 项目路径显示优化
- Claude 项目列表现在优先从 `sessions-index.json` 的 `originalPath` 读取真实项目路径
- 不再仅依赖目录名反向解码，解决含特殊字符的路径显示不准确的问题

### Changed

#### 聊天气泡式消息布局
- 用户消息改为右对齐气泡样式（`bg-primary/10` 圆角卡片），更贴近即时通讯体验
- AI 消息移除边框卡片，改为简洁的图标 + 内容布局
- 工具输出移除独立背景和圆形图标，改为紧凑的小图标 + 标签样式，视觉层级更清晰
- 消息线程最大宽度从 `max-w-4xl` 收窄到 `max-w-3xl`，消息间距从 `space-y-3` 增大到 `space-y-6`

#### 过滤空会话
- 会话列表现在自动过滤掉消息数为 0 的空会话
- 加载会话后同步更新项目卡片上的会话计数

### Fixed

#### Markdown 行内代码多余引号
- 修复 `@tailwindcss/typography` 为行内 `code` 标签自动添加反引号伪元素的问题
- 添加 CSS 规则移除 `::before` / `::after` 的 content，行内代码不再显示多余的引号

#### 会话卡片布局
- 会话列表卡片改用 `items-center` 垂直居中对齐，修复按钮和文字未对齐的问题

#### 思考/推理块图标溢出
- 为 Thinking 和 Reasoning 块的 Brain 图标添加 `shrink-0`，防止图标在窄屏下被压缩

---

## [0.7.0] - 2026-02-24

### Added

#### 反向加载消息 — 默认显示最新对话
- 后端 `get_messages` 新增 `from_end` 参数，支持从末尾分页
- 进入会话直接看到最新消息，自动滚到底部
- 向上滚动自动加载更早的消息，加载后保持滚动位置不跳
- 双向浮动按钮：跳转到顶部 / 跳转到底部，根据位置动态显示

#### 亮色 / 暗色主题切换
- 新增 Cerulean Flow 青绿色调主题（参考 E-FlowCode docs 配色）
- 支持三种模式：亮色 / 暗色 / 跟随系统
- 主题偏好持久化到 localStorage，页面加载无闪烁
- Sidebar 底部新增主题切换按钮组

#### 内嵌字体
- 内嵌 Inter（正文）和 JetBrains Mono（代码）woff2 字体
- 完全离线可用，不依赖 CDN

#### UI 样式优化
- 用户消息加 `bg-primary/5` 浅色背景卡片
- AI 消息加细边框卡片样式
- 工具输出左缩进 + 半透明背景，视觉上作为 AI 消息子级
- 用户消息支持 Markdown 渲染（行内代码等不再显示原始反引号）
- Markdown 段落间距优化

---

## [0.6.1] - 2026-02-10

### Fixed

#### Claude 每日 Token 用量图表空白
- **根因**: `stats-cache.json` 中的 `dailyModelTokens` 只有按模型汇总的 token 总量，没有 input/output 拆分。后端构建 `DailyTokenEntry` 时将 `input_tokens` 和 `output_tokens` 硬编码为 0，而前端柱状图仅渲染 input + output 的堆叠柱，导致图表看似空白
- **修复**: 解析 `stats-cache.json` 中的 `modelUsage` 字段获取全局 input/output 比例，按此比例将每日 token 总量分配为 input 和 output；同时修复摘要卡片中"输入 Token"始终显示为 0 的问题

#### Claude 恢复会话路径解析不准确
- **根因**: `resume_session` 仅使用前端传入的 `project_path`，该路径可能来自解码后的目录名而非真实项目路径，导致在终端中无法正确 `cd` 到项目目录
- **修复**: 新增 `file_path` 参数，从会话文件所在目录的 `sessions-index.json` 中读取 `originalPath` 作为优先项目路径；同时在恢复前将孤儿会话写入索引，确保 `claude --resume` 能发现该会话

---

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

[2.2.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v2.2.0
[2.1.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v2.1.0
[1.9.7]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.9.7
[1.9.6]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.9.6
[1.9.4]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.9.4
[1.9.3]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.9.3
[1.9.2]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.9.2
[1.9.1]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.9.1
[1.9.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.9.0
[1.8.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.8.0
[1.7.1]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.7.1
[1.7.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.7.0
[1.6.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.6.0
[1.5.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.5.0
[1.4.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.4.0
[1.3.1]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.3.1
[1.3.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.3.0
[1.1.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.1.0
[1.0.1]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.0.1
[1.0.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v1.0.0
[0.8.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v0.8.0
[0.7.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v0.7.0
[0.6.1]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v0.6.1
[0.6.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v0.6.0
[0.5.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v0.5.0
[0.4.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v0.4.0
[0.3.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v0.3.0
[0.2.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v0.2.0
[0.1.0]: https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v0.1.0
