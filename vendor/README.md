# GLib 安全补丁

`glib-0.18.5/` 来自 crates.io 的原始 `glib 0.18.5` 发布包，保留上游 MIT 许可证和版本。Tauri 的 Linux GTK3 依赖链仍要求 GLib 0.18，因此根 `Cargo.toml` 使用 `[patch.crates-io]` 指向此副本，没有用不兼容的 GLib 0.20 替换它。

唯一源码改动是回补 [gtk-rs/gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343) 的两行修复：在 `VariantStrIter::impl_get` 中以可变变量和可变引用向 C 函数传递输出指针。修复对应 RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g，上游提交为 `b5a4071e439bef2b5eea76c3aa25e5ae84839e34`。

`glib-0.18.5.patch.json` 记录原始发布包 SHA256、来源提交、官方补丁 SHA256，以及每个文件修改前后的 SHA256。原始补丁在 `patches/`。审计应先校验完整文件集合和摘要，再将这条公告标为已回补；不能按版本号跳过公告，也不能把其他 GLib 公告一并忽略。

当 Tauri 的兼容依赖链包含上游已修复版本时，移除此副本、对应 patch 配置及校验元数据。此副本已完成原始包完整性、两行差异和依赖解析检查。后续经用户授权通过的 Windows workspace Clippy 不包含 Linux GTK3/GLib 编译路径；尚未运行此副本的 Rust 测试。仍应在 Linux 上执行项目编译验证及上游 VariantStrIter 的优化构建测试。
