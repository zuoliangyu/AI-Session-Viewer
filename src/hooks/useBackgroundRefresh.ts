import { useEffect } from "react";
import { useAppStore } from "../stores/appStore";

declare const __IS_TAURI__: boolean;

const INITIAL_REFRESH_DELAY_MS = 2000;
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function useBackgroundRefresh() {
  const { source, selectedProject, refreshInBackground } = useAppStore();

  useEffect(() => {
    if (!__IS_TAURI__) return;

    const initialTimer = setTimeout(() => {
      refreshInBackground(true);
    }, INITIAL_REFRESH_DELAY_MS);

    const interval = setInterval(() => {
      refreshInBackground(true);
    }, REFRESH_INTERVAL_MS);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [source, selectedProject, refreshInBackground]);
}
