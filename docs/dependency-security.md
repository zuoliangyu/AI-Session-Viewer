# 依赖安全维护

2026-11-15 完成一次锁文件审计和安全更新。公告库会持续变化，以下结果不替代后续审计。

## 本次更新

- npm：Vite 6.4.6、React Router 7.18.5、PostCSS 8.5.33、lodash 4.18.1，以及相关构建依赖；审计由 17 个受影响包条目降至 0。
- Rust：Tauri 2.12.5、updater 2.14.1、rustls 0.23.46、rustls-webpki 0.103.17、webpki-roots 1.0.12、rusqlite 0.41.1、lru 0.18.5、zip 9.6.0。最低 Rust 版本统一为 1.91。
- YAML：移除停止维护的 `serde_yml` 转接库，直接使用 `noyalib 0.0.60` 的 `compat-serde-yaml` API；保留对技能额外字段的忽略行为。
- 删除未被 workspace 使用的 `src-tauri/Cargo.lock`。依赖解析和审计均以根 `Cargo.lock` 为准。
- `react-syntax-highlighter` 保留 15.x 的渲染接口，通过只针对 `refractor@3.6.0` 的 override 将 Prism 提升到 1.30.0。Typography 的 selector parser 同样限定为安全的 6.x，避免降级插件或升级不兼容接口。上游解除旧版本限制后再移除这两条 override。

## GLib 官方修复回补

Linux GTK3 依赖 GLib 0.18，上游尚未发布包含此修复的兼容版本。直接替换为 GLib 0.20 会破坏 GTK3 依赖关系，因此根 manifest 使用本地 `[patch.crates-io]`。

`vendor/glib-0.18.5/` 保留原发布版本、许可证和内容，只回补 [官方提交 b5a4071](https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34) 的两行改动，修复 [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)。来源、完整摘要和撤销条件见 [vendor/README.md](../vendor/README.md)。

自动审计仍将这个版本送交 OSV 查询。只有完整文件集合、所有文件 SHA256、官方补丁文件及 Cargo patch 配置均校验通过，才将这条特定公告标为 `remediated`。新增、丢失或变更文件都会失败；新 GLib 公告不在此豁免范围内。不得用修改版本号或全局忽略的方式隐藏告警。

## 剩余维护提示

`proc-macro-error 1.0.4` 的 [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) 是停止维护提示，没有独立的已知漏洞。它由 Linux GTK3 的 `glib-macros` / `gtk3-macros` 引入。本次保留该提示，等待兼容上游替换；不另建宏库分支来消除提示。

## 自动审计与更新

```bash
node scripts/audit-dependencies.mjs
node scripts/check-dependency-audit.mjs
node scripts/check-vendored-patches.mjs
```

需要 Node.js 24/npm 和网络，不需要安装项目依赖或 Rust 工具链。第一条命令使用 `npm audit --package-lock-only --ignore-scripts` 和 OSV API，检查锁文件中的 npm 与 Rust 依赖，包含其他平台及可选依赖。后两条是内存/临时文件回归，不访问网络、不编译。

漏洞、未知依赖来源、网络/响应错误、本地补丁校验失败均使审计失败；停止维护提示保持可见。`scripts/security-exceptions.json` 初始为空；确需例外时必须同时写明精确包版本、公告、理由和到期日期，过期及已无必要的例外会使审计失败。

CI 在普通检查、发布前以及每日定时运行依赖审计。Dependabot 每周提出 npm、Cargo、Actions 和 Docker 更新。审查版本兼容性及公告后合并；不要直接运行 `npm audit fix --force`。Actions 固定完整提交 SHA，Docker 基础镜像固定版本和 digest。

## 验证边界

本次完成依赖解析、在线审计、补丁完整性、Node 轻量回归与配置检查；遵守项目约束，未执行 Rust/TypeScript 编译、构建或 Rust 测试。请维护者手动运行 `cargo clippy --workspace -- -D warnings`、`npx tsc --noEmit`，并验证 Linux 桌面、数据库同步、ZIP 导入导出、更新流程与外链打开。系统 WebView/WebKit 和已发布容器镜像的完整漏洞扫描不在锁文件审计范围内。
