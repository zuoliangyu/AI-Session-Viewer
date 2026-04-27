import { useCallback, useEffect, useRef, useState } from "react";

function pageInactive() {
  if (typeof document === "undefined") return false;
  return document.hidden || !document.hasFocus();
}

function canNotify() {
  return typeof window !== "undefined" && "Notification" in window;
}

async function ensurePermission() {
  if (!canNotify()) return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
}

export interface ReplyNotificationState {
  /** Replies that arrived while the page was hidden / unfocused. Cleared on
   *  user-initiated focus *and* on `clear()`. The page can render a toast
   *  whenever this is > 0. */
  unreadCount: number;
  /** Drops the toast back to zero — call from "查看 / 关闭" toast actions. */
  clear: () => void;
}

export function useReplyNotification(
  messageKey: string | null,
  title: string,
  body: string
): ReplyNotificationState {
  const initializedRef = useRef(false);
  const lastKeyRef = useRef<string | null>(null);
  const originalTitleRef = useRef<string>("");
  const [unreadCount, setUnreadCount] = useState(0);
  // Track the most recent unread snapshot in a ref so the visibility handler
  // can decide whether to keep the title prefix or restore it.
  const unreadCountRef = useRef(0);
  unreadCountRef.current = unreadCount;

  const clear = useCallback(() => {
    setUnreadCount(0);
    if (typeof document !== "undefined" && originalTitleRef.current) {
      document.title = originalTitleRef.current;
    }
  }, []);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    if (!originalTitleRef.current) {
      originalTitleRef.current = document.title;
    }

    const resetTitle = () => {
      document.title = originalTitleRef.current;
    };
    // Page returning to focus is the natural "ack" point: drop the title
    // prefix immediately so the tab looks normal again. We *keep* the
    // unread count populated for one more render so MessagesPage can
    // surface the in-app toast — the toast's actions or auto-dismiss
    // will call clear() to zero it.
    const handleFocus = () => {
      resetTitle();
    };
    const handleVisibility = () => {
      if (!document.hidden) resetTitle();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
      resetTitle();
    };
  }, []);

  useEffect(() => {
    if (!messageKey || typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    if (!originalTitleRef.current) {
      originalTitleRef.current = document.title;
    }

    if (!initializedRef.current) {
      initializedRef.current = true;
      lastKeyRef.current = messageKey;
      return;
    }

    if (lastKeyRef.current === messageKey) {
      return;
    }
    lastKeyRef.current = messageKey;

    // While the user is actively looking at the page, in-flow auto-scroll +
    // the streaming indicator already communicate the new reply — no need
    // for a banner. Only accumulate when they're elsewhere.
    if (!pageInactive()) return;

    setUnreadCount((prev) => prev + 1);

    document.title = `有新回复 · ${originalTitleRef.current}`;

    void ensurePermission().then((permission) => {
      if (permission !== "granted") return;
      const notification = new Notification(title, {
        body,
        tag: "asv-reply",
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    });
  }, [messageKey, title, body]);

  return { unreadCount, clear };
}
