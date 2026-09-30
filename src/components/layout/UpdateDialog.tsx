import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDownToLine, CheckCircle2, ExternalLink, RefreshCw, X } from "lucide-react";
import { useUpdateStore } from "../../stores/updateStore";

declare const __IS_TAURI__: boolean;

export function UpdateDialog() {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [linkError, setLinkError] = useState(false);
  const {
    status, installType, currentVersion, newVersion, releaseNotes, downloadProgress,
    dialogOpen, errorMessage, errorStage, checkForUpdate, downloadAndInstall,
    openDownloadPage, closeDialog, dismiss,
  } = useUpdateStore();
  const working = ["downloading", "installing", "opening"].includes(status);
  const busy = working || status === "checking";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !dialogOpen) return;
    setLinkError(false);
    // 原生模态层负责焦点约束、背景隔离和关闭后恢复焦点，也能覆盖设置弹窗。
    dialog.showModal();
    return () => dialog.close();
  }, [dialogOpen]);

  if (!__IS_TAURI__) return null;

  const title = status === "checking" ? t("检查更新中...")
    : status === "downloading" ? t("正在下载更新...")
    : status === "installing" ? t("正在安装，即将重启...")
    : status === "opening" ? t("正在打开下载页面...")
    : status === "up-to-date" ? t("已是最新版本")
    : status === "error" ? (errorStage === "check" ? t("更新检查失败")
      : errorStage === "install" ? t("更新安装失败") : t("无法打开下载页面"))
    : newVersion ? t("发现新版本") : t("检查更新");

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby="update-dialog-title"
      className="m-auto w-[min(36rem,calc(100vw-2rem))] max-w-none max-h-[calc(100dvh-2rem)] rounded-xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/50"
      onCancel={(event) => { event.preventDefault(); closeDialog(); }}
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border p-5">
          <h2 id="update-dialog-title" className="flex items-center gap-2 text-base font-semibold" aria-live="polite">
            {busy ? <RefreshCw className="h-5 w-5 shrink-0 animate-spin text-info" />
              : <CheckCircle2 className={`h-5 w-5 shrink-0 ${status === "error" ? "text-destructive" : "text-success"}`} />}
            {title}
          </h2>
          <button className="rounded p-1 text-muted-foreground hover:bg-accent/50 disabled:opacity-40" disabled={working} onClick={closeDialog} aria-label={t("关闭更新详情")}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("当前版本")}</dt>
              <dd className="break-all font-mono">{currentVersion ? `v${currentVersion}` : "..."}</dd>
            </div>
            {newVersion && <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("最新版本")}</dt>
              <dd className="break-all font-mono font-medium text-info">v{newVersion}</dd>
            </div>}
          </dl>

          {newVersion && <section aria-labelledby="update-notes-title">
            <h3 id="update-notes-title" className="mb-2 text-sm font-medium">{t("更新内容")}</h3>
            <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
              {releaseNotes?.trim() ? (
                <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-headings:my-3 prose-headings:text-sm prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 prose-pre:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noreferrer" onClick={(event) => {
                        event.preventDefault();
                        if (!href || !/^https?:\/\//i.test(href)) return;
                        void import("@tauri-apps/plugin-shell").then(({ open }) => open(href)).catch(() => setLinkError(true));
                      }}>{children}</a>
                    ),
                  }}>{releaseNotes}</ReactMarkdown>
                </div>
              ) : <p>{t("此版本未提供更新说明")}</p>}
            </div>
            {linkError && <p role="alert" className="mt-2 text-xs text-destructive">{t("无法打开链接，请稍后重试")}</p>}
          </section>}

          {status === "error" && <div role="alert" className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">{title}</p>
            {errorMessage && <p className="whitespace-pre-wrap break-all text-xs text-muted-foreground">{errorMessage}</p>}
          </div>}
        </div>

        {(status === "downloading" || status === "installing") && <div className="shrink-0 space-y-2 border-t border-border px-5 py-3" aria-live="polite">
          <div role="progressbar" aria-label={t("正在下载更新...")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloadProgress ?? undefined} className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full bg-blue-500 transition-all ${downloadProgress === null ? "w-full animate-pulse" : ""}`} style={downloadProgress === null ? undefined : { width: `${downloadProgress}%` }} />
          </div>
          <p className="text-right text-xs text-muted-foreground">{status === "installing" ? t("正在安装，即将重启...") : downloadProgress === null ? t("正在下载更新...") : `${downloadProgress}%`}</p>
        </div>}

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border p-4">
          {newVersion && <button className="mr-auto text-xs text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={busy} onClick={dismiss}>{t("忽略此版本")}</button>}
          <button className="toolbar-button" disabled={working} onClick={closeDialog}>{newVersion ? t("稍后更新") : t("关闭")}</button>
          {newVersion ? (
            <button className="toolbar-primary" disabled={busy || installType === null} onClick={() => void (installType === "portable" ? openDownloadPage() : downloadAndInstall())}>
              {installType === "portable" ? <ExternalLink className="h-4 w-4" /> : <ArrowDownToLine className="h-4 w-4" />}
              {status === "error" ? t("重试") : installType === "portable" ? t("前往下载") : t("更新并重启")}
            </button>
          ) : (status === "error" || status === "idle") && <button className="toolbar-primary" onClick={() => void checkForUpdate()}>{status === "error" ? t("重试") : t("检查更新")}</button>}
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
