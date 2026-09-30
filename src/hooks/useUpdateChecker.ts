import { useEffect } from "react";
import { useUpdateStore } from "../stores/updateStore";

declare const __IS_TAURI__: boolean;

export function useUpdateChecker() {
  useEffect(() => {
    if (!__IS_TAURI__) return;
    const { detectInstallType, loadCurrentVersion, checkForUpdate } = useUpdateStore.getState();
    void detectInstallType();
    void loadCurrentVersion();

    // 清理只取消计时器，StrictMode 重新挂载时仍会安排启动检查。
    const timer = setTimeout(() => {
      // 用户已主动检查过时，不再用延迟的自动检查重复打扰。
      if (useUpdateStore.getState().status === "idle") void checkForUpdate({ silent: true });
    }, 1500);
    return () => clearTimeout(timer);
  }, []);
}
