import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Node 24 原生擦除 TypeScript 类型，运行真实 store；只替换桌面 API，无需构建。
const storage = new Map();
const mock = {
  installType: "installed", result: null, checkCalls: 0, installCalls: 0,
  relaunchCalls: 0, opened: [], checkError: null, openError: null,
};
globalThis.__IS_TAURI__ = true;
globalThis.__updateTest = mock;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
} });

const modules = {
  "../services/api": "export const api = { getInstallType: async () => globalThis.__updateTest.installType };",
  "@tauri-apps/api/app": "export const getVersion = async () => '1.0.0';",
  "@tauri-apps/plugin-updater": `export async function check() {
    const mock = globalThis.__updateTest;
    mock.checkCalls++;
    if (mock.checkError) throw mock.checkError;
    return await mock.result;
  }`,
  "@tauri-apps/plugin-process": "export async function relaunch() { globalThis.__updateTest.relaunchCalls++; }",
  "@tauri-apps/plugin-shell": `export async function open(url) {
    const mock = globalThis.__updateTest;
    if (mock.openError) throw mock.openError;
    mock.opened.push(url);
  }`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(modules, specifier)) return { url: "asv-update-test:" + specifier, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("asv-update-test:")) return { format: "module", source: modules[url.slice("asv-update-test:".length)], shortCircuit: true };
    return nextLoad(url, context);
  },
});

