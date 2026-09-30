import { t } from "../../i18n/index.js";
import type { ReactNode } from "react";
import { AlertCircle, Inbox, Loader2, RotateCcw } from "lucide-react";

/** Shared, centred feedback states so pages don't each hand-roll a spinner,
 *  a bare muted line, or silently render nothing on failure. */

export function LoadingState({ label, className = "" }: { label?: string; className?: string }) {
  return (
    <div role="status" className={`flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground ${className}`}>
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{label ?? t("加载中...")}</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 py-12 text-center ${className}`}>
      <div className="text-muted-foreground/60">{icon ?? <Inbox className="h-8 w-8" />}</div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  onRetry,
  className = "",
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={`mx-auto flex max-w-lg flex-col items-center gap-2 py-12 text-center ${className}`}>
      <AlertCircle className="h-8 w-8 text-destructive" />
      <p className="text-sm font-medium text-foreground">{title ?? t("加载失败")}</p>
      <p className="break-all text-xs text-muted-foreground">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="toolbar-button mt-1">
          <RotateCcw className="h-3.5 w-3.5" />
          {t("重试")}
        </button>
      )}
    </div>
  );
}
