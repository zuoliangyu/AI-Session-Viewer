import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw } from "lucide-react";
import { api } from "../../services/api";
import { useAppStore } from "../../stores/appStore";
import type { PricingStatus } from "../../types";
import { formatDateTime } from "../../utils/dateTime";

const LITELLM_URL = "https://github.com/BerriAI/litellm";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Model price source: built-in snapshot, or opt-in daily online update. */
export function PricingSettingsTab({ onOpenLink }: { onOpenLink: (url: string) => void }) {
  const { t } = useTranslation();
  const timeZone = useAppStore((state) => state.timeZone);
  const [status, setStatus] = useState<PricingStatus | null>(null);
  const [busy, setBusy] = useState<"toggle" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshed, setRefreshed] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.getPricingStatus());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // The background download runs on the backend; poll while it is busy.
  useEffect(() => {
    if (!status?.refreshing) return;
    const timer = window.setInterval(() => void loadStatus(), 2000);
    return () => window.clearInterval(timer);
  }, [status?.refreshing, loadStatus]);

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    setRefreshed(false);
    try {
      setStatus(await api.refreshPricing());
      setRefreshed(true);
    } catch (e) {
      setError(errorText(e));
      await loadStatus();
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (enabled: boolean) => {
    setBusy("toggle");
    setError(null);
    setRefreshed(false);
    try {
      const next = await api.setPricingAutoUpdate(enabled);
      setStatus(next);
      setBusy(null);
      if (enabled) await refresh();
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  const time = (value: string | null) => (value ? formatDateTime(value, timeZone, "minute") : t("未知"));
  const refreshing = busy === "refresh" || Boolean(status?.refreshing);

  return (
    <div className="p-4 space-y-4 text-sm">
      <section className="space-y-1.5 border-b border-border pb-4">
        <h3 className="font-medium text-foreground">{t("模型价格")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("统计页的费用按模型单价估算，价格来自 LiteLLM 社区维护的价格表，覆盖 Claude、GPT、Grok、Gemini、DeepSeek 等模型；表中没有的模型使用内置的官方价格。")}
        </p>
        {status && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs space-y-1">
            <div>
              <span className="text-muted-foreground">{t("当前使用：")}</span>
              {status.activeSource === "online"
                ? t("在线价格（{{count}} 个模型，更新于 {{time}}）", {
                    count: status.onlineModelCount ?? 0,
                    time: time(status.onlineFetchedAt),
                  })
                : t("内置价格（{{count}} 个模型，生成于 {{time}}）", {
                    count: status.snapshotModelCount,
                    time: time(status.snapshotGeneratedAt),
                  })}
            </div>
            {status.lastAttemptAt && status.autoUpdate && (
              <div className="text-muted-foreground">
                {t("上次检查：{{time}}", { time: time(status.lastAttemptAt) })}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <label className="flex items-center justify-between gap-3">
          <span className="font-medium text-foreground">{t("在线更新价格")}</span>
          <input
            type="checkbox"
            className="accent-primary"
            checked={status?.autoUpdate ?? false}
            disabled={!status || busy !== null}
            onChange={(event) => void toggle(event.target.checked)}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {t("开启后每天从 jsDelivr / GitHub 下载一次 LiteLLM 价格表（约 5 MB）；下载失败或数据异常时继续使用原有价格。关闭后删除已下载的数据，恢复内置价格。")}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => void refresh()}
            disabled={!status?.autoUpdate || refreshing || busy !== null}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-muted text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? t("正在更新…") : t("立即更新")}
          </button>
          {refreshed && !error && <span className="text-xs text-success">{t("价格已更新，重新打开统计页后生效。")}</span>}
        </div>
        {(error || (status?.autoUpdate && status.lastError)) && (
          <div className="text-xs text-destructive break-all">
            {t("更新失败：{{error}}", { error: error ?? status?.lastError ?? "" })}
          </div>
        )}
      </section>

      <button
        onClick={() => onOpenLink(LITELLM_URL)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {t("价格数据：LiteLLM（MIT 许可）")}
        <ExternalLink className="w-3 h-3" />
      </button>
    </div>
  );
}
