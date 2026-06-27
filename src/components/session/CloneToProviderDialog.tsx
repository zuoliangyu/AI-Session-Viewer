import { useEffect, useState } from "react";
import { X, Copy, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../../services/api";
import type { SessionIndexEntry } from "../../types";
import type { CloneResult } from "../../types/providerSync";

interface Props {
  session: SessionIndexEntry;
  onClose: () => void;
  /** Called after a successful clone so the caller can refresh the list. */
  onCloned?: (result: CloneResult) => void;
}

/**
 * Non-destructive clone of a Codex session to another model_provider: writes a
 * new rollout (new UUID) + a duplicate state_5.sqlite thread row, leaving the
 * original under its current provider untouched. Backend: provider_sync clone.
 */
export function CloneToProviderDialog({ session, onClose, onCloned }: Props) {
  const [providers, setProviders] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CloneResult | null>(null);

  const current = session.modelProvider || "";
  const title =
    session.alias || session.threadName || session.firstPrompt || session.sessionId;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const status = await api.providerSyncStatus();
        if (!alive) return;
        const list: string[] = status.configuredProviders || [];
        setProviders(list);
        // Default to the first provider that isn't the session's current one.
        setTarget(list.find((p) => p !== current) || list[0] || "");
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoadingProviders(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [current]);

  const handleClone = async () => {
    if (!target) return;
    setCloning(true);
    setError(null);
    try {
      const res = await api.providerSyncClone([session.filePath], target);
      setResult(res);
      if (res.cloned > 0) onCloned?.(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Copy className="w-4 h-4" />
            克隆到其他 Provider
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Session being cloned */}
        <div className="mb-4 text-sm">
          <p className="text-muted-foreground mb-1">会话</p>
          <p className="font-medium line-clamp-2">{title}</p>
          {current && (
            <p className="text-xs text-muted-foreground mt-1">
              当前 Provider：
              <span className="px-1.5 py-0.5 bg-muted rounded ml-1">{current}</span>
            </p>
          )}
        </div>

        {result ? (
          // ── Result view ──
          <div className="mb-4 text-sm space-y-2">
            <div className="flex items-center gap-2 text-green-600 dark:text-green-500">
              <CheckCircle2 className="w-4 h-4" />
              已克隆 {result.cloned} 个副本到「{result.targetProvider}」
            </div>
            {result.skipped.length > 0 && (
              <div className="text-yellow-600 dark:text-yellow-500 text-xs">
                跳过 {result.skipped.length} 个（文件缺失/被占用/无 thread 记录）
              </div>
            )}
            {result.encryptedSessionIds.length > 0 && (
              <div className="flex items-start gap-1.5 text-yellow-600 dark:text-yellow-500 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  其中 {result.encryptedSessionIds.length} 个含加密内容
                  （encrypted_content），跨 Provider/账号可能可见但无法 resume/compact。
                </span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              原会话保留在「{current || "原 Provider"}」下未改动。已备份 state_5.sqlite。
            </p>
          </div>
        ) : (
          // ── Provider picker ──
          <div className="mb-6">
            <label className="block text-sm font-medium mb-1.5">目标 Provider</label>
            {loadingProviders ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                读取已配置的 Provider...
              </div>
            ) : providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                config.toml 里没有找到 [model_providers.*]，无法选择目标。
              </p>
            ) : (
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                    {p === current ? "（当前）" : ""}
                  </option>
                ))}
              </select>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              复制一份对话（新 UUID）挂到目标 Provider，原会话不动。
            </p>
          </div>
        )}

        {error && (
          <div className="mb-4 text-xs text-destructive bg-destructive/10 rounded-md p-2">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={cloning}
            className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
          >
            {result ? "关闭" : "取消"}
          </button>
          {!result && (
            <button
              onClick={handleClone}
              disabled={cloning || loadingProviders || !target}
              className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              {cloning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {cloning ? "克隆中..." : "克隆"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
