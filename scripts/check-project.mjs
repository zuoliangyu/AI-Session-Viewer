const checks = [
  ["节点配置", "./check-node-config.mjs"],
  ["时区格式化", "./check-timezone.mjs"],
  ["聊天与 OMP 契约", "./check-chat-contracts.mjs"],
  ["会话分叉", "./check-session-fork.mjs"],
  ["中英文界面", "./check-i18n.mjs"],
  ["AppImage 打包依赖", "./check-appimage.mjs"],
];

for (const [label, modulePath] of checks) {
  try {
    await import(modulePath);
    console.log("[check-project] PASS: " + label);
  } catch (error) {
    console.error("[check-project] FAIL: " + label);
    console.error(error);
    process.exitCode = 1;
    break;
  }
}
