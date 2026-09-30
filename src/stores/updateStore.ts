import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";
import { api } from "../services/api";

declare const __IS_TAURI__: boolean;

type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing" | "opening" | "error";
type UpdateErrorStage = "check" | "install" | "download-page" | null;

interface UpdateState {
  installType: "installed" | "portable" | null;
  status: UpdateStatus;
  currentVersion: string;
  newVersion: string | null;
  releaseNotes: string | null;
  downloadProgress: number | null;
  dismissed: boolean;
  dialogOpen: boolean;
  errorMessage: string | null;
  errorStage: UpdateErrorStage;
  detectInstallType: () => Promise<void>;
  loadCurrentVersion: () => Promise<void>;
  checkForUpdate: (options?: { silent?: boolean }) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  openDownloadPage: () => Promise<void>;
  openDialog: () => void;
  closeDialog: () => void;
  dismiss: () => void;
}

const DISMISSED_VERSION_KEY = "update_dismissed_version";
// 保留检查返回的资源，确保安装版本与用户看到的详情一致。
let pendingUpdate: Update | null = null;
const isBusy = (status: UpdateStatus) => ["checking", "downloading", "installing", "opening"].includes(status);

export const useUpdateStore = create<UpdateState>((set, get) => ({
  installType: null,
  status: "idle",
  currentVersion: "",
  newVersion: null,
  releaseNotes: null,
  downloadProgress: null,
  dismissed: false,
  dialogOpen: false,
  errorMessage: null,
  errorStage: null,

  detectInstallType: async () => {
    if (!__IS_TAURI__) return;
    try {
      set({ installType: await api.getInstallType() });
    } catch {
      set({ installType: "installed" });
    }
  },

  loadCurrentVersion: async () => {
    if (!__IS_TAURI__) return;
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      set({ currentVersion: await getVersion() });
    } catch {
      // 更新检查成功时还会从 Update 中取得当前版本。
    }
  },

  checkForUpdate: async ({ silent = false } = {}) => {
    if (!__IS_TAURI__) return;
    if (isBusy(get().status)) {
      if (!silent) set({ dialogOpen: true });
      return;
    }
    const previousUpdate = pendingUpdate;
    pendingUpdate = null;
    set({
      status: "checking", errorMessage: null, errorStage: null,
      newVersion: null, releaseNotes: null, dismissed: false,
      downloadProgress: null, dialogOpen: !silent,
    });
    // 资源释放失败不应阻止下一次检查。
    if (previousUpdate) void previousUpdate.close().catch(() => {});
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      if (get().installType === null) await get().detectInstallType();
      const update = await check();
      pendingUpdate = update;
      if (update) {
        let isDismissed = false;
        try {
          isDismissed = localStorage.getItem(DISMISSED_VERSION_KEY) === update.version;
        } catch { /* 存储不可用时仍允许检查和展示更新。 */ }
        set({
          status: "available",
          currentVersion: update.currentVersion,
          newVersion: update.version,
          releaseNotes: update.body ?? null,
          dismissed: isDismissed,
          dialogOpen: get().dialogOpen || (silent && !isDismissed),
        });
      } else {
        set({ status: "up-to-date" });
      }
    } catch (e) {
      console.warn("Update check failed:", e);
      set({ status: "error", errorStage: "check", errorMessage: String(e) });
    }
  },

  downloadAndInstall: async () => {
    const update = pendingUpdate;
    if (!__IS_TAURI__ || !update || get().installType !== "installed" || isBusy(get().status)) return;
    set({ status: "downloading", downloadProgress: null, dialogOpen: true, errorMessage: null, errorStage: null });
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      let totalLength = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            totalLength = event.data.contentLength ?? 0;
            downloaded = 0;
            set({ downloadProgress: totalLength > 0 ? 0 : null });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (totalLength > 0) {
              set({ downloadProgress: Math.min(100, Math.round((downloaded / totalLength) * 100)) });
            }
            break;
          case "Finished":
            set({ status: "installing", downloadProgress: 100 });
            break;
        }
      });
      await relaunch();
    } catch (e) {
      console.error("Update install failed:", e);
      set({ status: "error", errorStage: "install", errorMessage: String(e) });
    }
  },

  openDownloadPage: async () => {
    if (!__IS_TAURI__ || isBusy(get().status)) return;
    const { newVersion } = get();
    set({ status: "opening", errorMessage: null, errorStage: null });
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      const path = newVersion ? `tag/${encodeURIComponent(`v${newVersion}`)}` : "latest";
      await open(`https://github.com/zuoliangyu/AI-Session-Viewer/releases/${path}`);
      set({ status: newVersion ? "available" : "idle", dialogOpen: false });
    } catch (e) {
      set({ status: "error", errorStage: "download-page", errorMessage: String(e), dialogOpen: true });
    }
  },

  openDialog: () => {
    if (__IS_TAURI__) set({ dialogOpen: true });
  },
  closeDialog: () => {
    if (!["downloading", "installing", "opening"].includes(get().status)) set({ dialogOpen: false });
  },
  dismiss: () => {
    if (isBusy(get().status)) return;
    const { newVersion } = get();
    if (newVersion) {
      try { localStorage.setItem(DISMISSED_VERSION_KEY, newVersion); } catch { /* 本次会话仍可忽略。 */ }
    }
    set({ dismissed: true, dialogOpen: false });
  },
}));
