import { useEffect, useRef } from "react";
import { useChatStore } from "../stores/chatStore";
import { subscribeToChatWebSocketMessages } from "../services/webApi";
import { isActualChatError } from "../components/chat/chatError";

declare const __IS_TAURI__: boolean;

let webChatSubscriptionInitialized = false;

function handleWebChatMessage(rawMessage: string): void {
  const { addStreamLine, setStreaming, setError } = useChatStore.getState();

  try {
    const data = JSON.parse(rawMessage);
    const type = typeof data?.type === "string" ? data.type : "";
    const payload =
      typeof data?.data === "string"
        ? data.data
        : typeof data?.payload === "string"
          ? data.payload
          : "";

    if (type === "output" || type === "chunk") {
      if (payload) {
        addStreamLine(payload);
      }
    } else if (type === "error" || type === "auth_required") {
      if (type === "auth_required") {
        setStreaming(false);
        window.dispatchEvent(new CustomEvent("asv-auth-required"));
      }
      if (payload && isActualChatError(payload)) {
        setError(payload);
      }
    } else if (type === "complete" || type === "done") {
      setStreaming(false);
    }
  } catch {
    // non-JSON message, ignore
  }
}

function ensureWebChatSubscription(): void {
  if (__IS_TAURI__ || webChatSubscriptionInitialized) {
    return;
  }

  subscribeToChatWebSocketMessages(handleWebChatMessage);
  webChatSubscriptionInitialized = true;
}

ensureWebChatSubscription();

/**
 * Hook to listen for chat stream events.
 * In Tauri mode: listens to Tauri events.
 * In Web mode: listens to WebSocket messages.
 */
export function useChatStream(sessionIdOverride?: string | null) {
  const sessionId = useChatStore((state) => state.sessionId);
  const targetSessionId = sessionIdOverride ?? sessionId;
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (__IS_TAURI__) {
      const addStreamLine = useChatStore.getState().addStreamLine;
      const setStreaming = useChatStore.getState().setStreaming;
      const setError = useChatStore.getState().setError;
      if (!targetSessionId) return;

      // Tauri event listeners
      let cancelled = false;

      const setupListeners = async () => {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return; // async 完成后检查是否已 cleanup

        const unlistenOutput = await listen<string>(
          `chat-output:${targetSessionId}`,
          (event) => {
            if (!cancelled) {
              addStreamLine(event.payload);
            }
          }
        );
        if (cancelled) {
          unlistenOutput();
          return;
        }

        const unlistenError = await listen<string>(
          `chat-error:${targetSessionId}`,
          (event) => {
            if (!cancelled) {
              // stderr from CLI — only show actual errors, not progress/info lines
              const line = event.payload;
              if (line && isActualChatError(line)) {
                setError(line);
              }
            }
          }
        );
        if (cancelled) {
          unlistenOutput();
          unlistenError();
          return;
        }

        const unlistenComplete = await listen<string>(
          `chat-complete:${targetSessionId}`,
          () => {
            if (!cancelled) {
              setStreaming(false);
            }
          }
        );
        if (cancelled) {
          unlistenOutput();
          unlistenError();
          unlistenComplete();
          return;
        }

        cleanupRef.current = () => {
          unlistenOutput();
          unlistenError();
          unlistenComplete();
        };
      };

      setupListeners();

      return () => {
        cancelled = true;
        if (cleanupRef.current) {
          cleanupRef.current();
          cleanupRef.current = null;
        }
      };
    } else {
      ensureWebChatSubscription();
      return;
    }
  }, [targetSessionId]);
}
