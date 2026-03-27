import { useEffect, useRef } from "react";

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

export function useReplyNotification(messageKey: string | null, title: string, body: string) {
  const initializedRef = useRef(false);
  const lastKeyRef = useRef<string | null>(null);
  const originalTitleRef = useRef<string>("");

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
    const handleVisibility = () => {
      if (!document.hidden) resetTitle();
    };

    window.addEventListener("focus", resetTitle);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", resetTitle);
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

    if (!pageInactive()) return;

    document.title = `有新回复 · ${originalTitleRef.current}`;

    void ensurePermission().then((permission) => {
      if (permission !== "granted") return;
      const notification = new Notification(title, {
        body,
        tag: "asv-reply",
        renotify: true,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    });
  }, [messageKey, title, body]);
}
