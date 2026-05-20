import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useProviderSyncStore } from "../../stores/providerSyncStore";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  Database,
  FileJson,
  FolderOpen,
  History,
  Loader2,
  RefreshCw,
  Repeat,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { BackupSummary, ProviderSyncStatus } from "../../types/providerSync";

export function ProviderSyncPage() {
  const source = useAppStore((s) => s.source);
  const {
    status,
    loading,
    error,
    busy,
    lastResult,
    lastRestore,
    loadStatus,
    runSync,
    runSwitch,
    runRestore,
    prune,
    clearError,
  } = useProviderSyncStore();

  const [switchProvider, setSwitchProvider] = useState("");
  const [customProvider, setCustomProvider] = useState("");
  const [keep, setKeep] = useState(5);
  const [restoreTarget, setRestoreTarget] = useState<BackupSummary | null>(null);
  const [restoreOpts, setRestoreOpts] = useState({
    includeConfig: true,
    includeDb: true,
    includeSessions: true,
    includeGlobalState: true,
  });
  const [confirmSync, setConfirmSync] = useState(false);

  useEffect(() => {
    if (source === "codex") {
      loadStatus();
    }
  }, [source, loadStatus]);

  const providerOptions = useMemo(() => {
    if (!status) return [] as string[];
    const all = new Set<string>(status.configuredProviders);
    status.rolloutStats.forEach((p) => p.provider && all.add(p.provider));
    status.sqliteStats.forEach((p) => p.provider && all.add(p.provider));
    all.add(status.currentProvider);
    return Array.from(all).filter(Boolean).sort();
  }, [status]);

  useEffect(() => {
    if (status && !switchProvider) {
      const others = providerOptions.filter((p) => p !== status.currentProvider);
      setSwitchProvider(others[0] ?? status.currentProvider);
    }
  }, [status, providerOptions, switchProvider]);

  if (source !== "codex") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <Settings2 className="w-10 h-10 text-muted-foreground mx-auto" />
          <h2 className="text-lg font-semibold">仅 Codex 数据源可用</h2>
          <p className="text-sm text-muted-foreground">
            Provider 同步工具只针对 Codex 的 rollout / SQLite / global state
            做修复。请先在左上角切换到 Codex 数据源。
          </p>
        </div>
      </div>
    );
  }

  const totalMismatched =
    (status?.mismatchedRollouts ?? 0) +
    (status?.mismatchedArchived ?? 0) +
    (status?.mismatchedSqliteThreads ?? 0);

  const onSync = async () => {
    setConfirmSync(false);
    try {
      await runSync(null, keep);
    } catch {
      /* error already in store */
    }
  };

  const onSwitch = async () => {
    const target = (customProvider.trim() || switchProvider).trim();
    if (!target) return;
    if (status && target === status.currentProvider) {
      await onSync();
      return;
    }
    if (
      !window.confirm(
        `将 config.toml 顶层 model_provider 改为 "${target}"，并同步所有 rollout / SQLite 元数据。继续？`,
      )
    ) {
      return;
    }
    try {
      await runSwitch(target, keep);
      setCustomProvider("");
    } catch {
      /* surfaced via store */
    }
  };

  const onRestore = async () => {
    if (!restoreTarget) return;
    try {
      await runRestore(restoreTarget.path, restoreOpts);
      setRestoreTarget(null);
    } catch {
      /* surfaced via store */
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Repeat className="w-5 h-5 text-green-500" />
              Codex Provider 同步
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              切换 Codex 供应商后，历史 rollout 和 SQLite 元数据仍指向旧
              provider，导致在 Codex Desktop / <code>/resume</code> 中看不见。
              本工具把它们对齐到当前 config.toml 中的 model_provider，并备份原文件。
            </p>
          </div>
          <button
            onClick={() => loadStatus()}
            disabled={loading || busy}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-card hover:bg-accent/50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新状态
          </button>
        </header>

        {error && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <div className="flex-1 text-sm text-red-600 dark:text-red-400 break-all">
              {error}
            </div>
            <button
              onClick={clearError}
              className="text-xs text-red-500 hover:text-red-400 shrink-0"
            >
              关闭
            </button>
          </div>
        )}

        {loading && !status ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            正在扫描 ~/.codex ...
          </div>
        ) : status ? (
          <>
            <StatusOverview status={status} totalMismatched={totalMismatched} />

            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <Repeat className="w-4 h-4" />
                同步与切换
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    把所有不匹配当前 provider「
                    <span className="font-mono text-foreground">
                      {status.currentProvider}
                    </span>
                    」的 rollout / SQLite 记录改写过来。
                  </p>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground">
                      保留备份份数
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={keep}
                      onChange={(e) => setKeep(Number(e.target.value) || 5)}
                      className="w-16 bg-muted border border-border rounded px-2 py-1 text-xs"
                    />
                  </div>
                  {!confirmSync ? (
                    <button
                      onClick={() => setConfirmSync(true)}
                      disabled={busy || totalMismatched === 0}
                      className="w-full px-3 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                    >
                      同步到 {status.currentProvider}
                      {totalMismatched > 0 && (
                        <span className="ml-1 text-xs opacity-80">
                          ({totalMismatched} 处不匹配)
                        </span>
                      )}
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={onSync}
                        disabled={busy}
                        className="flex-1 px-3 py-2 text-sm rounded-md bg-yellow-500 text-black hover:bg-yellow-400 transition-colors disabled:opacity-50"
                      >
                        {busy ? "执行中..." : "确认同步"}
                      </button>
                      <button
                        onClick={() => setConfirmSync(false)}
                        disabled={busy}
                        className="px-3 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
                      >
                        取消
                      </button>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    切换：改写 config.toml 中的 model_provider，并把历史元数据
                    一并对齐到目标 provider。
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-muted-foreground">
                      选择已配置的 provider
                    </label>
                    <select
                      value={switchProvider}
                      onChange={(e) => setSwitchProvider(e.target.value)}
                      disabled={busy}
                      className="bg-muted border border-border rounded px-2 py-1.5 text-xs"
                    >
                      {providerOptions.map((p) => (
                        <option key={p} value={p}>
                          {p}
                          {p === status.currentProvider ? "（当前）" : ""}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={customProvider}
                      onChange={(e) => setCustomProvider(e.target.value)}
                      placeholder="或填入自定义 provider id"
                      className="bg-muted border border-border rounded px-2 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <button
                    onClick={onSwitch}
                    disabled={busy}
                    className="w-full px-3 py-2 text-sm rounded-md border border-primary text-primary hover:bg-primary/10 disabled:opacity-50 transition-colors"
                  >
                    切换并同步
                  </button>
                </div>
              </div>
              {busy && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  正在写入备份、改写 rollout / SQLite ...
                </div>
              )}
              {lastResult && !busy && (
                <SyncResultSummary result={lastResult} />
              )}
              {lastRestore && !busy && (
                <div className="text-xs text-muted-foreground rounded-md border border-border bg-muted/40 px-3 py-2">
                  恢复完成：还原 {lastRestore.restoredFiles} 个配置文件，
                  {lastRestore.restoredSessions} 个 rollout 首行。
                </div>
              )}
            </section>

            <BackupSection
              backups={status.backups}
              onSelect={(b) => {
                setRestoreTarget(b);
                setRestoreOpts({
                  includeConfig: true,
                  includeDb: true,
                  includeSessions: true,
                  includeGlobalState: true,
                });
              }}
              onPrune={() => {
                if (window.confirm(`只保留最近 ${keep} 份备份，确认删除更旧的？`)) {
                  prune(keep);
                }
              }}
              busy={busy}
              keep={keep}
            />

            {status.encryptedWarnings.length > 0 && (
              <section className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm">
                <h3 className="font-medium text-yellow-700 dark:text-yellow-300 flex items-center gap-1.5 mb-1">
                  <ShieldAlert className="w-4 h-4" />
                  加密内容警告
                </h3>
                <p className="text-xs text-muted-foreground mb-2">
                  以下旧 provider 的会话包含 <code>encrypted_content</code>，
                  同步后会出现在列表里，但「继续对话」或 compact 可能仍会失败
                  （invalid_encrypted_content）。若需可靠续聊，请切回原 provider。
                </p>
                <ul className="text-xs space-y-0.5">
                  {status.encryptedWarnings.map((w) => (
                    <li key={w.provider} className="font-mono">
                      {w.provider}: {w.count} 条
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : null}
      </div>

      {restoreTarget && (
        <RestoreModal
          target={restoreTarget}
          options={restoreOpts}
          onOptionsChange={setRestoreOpts}
          onConfirm={onRestore}
          onCancel={() => setRestoreTarget(null)}
          busy={busy}
        />
      )}
    </div>
  );
}

function StatusOverview({
  status,
  totalMismatched,
}: {
  status: ProviderSyncStatus;
  totalMismatched: number;
}) {
  return (
    <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="rounded-lg border border-border bg-card p-4 space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <FileJson className="w-4 h-4 text-green-500" />
          config.toml
        </div>
        <div className="text-xs space-y-1 text-muted-foreground">
          <div>
            当前 provider：
            <span className="ml-1 font-mono text-foreground">
              {status.currentProvider}
            </span>
            {status.currentProviderImplicit && (
              <span className="ml-1 text-yellow-500">(默认值，未显式设置)</span>
            )}
          </div>
          <div className="break-all">路径：{status.configTomlPath}</div>
          <div>
            已配置 [model_providers.*]：
            <span className="ml-1 font-mono text-foreground">
              {status.configuredProviders.join(", ") || "无"}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <AlertTriangle
            className={`w-4 h-4 ${totalMismatched > 0 ? "text-yellow-500" : "text-green-500"}`}
          />
          不一致汇总
        </div>
        <div className="text-xs space-y-1 text-muted-foreground">
          <div>
            sessions/ rollout：
            <span className="ml-1 font-mono text-foreground">
              {status.mismatchedRollouts}
            </span>
          </div>
          <div>
            archived_sessions/ rollout：
            <span className="ml-1 font-mono text-foreground">
              {status.mismatchedArchived}
            </span>
          </div>
          <div>
            state_5.sqlite 线程：
            <span className="ml-1 font-mono text-foreground">
              {status.mismatchedSqliteThreads}
            </span>
          </div>
        </div>
      </div>

      <ProviderDistribution
        title="活跃会话分布"
        icon={<FolderOpen className="w-4 h-4 text-blue-500" />}
        entries={status.rolloutStats}
        current={status.currentProvider}
      />
      <ProviderDistribution
        title="归档会话分布"
        icon={<Archive className="w-4 h-4 text-purple-500" />}
        entries={status.archivedStats}
        current={status.currentProvider}
      />

      <div className="rounded-lg border border-border bg-card p-4 space-y-2 md:col-span-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Database className="w-4 h-4 text-orange-500" />
          state_5.sqlite threads
          {!status.sqliteExists && (
            <span className="text-xs text-yellow-500 ml-2">(文件不存在，跳过)</span>
          )}
        </div>
        {status.sqliteExists ? (
          <div className="text-xs grid grid-cols-2 md:grid-cols-3 gap-1">
            {status.sqliteStats.length === 0 ? (
              <span className="text-muted-foreground">无线程记录</span>
            ) : (
              status.sqliteStats.map((entry, i) => (
                <div
                  key={`${entry.provider}-${entry.archived}-${i}`}
                  className={`flex items-center justify-between px-2 py-1 rounded font-mono text-foreground border ${entry.provider === status.currentProvider ? "border-green-500/40 bg-green-500/10" : "border-border bg-muted/40"}`}
                >
                  <span className="truncate">
                    {entry.provider || "(空)"}
                    {entry.archived && (
                      <span className="ml-1 text-purple-400 text-[10px]">归档</span>
                    )}
                  </span>
                  <span className="ml-2 text-muted-foreground">{entry.count}</span>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ProviderDistribution({
  title,
  icon,
  entries,
  current,
}: {
  title: string;
  icon: React.ReactNode;
  entries: { provider: string; count: number }[];
  current: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        {icon}
        {title}
      </div>
      {entries.length === 0 ? (
        <div className="text-xs text-muted-foreground">未发现会话</div>
      ) : (
        <div className="space-y-1 text-xs">
          {entries.map((entry) => (
            <div
              key={entry.provider}
              className={`flex items-center justify-between px-2 py-1 rounded font-mono border ${entry.provider === current ? "border-green-500/40 bg-green-500/10 text-foreground" : "border-border bg-muted/40 text-muted-foreground"}`}
            >
              <span className="truncate">{entry.provider || "(空)"}</span>
              <span className="ml-2">{entry.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SyncResultSummary({ result }: { result: { backupDir: string; targetProvider: string; updatedRollouts: number; updatedSqliteRows: number; globalStateUpdated: boolean; configUpdated: boolean; skippedLocked: string[] } }) {
  return (
    <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-xs space-y-1">
      <div className="font-medium text-green-700 dark:text-green-400">
        已同步到 {result.targetProvider}
      </div>
      <div className="text-muted-foreground space-y-0.5">
        <div>rollout 改写：{result.updatedRollouts}</div>
        <div>SQLite 线程改写：{result.updatedSqliteRows}</div>
        <div>
          global state：{result.globalStateUpdated ? "已规范化路径" : "无需改动"}
        </div>
        <div>config.toml：{result.configUpdated ? "已写入新 provider" : "未改动"}</div>
        <div className="break-all">备份目录：{result.backupDir}</div>
        {result.skippedLocked.length > 0 && (
          <details>
            <summary className="cursor-pointer text-yellow-500">
              跳过 {result.skippedLocked.length} 个被锁的文件
            </summary>
            <ul className="mt-1 list-disc list-inside font-mono">
              {result.skippedLocked.map((p) => (
                <li key={p} className="break-all">
                  {p}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

function BackupSection({
  backups,
  onSelect,
  onPrune,
  busy,
  keep,
}: {
  backups: BackupSummary[];
  onSelect: (b: BackupSummary) => void;
  onPrune: () => void;
  busy: boolean;
  keep: number;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <History className="w-4 h-4" />
          备份历史
        </h2>
        <button
          onClick={onPrune}
          disabled={busy || backups.length <= keep}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-muted hover:bg-accent/50 transition-colors disabled:opacity-50"
          title={`只保留最近 ${keep} 份`}
        >
          <Trash2 className="w-3 h-3" />
          清理旧备份
        </button>
      </div>
      {backups.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">
          还没有备份。执行同步后会自动写入到 ~/.codex/backups_state/provider-sync/
        </div>
      ) : (
        <div className="space-y-1.5">
          {backups.map((b) => (
            <div
              key={b.path}
              className="flex items-center gap-3 px-3 py-2 rounded-md border border-border bg-muted/30 hover:bg-muted/60 transition-colors"
            >
              <div className="flex-1 min-w-0 text-xs">
                <div className="font-mono text-foreground truncate">{b.name}</div>
                <div className="text-muted-foreground">
                  → {b.targetProvider} · 改写 {b.changedSessionCount} 个 rollout
                </div>
                <div className="text-muted-foreground/70 text-[10px] break-all">
                  {b.path}
                </div>
              </div>
              <button
                onClick={() => onSelect(b)}
                disabled={busy}
                className="shrink-0 flex items-center gap-1 px-2 py-1 text-xs rounded border border-border hover:bg-accent transition-colors disabled:opacity-50"
              >
                <RotateCcw className="w-3 h-3" />
                恢复
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RestoreModal({
  target,
  options,
  onOptionsChange,
  onConfirm,
  onCancel,
  busy,
}: {
  target: BackupSummary;
  options: {
    includeConfig: boolean;
    includeDb: boolean;
    includeSessions: boolean;
    includeGlobalState: boolean;
  };
  onOptionsChange: (
    next: {
      includeConfig: boolean;
      includeDb: boolean;
      includeSessions: boolean;
      includeGlobalState: boolean;
    },
  ) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-lg w-full max-w-md p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <RotateCcw className="w-4 h-4" />
          恢复备份
        </h3>
        <div className="text-xs text-muted-foreground space-y-1">
          <div>
            备份：<span className="font-mono text-foreground">{target.name}</span>
          </div>
          <div>
            原目标：
            <span className="font-mono text-foreground">{target.targetProvider}</span>
          </div>
        </div>
        <div className="space-y-1.5 pt-2 border-t border-border">
          <Checkbox
            checked={options.includeConfig}
            onChange={(v) => onOptionsChange({ ...options, includeConfig: v })}
            label="config.toml"
          />
          <Checkbox
            checked={options.includeDb}
            onChange={(v) => onOptionsChange({ ...options, includeDb: v })}
            label="state_5.sqlite (含 -shm / -wal)"
          />
          <Checkbox
            checked={options.includeSessions}
            onChange={(v) => onOptionsChange({ ...options, includeSessions: v })}
            label="rollout 文件首行 (session_meta)"
          />
          <Checkbox
            checked={options.includeGlobalState}
            onChange={(v) =>
              onOptionsChange({ ...options, includeGlobalState: v })
            }
            label=".codex-global-state.json"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {busy ? "恢复中..." : "确认恢复"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-border"
      />
      <span className="text-foreground">{label}</span>
    </label>
  );
}
