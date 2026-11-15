# 脚本说明

根目录提供两个统一入口：

- Windows：`.\menu.ps1`
- Linux/macOS：`./menu.sh`

两个菜单的动作保持一致：

| 动作 | PowerShell | Bash |
|---|---|---|
| 桌面开发 | `scripts/dev.ps1` | `scripts/dev.sh` |
| 桌面开发（性能诊断） | `scripts/dev.ps1 -PerfDiagnostics` | `scripts/dev.sh --perf` |
| Web 开发 | `scripts/dev-web.ps1` | `scripts/dev-web.sh` |
| 本地桌面构建 | `scripts/build.ps1` | `scripts/build.sh` |
| Web 构建 | `scripts/build-web.ps1` | `scripts/build-web.sh` |
| Linux 静态构建 | `scripts/build-linux.ps1` | `scripts/build-linux.sh` |
| Rocky 部署 | `scripts/deploy-rocky.ps1` | `scripts/deploy-rocky.sh` |
| 清理 | `scripts/clean.ps1` | `scripts/clean.sh` |
| 性能日志分析 | `scripts/analyze-perf-log.ps1` | `scripts/analyze-perf-log.sh` |
| 轻量检查 | `scripts/check.ps1` | `scripts/check.sh` |

## 关键行为

- 普通开发默认不记录性能日志，必须显式选择性能诊断模式。
- 本地桌面构建临时设置 `createUpdaterArtifacts=false`，不需要发布签名私钥。
- 正式发布继续使用 `tauri.conf.json` 和 GitHub Actions Secrets 生成 updater 签名。
- 所有脚本都会先定位仓库根目录，因此可以从任意当前目录调用。
- 图标生成通过当前 Node.js 直接启动项目安装的 Tauri CLI，不经 `npx.cmd`，兼容 Windows 及含空格的仓库路径。
- 轻量检查会验证节点 URL、时区格式化，以及聊天/OMP 的提示词、CLI 检测、profile/XDG 路径和环境继承契约；还会检查四来源 Fork 的桌面/Web 调用流程与终端失败后保留新会话的行为。它不替代 Rust/TypeScript 编译检查。
- 可单独运行 `node scripts/check-session-fork.mjs` 检查分叉调用流程。会话文件的 Rust 回归用例位于 `crates/session-core/src/fork/tests.rs`，覆盖工具轮次、OMP 祖先链与附件、Grok 原始历史、分叉失败清理、分页定位及 Codex 回退；这些用例需要人工运行 `cargo test -p session-core fork::tests`。
- `node scripts/check-i18n.mjs` 检查中英文词典、占位符、默认中文、语言持久化与相对时间，并用解析器检查前端源码的语法及漏抽取的中文文案；不执行类型检查或构建。维护规则见 [src/i18n/README.md](../src/i18n/README.md)。
- `node scripts/check-updates.mjs`（Node.js 24+）用模拟桌面 API 运行真实更新状态逻辑，检查自动/手动详情展示、忽略版本、下载进度、失败重试和便携版跳转；不访问网络、不安装更新、不编译。该专项检查单独运行，不改变通用轻量检查的 Node.js 版本要求。
- `node scripts/check-appimage.mjs` 检查 Tauri CLI 的版本锁定，避免重新引入绝对 `.DirIcon` 符号链接的上游缺陷；两项检查均已纳入 `npm run check:scripts`。

以下 9 项定向回归可用 `npm run check:regressions` 一次运行（Node.js 24+），CI 使用独立任务运行并纳入发布门禁。每项在独立进程中执行，避免模拟环境互相影响；`npm run check:scripts` 仍兼容 Node.js 22。此入口不执行构建或类型检查。

会话链接安全回归：`node scripts/check-markdown-links.mjs`（Node.js 24+）。验证危险协议、相对路径、凭据与控制字符过滤、锚点保留和系统浏览器调用；不实际打开链接、不编译。

