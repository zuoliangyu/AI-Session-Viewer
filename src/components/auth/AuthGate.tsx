import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import {
  getApiToken,
  isRemoteNodeActive,
  setApiToken,
} from "../../services/nodeConfig";

declare const __IS_TAURI__: boolean;

/**
 * Global listener for `asv-auth-required` events. Shows a modal that asks
 * the user for the API token, persists it to localStorage, and then closes.
 * Subsequent requests will pick up the new token via `getToken()`.
 *
 * Local Tauri IPC needs no token; remote nodes still use this gate.
 *
 * Concurrent 401s collapse onto a single modal: while it's open, repeat
 * events are ignored. Once dismissed, the next event reopens it.
 */
export function AuthGate() {
  const { t } = useTranslation();
  const usesLocalTauri = __IS_TAURI__ && !isRemoteNodeActive();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (usesLocalTauri) return;

    const handler = () => {
      setOpen((prev) => {
        if (prev) return prev;
        const stored = getApiToken() ?? "";
        setValue(stored);
        return true;
      });
    };

    window.addEventListener("asv-auth-required", handler);
    return () => window.removeEventListener("asv-auth-required", handler);
  }, [usesLocalTauri]);

  useEffect(() => {
    if (open) {
      // Defer focus so the input is mounted.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  if (usesLocalTauri || !open) return null;

  const handleSave = () => {
    setSubmitting(true);
    const trimmed = value.trim();
    setApiToken(trimmed);
    // Wake up any fetch that was waiting on a token via withAuthRetry.
    window.dispatchEvent(new CustomEvent("asv-auth-updated"));
    setSubmitting(false);
    setOpen(false);
  };

  const handleCancel = () => {
    // Tell the retry helper the user gave up so the original 401 surfaces
    // instead of leaving the request hanging forever.
    window.dispatchEvent(new CustomEvent("asv-auth-cancelled"));
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="asv-auth-title"
    >
      <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-lg">
        <h3 id="asv-auth-title" className="text-lg font-semibold mb-2">
          {t("需要 API 访问令牌")}</h3>
        <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
          {t("服务器返回 401。请粘贴部署时配置的访问令牌（启动 session-web 时设置的")}<code className="mx-1 rounded bg-muted px-1 py-0.5">--token</code>
          {t("或")}<code className="mx-1 rounded bg-muted px-1 py-0.5">ASV_TOKEN</code>{t("）。 令牌会保存在浏览器的 localStorage 中。")}</p>
        <input
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("访问令牌")}
          className="w-full bg-background border border-border rounded px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted"
            onClick={handleCancel}
            disabled={submitting}
          >
            {t("取消")}</button>
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90"
            onClick={handleSave}
            disabled={submitting}
          >
            {t("保存")}</button>
        </div>
      </div>
    </div>
  );
}
