import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import {
  Trash2,
  RotateCcw,
  Trash,
  AlertTriangle,
  FolderOpen,
  FileText,
  FolderX,
  ScanLine,
  Loader2,
} from "lucide-react";
import type { RecycledItem } from "../../types";
import { formatDateTime } from "../../utils/dateTime";
import { useShallow } from "zustand/react/shallow";
import { EscapeToClose } from "../common/EscapeToClose";

const REASON_LABELS: Record<string, string> = {
  get ManualDelete() { return t("手动删除"); },
  get Empty() { return t("空文件"); },
  get NoMessages() { return t("无消息"); },
  get Corrupt() { return t("文件损坏"); },
  get OrphanDir() { return t("孤儿目录"); },
};

type TypeFilter = "all" | "session" | "project" | "orphanDir";

const TYPE_TABS: { key: TypeFilter; label: string }[] = [
  { key: "all", get label() { return t("全部"); } },
  { key: "session", get label() { return t("会话"); } },
  { key: "project", get label() { return t("项目"); } },
  { key: "orphanDir", get label() { return t("孤儿目录"); } },
];

function ItemIcon({ itemType }: { itemType: string }) {
  useTranslation();
  if (itemType === "project") return <FolderOpen className="w-4 h-4 text-blue-400" />;
  if (itemType === "orphanDir") return <FolderX className="w-4 h-4 text-yellow-400" />;
  return <FileText className="w-4 h-4 text-muted-foreground" />;
}

function TypeBadge({ itemType }: { itemType: string }) {
  const { t } = useTranslation();
  const styles: Record<string, string> = {
    session: "bg-muted text-muted-foreground",
    project: "bg-blue-500/15 text-blue-400",
    orphanDir: "bg-yellow-500/15 text-yellow-500",
  };
  const labels: Record<string, string> = {
    session: t("会话"),
    project: t("项目"),
    orphanDir: t("孤儿目录"),
  };
  return (
    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${styles[itemType] ?? "bg-muted text-muted-foreground"}`}>
      {labels[itemType] ?? itemType}
    </span>
  );
}

function ReasonBadge({ reason }: { reason: string }) {
  useTranslation();
  const isAuto = reason !== "ManualDelete";
  return (
    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${isAuto ? "bg-orange-500/15 text-orange-400" : "bg-muted text-muted-foreground"}`}>
      {REASON_LABELS[reason] ?? reason}
    </span>
  );
}

