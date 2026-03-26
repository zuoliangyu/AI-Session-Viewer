import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../stores/appStore";

declare const __IS_TAURI__: boolean;

/**
 * In Tauri mode: use Tauri's event system (already handled by existing watcher).
 * In Web mode: connect to WebSocket at /ws for file change notifications.
 *
 * Debounces rapid file changes (e.g. multiple session deletions) to avoid
 * triggering excessive reloads.
 */
export function useFileWatcher() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closingRef = useRef(false);
  const { refreshInBackground } = useAppStore();

  const handleChange = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      refreshInBackground(true);
    }, 1000);
  }, [refreshInBackground]);

  useEffect(() => {
    if (__IS_TAURI__) {
      let unlisten: (() => void) | undefined;
      import("@tauri-apps/api/event").then(({ listen }) => {
        listen<string[]>("fs-change", handleChange).then((fn) => {
          unlisten = fn;
        });
      });
      return () => {
        unlisten?.();
        clearTimeout(debounceRef.current);
      };
    }

    closingRef.current = false;

    // Web mode: connect to WebSocket
    const connect = () => {
      import("../services/webApi")
        .then(async ({ connectFileWatcherWebSocket }) => {
          if (closingRef.current) {
            return;
          }

          const ws = await connectFileWatcherWebSocket();
          if (closingRef.current) {
            ws.close();
            return;
          }
          wsRef.current = ws;

          ws.onmessage = handleChange;

          ws.onclose = () => {
            if (closingRef.current) {
              return;
            }
            reconnectRef.current = setTimeout(connect, 5000);
          };

          ws.onerror = () => {
            ws.close();
          };
        })
        .catch((error: unknown) => {
          if (closingRef.current) {
            return;
          }
          if (error instanceof Error && error.message === "Authentication required") {
            return;
          }
          reconnectRef.current = setTimeout(connect, 5000);
        });
    };

    connect();

    return () => {
      closingRef.current = true;
      clearTimeout(reconnectRef.current);
      clearTimeout(debounceRef.current);
      wsRef.current?.close();
    };
  }, [handleChange]);
}
