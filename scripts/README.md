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
- 轻量检查会验证节点 URL、时区格式化，以及聊天/OMP 的提示词、CLI 检测、profile/XDG 路径和环境继承契约；还会检查四来源 Fork 的桌面/Web 调用流程与终端失败后保留新会话的行为。它不替代 Rust/TypeScript 编译检查。
- 可单独运行 `node scripts/check-session-fork.mjs` 检查分叉调用流程。会话文件的 Rust 回归用例位于 `crates/session-core/src/fork/tests.rs`，覆盖工具轮次、OMP 祖先链与附件、Grok 原始历史、分叉失败清理、分页定位及 Codex 回退；这些用例需要人工运行 `cargo test -p session-core fork::tests`。
- `node scripts/check-i18n.mjs` 检查中英文词典、占位符、默认中文、语言持久化与相对时间，并用解析器检查前端源码的语法及漏抽取的中文文案；不执行类型检查或构建。维护规则见 [src/i18n/README.md](../src/i18n/README.md)。
- `node scripts/check-appimage.mjs` 检查 Tauri CLI 的版本锁定，避免重新引入绝对 `.DirIcon` 符号链接的上游缺陷；两项检查均已纳入 `npm run check:scripts`。

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