同步预览的定向回归：`node scripts/check-sync-preview.mjs`（Node.js 24+）。使用真实预览守卫和内存请求，检查乱序响应、节点切换、重复提交与卸载失效；不访问节点、不写配置、不编译。

标签加载的定向回归：`node scripts/check-cross-project-tags.mjs`（Node.js 24+）。使用真实 store 和内存 API，检查空结果缓存、请求合并、显式重试与跨来源旧响应隔离；不编译。

提问树深度的定向回归：`node scripts/check-question-depths.mjs`（Node.js 24+）。覆盖乱序分支、缺失父节点、循环数据及 5 万节点长链，检查父节点读取次数为线性增长；不编译。

异步请求隔离的定向回归：`node scripts/check-request-isolation.mjs`（Node.js 24+）。运行真实 store，覆盖搜索乱序、分页与跳转冲突、旧错误/清理回调、会话往返及加载全部取消；不编译。

账单分页的定向回归：`node scripts/check-request-log-pagination.mjs`（Node.js 24+）。运行真实 store 与 1203 条内存记录，覆盖后续页访问、失败重试、筛选重置、乱序响应、来源与时区切换；不编译。

聊天生命周期的定向回归：`node scripts/check-chat-lifecycle.mjs`（Node.js 24+）。用内存 WebSocket 和真实状态逻辑检查双流断线、启动期取消、旧连接及旧启动响应隔离；不连接服务器、不启动 CLI、不编译。

消息定位的定向回归：`node scripts/check-message-navigation.mjs`（Node.js 24+）。使用真实 store 和一万条逻辑消息，覆盖旧链接、任意角色定位、窗口加载、取消/来源切换、失败重试及桌面/Web 参数编码；不编译。四数据源索引与完整解析的一致性另有 Rust 用例，需手动编译运行。

聊天页面的定向回归：`node scripts/check-chat-page-lifecycle.mjs`（Node.js 24+）。验证失败/取消保留、成功回复移交历史、离页取消、延时续聊撤销及旧轮次事件隔离；不启动 CLI、不编译。

## AppImage 产物验证

Tauri CLI 2.11.4 包含 [#15596](https://github.com/tauri-apps/tauri/pull/15596)，修复 `.DirIcon` 和根目录 `.desktop` 指向构建机器绝对路径的问题。`package.json` 与 `package-lock.json` 锁定该版本；升级时应保留此修复。

轻量检查只能验证依赖版本，不能证明实际 Linux 产物有效。由维护者在 Linux 构建后，在新的临时目录手动解包检查：

```bash
workdir=$(mktemp -d)
cd "$workdir"
/absolute/path/to/AI.Session.Viewer_VERSION_amd64.AppImage --appimage-extract
test -f squashfs-root/.DirIcon
icon_target=$(readlink squashfs-root/.DirIcon)
case "$icon_target" in /*) echo 'ERROR: absolute .DirIcon link'; exit 1 ;; esac
file -L squashfs-root/.DirIcon
find squashfs-root -maxdepth 1 -name '*.desktop' -exec test -f '{}' \;
```

`.DirIcon` 应解析到包内有效图片；根目录 `.desktop` 也应解析到包内文件。另需在中文/英文界面下手动启动 AppImage，检查导航与设置，并让 AppImage 目录重新测试新版本。当前默认中文是产品选择，未承诺满足目录的英文默认语言政策。

## 常用参数

```bash
# Web 服务参数会传给 session-web
./scripts/dev-web.sh --port 8080

# Rocky 部署，也可使用 ASV_DEPLOY_HOST / USER / PATH / FILE
./scripts/deploy-rocky.sh --host 192.168.124.133 --user root

# 清理依赖或显示释放空间
./scripts/clean.sh --deps --stats
./scripts/clean.sh --all --stats

# 指定性能日志和阈值
./scripts/analyze-perf-log.sh --path target/perf/dev-example.log --ipc-threshold-ms 5000
```