export function RecyclebinPage() {
  const { t } = useTranslation();
  const {
    recycledItems,
    recyclebinLoading,
    loadRecycledItems,
    restoreItem,
    permanentlyDeleteItem,
    emptyRecyclebin,
    cleanupOrphanDirs,
    timeZone,
  } = useAppStore(
    useShallow((state) => ({ recycledItems: state.recycledItems, recyclebinLoading: state.recyclebinLoading, loadRecycledItems: state.loadRecycledItems, restoreItem: state.restoreItem, permanentlyDeleteItem: state.permanentlyDeleteItem, emptyRecyclebin: state.emptyRecyclebin, cleanupOrphanDirs: state.cleanupOrphanDirs, timeZone: state.timeZone })),
  );

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanResult, setScanResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRecycledItems();
  }, []);

  const filtered = typeFilter === "all"
    ? recycledItems
    : recycledItems.filter((i) => i.itemType === typeFilter);

  const countByType = (type: TypeFilter) =>
    type === "all" ? recycledItems.length : recycledItems.filter((i) => i.itemType === type).length;

  const handleRestore = async (item: RecycledItem) => {
    setActionLoading(item.id);
    setError(null);
    try {
      await restoreItem(item.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handlePermanentDelete = async (item: RecycledItem) => {
    setActionLoading(item.id);
    setError(null);
    try {
      await permanentlyDeleteItem(item.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleEmptyRecyclebin = async () => {
    setConfirmEmpty(false);
    setError(null);
    try {
      await emptyRecyclebin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleScanOrphanDirs = async () => {
    setScanLoading(true);
    setScanResult(null);
    setError(null);
    try {
      const count = await cleanupOrphanDirs();
      setScanResult(count);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="workspace-list-header">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-muted-foreground" />
            <h1 className="workspace-page-title">{t("回收站")}</h1>
            {recycledItems.length > 0 && (
              <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
                {recycledItems.length} {t("项")}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* 扫描孤儿目录 */}
            <button
              onClick={handleScanOrphanDirs}
              disabled={scanLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
              title={t("扫描所有项目中的孤儿 UUID 目录并移入回收站")}
            >
              {scanLoading
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <ScanLine className="w-3.5 h-3.5" />
              }
              {t("扫描孤儿目录")}</button>
            {recycledItems.length > 0 && (
              <button
                onClick={() => setConfirmEmpty(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <Trash className="w-3.5 h-3.5" />
                {t("清空")}</button>
            )}
          </div>
        </div>

        {/* 扫描结果提示 */}
        {scanResult !== null && (
          <div className="mb-2 flex items-center gap-1.5 text-xs text-green-400">
            <ScanLine className="w-3.5 h-3.5" />
            {scanResult === 0 ? t("未发现孤儿目录") : t("已将 {{v0}} 个孤儿目录移入回收站", { v0: scanResult })}
            <button onClick={() => setScanResult(null)} className="ml-1 opacity-60 hover:opacity-100">×</button>
          </div>
        )}

        {/* 类型过滤 tabs */}
        <div className="flex gap-1 flex-wrap">
          {TYPE_TABS.map((tab) => {
            const cnt = countByType(tab.key);
            return (
              <button
                key={tab.key}
                onClick={() => setTypeFilter(tab.key)}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors ${
                  typeFilter === tab.key
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                {tab.label}
                {cnt > 0 && (
                  <span className={`text-[10px] px-1 py-0.5 rounded ${typeFilter === tab.key ? "bg-foreground/20" : "bg-muted"}`}>
                    {cnt}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-3 flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/30 text-xs text-red-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto shrink-0 hover:text-red-300">×</button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {recyclebinLoading ? (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            {t("加载中...")}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
            <Trash2 className="w-12 h-12 opacity-20" />
            <p className="text-sm">
              {typeFilter === "all" ? t("回收站为空") : t("没有「{{v0}}」类型的条目", { v0: TYPE_TABS.find(t => t.key === typeFilter)?.label })}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 p-3 rounded-md border border-border bg-card hover:bg-accent/30 transition-colors"
              >
                {/* Type icon */}
                <div className="shrink-0">
                  <ItemIcon itemType={item.itemType} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-medium text-foreground truncate max-w-[14rem]">
                      {item.sessionTitle || item.projectName || item.originalPath.split(/[\\/]/).pop() || item.storedName}
                    </span>
                    <TypeBadge itemType={item.itemType} />
                    <ReasonBadge reason={item.reason} />
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                    {item.projectName && item.itemType !== "project" && (
                      <span className="truncate max-w-[160px]">
                        {item.projectName}
                      </span>
                    )}
                    {item.members && item.members.length > 0 && (
                      <span className="shrink-0">{t("包含 {{v0}} 项", { v0: item.members.length })}</span>
                    )}
                    <span className="shrink-0">{formatDateTime(item.movedAt, timeZone, "minute")}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleRestore(item)}
                    disabled={actionLoading === item.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-border text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
                    title={t("还原到原始路径")}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {t("还原")}</button>
                  <button
                    onClick={() => handlePermanentDelete(item)}
                    disabled={actionLoading === item.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                    title={t("永久删除")}
                  >
                    <Trash className="w-3.5 h-3.5" />
                    {t("删除")}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Confirm empty dialog */}
      {confirmEmpty && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setConfirmEmpty(false)}
          role="dialog"
          aria-modal="true"
        >
          <EscapeToClose onClose={() => setConfirmEmpty(false)} />
          <div
            className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
              <h3 className="workspace-page-title">{t("清空回收站")}</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              {t("将永久删除回收站中的全部{{v0}} 项内容，此操作无法撤销。", { v0: recycledItems.length })}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmEmpty(false)}
                className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
              >
                {t("取消")}</button>
              <button
                onClick={handleEmptyRecyclebin}
                className="px-4 py-2 text-sm rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                {t("永久删除全部")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
