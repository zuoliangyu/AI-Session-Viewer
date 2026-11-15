import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Each regression installs its own in-memory API / browser mocks. Isolate
// processes so module hooks and globals cannot change another check's result.
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("check:regressions requires Node.js 24 or newer; check:scripts still supports Node.js 22.");
  process.exit(1);
}

const checks = [
  "check-sync-preview.mjs",
  "check-cross-project-tags.mjs",
  "check-question-depths.mjs",
  "check-request-isolation.mjs",
  "check-request-log-pagination.mjs",
  "check-chat-lifecycle.mjs",
  "check-message-navigation.mjs",
  "check-markdown-links.mjs",
  "check-chat-page-lifecycle.mjs",
];

const cwd = fileURLToPath(new URL("../", import.meta.url));
for (const check of checks) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(check, import.meta.url))], {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    console.error(`[check-regressions] FAIL: ${check}`, result.error?.message ?? result.signal ?? result.status);
    process.exit(result.status || 1);
  }
  console.log(`[check-regressions] PASS: ${check}`);
}
