import { useEffect, useRef, useState } from "react";

declare const __IS_TAURI__: boolean;

/**
 * Global listener for `asv-auth-required` events. Shows a modal that asks
 * the user for the API token, persists it to localStorage, and then closes.
 * Subsequent requests will pick up the new token via `getToken()`.
 *
 * In Tauri there is no token / no auth, so this component is a no-op.
 *
 * Concurrent 401s collapse onto a single modal: while it's open, repeat
 * events are ignored. Once dismissed, the next event reopens it.
 */
export function AuthGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (__IS_TAURI__) return;

    const handler = () => {
      setOpen((prev) => {
        if (prev) return prev;
        const stored = localStorage.getItem("asv_token") ?? "";
        setValue(stored);
        return true;
      });
    };

    window.addEventListener("asv-auth-required", handler);
    return () => window.removeEventListener("asv-auth-required", handler);
  }, []);

  useEffect(() => {
    if (open) {
      // Defer focus so the input is mounted.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  if (__IS_TAURI__ || !open) return null;

  const handleSave = () => {
    setSubmitting(true);
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem("asv_token", trimmed);
    } else {
      localStorage.removeItem("asv_token");
    }
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
          需要 API 访问令牌
        </h3>
        <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
          服务器返回 401。请粘贴部署时配置的访问令牌（启动 session-web 时设置的
          <code className="mx-1 rounded bg-muted px-1 py-0.5">--token</code>
          或
          <code className="mx-1 rounded bg-muted px-1 py-0.5">ASV_TOKEN</code>）。
          令牌会保存在浏览器的 localStorage 中。
        </p>
        <input
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="访问令牌"
          className="w-full bg-background border border-border rounded px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted"
            onClick={handleCancel}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90"
            onClick={handleSave}
            disabled={submitting}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
