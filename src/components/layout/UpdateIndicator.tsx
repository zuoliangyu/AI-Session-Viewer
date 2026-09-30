import { useTranslation } from "react-i18next";
import { RefreshCw, CheckCircle2 } from "lucide-react";
import { useUpdateStore } from "../../stores/updateStore";

declare const __IS_TAURI__: boolean;

export function UpdateIndicator() {
  const { t } = useTranslation();
  const { status, currentVersion, newVersion, dismissed, checkForUpdate, openDialog } = useUpdateStore();
  if (!__IS_TAURI__) return null;
  const busy = ["checking", "downloading", "installing", "opening"].includes(status);

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">{t("当前版本")}</span>
        <span className="font-mono">{currentVersion ? `v${currentVersion}` : "..."}</span>
      </div>
      {newVersion && (
        <p className="text-muted-foreground">
          {t("新版本可用")} <span className="font-mono text-blue-500">v{newVersion}</span>
          {dismissed && <span className="ml-2 text-xs">{t("已忽略此版本")}</span>}
        </p>
      )}
      <div aria-live="polite" className="text-xs text-muted-foreground">
        {status === "checking" && t("检查更新中...")}
        {status === "downloading" && t("正在下载更新...")}
        {status === "installing" && t("正在安装，即将重启...")}
        {status === "up-to-date" && <span className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-green-500" />{t("已是最新版本")}</span>}
        {status === "error" && <span className="text-destructive">{t("更新操作失败，请查看详情")}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="toolbar-button" disabled={busy} onClick={() => void checkForUpdate()}>
          <RefreshCw className={`h-3.5 w-3.5 ${status === "checking" ? "animate-spin" : ""}`} />
          {t("检查更新")}
        </button>
        {(newVersion || status === "error" || busy) && (
          <button className="toolbar-primary" onClick={openDialog}>{t("查看更新详情")}</button>
        )}
      </div>
    </div>
  );
}