try {
  const { useUpdateStore } = await import("../src/stores/updateStore.ts");
  const state = () => useUpdateStore.getState();
  const update = (version = "2.0.0", body = "## Changes\n- Fixes") => ({
    version, body, currentVersion: "1.0.0", closed: false,
    async close() { this.closed = true; },
    async downloadAndInstall(callback) {
      mock.installCalls++;
      callback({ event: "Started", data: { contentLength: 200 } });
      callback({ event: "Progress", data: { chunkLength: 50 } });
      assert.equal(state().downloadProgress, 25, "Progress uses total size from Started");
      state().closeDialog();
      assert.equal(state().dialogOpen, true, "Downloading cannot dismiss the dialog");
      const checkCalls = mock.checkCalls;
      await state().checkForUpdate();
      await state().downloadAndInstall();
      assert.equal(mock.checkCalls, checkCalls, "No check or duplicate installation during download");
      assert.equal(mock.installCalls, 1);
      callback({ event: "Progress", data: { chunkLength: 500 } });
      assert.equal(state().downloadProgress, 100, "Progress never exceeds 100%");
      callback({ event: "Finished" });
      assert.equal(state().status, "installing");
    },
  });

  // 自动发现新版直接打开完整详情；稍后更新不持久化忽略。
  mock.result = update();
  await state().checkForUpdate({ silent: true });
  assert.equal(state().dialogOpen, true);
  assert.equal(state().currentVersion, "1.0.0");
  assert.equal(state().releaseNotes, mock.result.body);
  state().closeDialog();
  assert.equal(storage.size, 0);
  state().openDialog();
  assert.equal(state().dialogOpen, true);

  // 忽略只影响自动检查；手动检查同一版本仍能打开详情。
  state().dismiss();
  assert.equal(storage.get("update_dismissed_version"), "2.0.0");
  const firstUpdate = mock.result;
  mock.result = update();
  await state().checkForUpdate({ silent: true });
  assert.equal(firstUpdate.closed, true, "Superseded updater resources are released");
  assert.equal(state().dialogOpen, false);
  await state().checkForUpdate();
  assert.equal(state().dialogOpen, true);
  assert.equal(state().dismissed, true);
  state().closeDialog();
  mock.result = update("2.1.0", undefined);
  mock.result.body = undefined;
  await state().checkForUpdate({ silent: true });
  assert.equal(state().dialogOpen, true, "Ignoring an older version cannot hide a newer version");
  assert.equal(state().releaseNotes, null);

  // 无更新时清掉旧说明；手动检查显示明确结果。
  mock.result = null;
  await state().checkForUpdate();
  assert.equal(state().status, "up-to-date");
  assert.equal(state().newVersion, null);
  assert.equal(state().releaseNotes, null);
  assert.equal(state().dialogOpen, true);
  state().closeDialog();
  await state().checkForUpdate({ silent: true });
  assert.equal(state().dialogOpen, false, "An automatic check without updates stays silent");

  // 并发检查复用当前请求；中途手动检查可展示被忽略的更新。
  state().closeDialog();
  let resolveCheck;
  mock.result = new Promise((resolve) => { resolveCheck = resolve; });
  const callsBefore = mock.checkCalls;
  const checking = state().checkForUpdate({ silent: true });
  await state().checkForUpdate();
  resolveCheck(update());
  await checking;
  assert.equal(mock.checkCalls, callsBefore + 1);
  assert.equal(state().dialogOpen, true);

  // 真正安装使用用户确认的 Update，不再次检查或切换版本。
  const checksBeforeInstall = mock.checkCalls;
  mock.result = update("3.0.0");
  await state().downloadAndInstall();
  assert.equal(mock.checkCalls, checksBeforeInstall);
  assert.equal(state().newVersion, "2.0.0");
  assert.equal(mock.relaunchCalls, 1);
  useUpdateStore.setState({ status: "available" }); // 模拟重启后的下一次测试场景。

  // 下载失败仍保留说明，并能重试；未知长度不伪装百分比。
  const retryUpdate = update("2.2.0");
  retryUpdate.downloadAndInstall = async (callback) => {
    callback({ event: "Started", data: {} });
    callback({ event: "Progress", data: { chunkLength: 10 } });
    assert.equal(state().downloadProgress, null);
    throw new Error("download failed (expected)");
  };
  mock.result = retryUpdate;
  await state().checkForUpdate();
  await state().downloadAndInstall();
  assert.equal(state().errorStage, "install");
  assert.equal(state().dialogOpen, true);
  assert.equal(state().releaseNotes, retryUpdate.body);
  retryUpdate.downloadAndInstall = async () => {};
  await state().downloadAndInstall();
  assert.equal(mock.relaunchCalls, 2);
  useUpdateStore.setState({ status: "available" });

  // 便携版只打开目标版本页面，失败时保留详情供重试。
  mock.installType = "portable";
  await state().detectInstallType();
  mock.result = update("2.3.0");
  await state().checkForUpdate();
  const installCalls = mock.installCalls;
  await state().downloadAndInstall();
  assert.equal(mock.installCalls, installCalls);
  mock.openError = new Error("browser unavailable");
  await state().openDownloadPage();
  assert.equal(state().errorStage, "download-page");
  assert.equal(state().dialogOpen, true);
  mock.openError = null;
  await state().openDownloadPage();
  assert.equal(mock.opened.at(-1), "https://github.com/zuoliangyu/AI-Session-Viewer/releases/tag/v2.3.0");
  assert.equal(state().dialogOpen, false);

  // 启动检查失败保持安静，手动失败明确展示，Web 模式不调用桌面 API。
  mock.checkError = new Error("network unavailable (expected)");
  await state().checkForUpdate({ silent: true });
  assert.equal(state().dialogOpen, false);
  await state().checkForUpdate();
  assert.equal(state().dialogOpen, true);
  assert.equal(state().errorStage, "check");
  mock.checkError = null;
  mock.result = update("2.4.0");
  await state().checkForUpdate();
  assert.equal(state().status, "available");
  assert.equal(state().errorMessage, null);
  assert.equal(state().dialogOpen, true);
  state().closeDialog();
  globalThis.__IS_TAURI__ = false;
  const desktopCalls = mock.checkCalls;
  await state().checkForUpdate();
  state().openDialog();
  assert.equal(mock.checkCalls, desktopCalls);
  assert.equal(state().dialogOpen, false);
  console.log("[check-updates] PASS: update details, dismissal, manual/automatic checks, installation, portable mode and failures");
} finally {
  hooks.deregister();
  delete globalThis.__updateTest;
  delete globalThis.__IS_TAURI__;
  delete globalThis.localStorage;
}
