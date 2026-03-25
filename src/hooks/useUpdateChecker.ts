import { useEffect, useRef } from "react";
import { useUpdateStore } from "../stores/updateStore";

declare const __IS_TAURI__: boolean;

export function useUpdateChecker() {
  const hasChecked = useRef(false);
  const promptedVersion = useRef<string | null>(null);
  const {
    detectInstallType,
    loadCurrentVersion,
    checkForUpdate,
    status,
    newVersion,
    installType,
    currentVersion,
    downloadAndInstall,
    openDownloadPage,
  } = useUpdateStore();

  useEffect(() => {
    if (!__IS_TAURI__) return;
    if (hasChecked.current) return;
    hasChecked.current = true;

    detectInstallType();
    loadCurrentVersion();

    const timer = setTimeout(() => {
      checkForUpdate();
    }, 1500);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!__IS_TAURI__) return;
    if (status !== "available" || !newVersion || installType === null) return;
    if (promptedVersion.current === newVersion) return;
    promptedVersion.current = newVersion;

    let cancelled = false;

    void (async () => {
      try {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        const isPortable = installType === "portable";
        const shouldUpdate = await confirm(
          isPortable
            ? `当前版本 v${currentVersion || "当前"}，检测到新版本 v${newVersion}。是否前往下载页面？`
            : `当前版本 v${currentVersion || "当前"}，检测到新版本 v${newVersion}。是否立即更新并在完成后重启？`,
          {
            title: "发现新版本",
            kind: "info",
            okLabel: isPortable ? "前往下载" : "立即更新",
            cancelLabel: "暂不更新",
          }
        );

        if (!shouldUpdate || cancelled) return;

        if (isPortable) {
          await openDownloadPage();
        } else {
          await downloadAndInstall();
        }
      } catch (error) {
        console.warn("Startup update prompt failed:", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    status,
    newVersion,
    installType,
    currentVersion,
    downloadAndInstall,
    openDownloadPage,
  ]);
}
