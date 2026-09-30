import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  Check,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import type { SkillEntry } from "../../types";
import { getActiveNodeId } from "../../services/nodeConfig";
import {
  applyNodeGlobalSkill,
  exportNodeGlobalSkill,
  getSkillSyncNodes,
  listNodeGlobalSkills,
} from "../../services/skillSync";
import { EscapeToClose } from "../common/EscapeToClose";

export function SkillSyncDialog({
  onClose,
  onSynced,
}: {
  onClose: () => void;
  onSynced: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useMemo(getSkillSyncNodes, [t]);
  const activeId = getActiveNodeId();
  const initialSource = nodes.some((node) => node.id === activeId)
    ? activeId
    : nodes[0]?.id ?? "";
  const [sourceId, setSourceId] = useState(initialSource);
  const [targetId, setTargetId] = useState(
    nodes.find((node) => node.id !== initialSource)?.id ?? "",
  );
  const [sourceSkills, setSourceSkills] = useState<SkillEntry[]>([]);
  const [targetSlugs, setTargetSlugs] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);

  const loadPreview = async () => {
    if (!source || !target || source.id === target.id) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const [sourceData, targetData] = await Promise.all([
        listNodeGlobalSkills(source),
        listNodeGlobalSkills(target),
      ]);
      const slugs = new Set(targetData.global.map((skill) => skill.slug));
      setSourceSkills(sourceData.global);
      setTargetSlugs(slugs);
      setSelected(
        new Set(
          sourceData.global
            .filter((skill) => !slugs.has(skill.slug))
            .map((skill) => skill.slug),
        ),
      );
    } catch (cause) {
      setSourceSkills([]);
      setTargetSlugs(new Set());
      setSelected(new Set());
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPreview();
  }, [sourceId, targetId]);

  const toggle = (slug: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const selectAll = () => {
    const allowed = sourceSkills
      .filter((skill) => overwrite || !targetSlugs.has(skill.slug))
      .map((skill) => skill.slug);
    setSelected(selected.size === allowed.length ? new Set() : new Set(allowed));
  };

  const sync = async () => {
    if (!source || !target) return;
    const skills = sourceSkills.filter(
      (skill) =>
        selected.has(skill.slug) &&
        (overwrite || !targetSlugs.has(skill.slug)),
    );
    if (skills.length === 0) return;

    setSyncing(true);
    setError(null);
    setResult(null);
    let completed = 0;
    try {
      for (const skill of skills) {
        const archive = await exportNodeGlobalSkill(source, skill.slug);
        await applyNodeGlobalSkill(target, skill.slug, archive, overwrite);
        completed += 1;
      }
      if (target.id === activeId) onSynced();
      await loadPreview();
      setResult(t("已同步 {{v0}} 个 Skill", { v0: completed }));
    } catch (cause) {
      setError(
        `${completed > 0 ? t("已完成 {{v0}} 个；", { v0: completed }) : ""}${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <EscapeToClose onClose={onClose} />
      <div
        className="flex max-h-[85vh] w-[42rem] max-w-full flex-col rounded-lg border border-border bg-card shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("同步全局 Skills")}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("关闭")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {nodes.length < 2 ? (
          <div className="p-6 text-sm text-muted-foreground">
            {t("至少需要两个可访问的 session-web 节点。")}</div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border p-4">
              <select
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-2 text-sm"
                title={t("源机器")}
              >
                {nodes.map((node) => (
                  <option key={node.id} value={node.id} disabled={node.id === targetId}>
                    {node.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  setSourceId(targetId);
                  setTargetId(sourceId);
                }}
                className="rounded p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t("交换源机器和目标机器")}
              >
                <ArrowLeftRight className="h-4 w-4" />
              </button>
              <select
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-2 text-sm"
                title={t("目标机器")}
              >
                {nodes.map((node) => (
                  <option key={node.id} value={node.id} disabled={node.id === sourceId}>
                    {node.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void loadPreview()}
                disabled={loading || syncing}
                className="rounded p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                title={t("刷新预览")}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>

            <div className="flex items-center justify-between border-b border-border px-4 py-3 text-xs">
              <button
                onClick={selectAll}
                className="text-muted-foreground hover:text-foreground"
              >
                {t("全选 / 取消全选")}</button>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setOverwrite(checked);
                    if (!checked) {
                      setSelected(
                        (current) =>
                          new Set(
                            [...current].filter((slug) => !targetSlugs.has(slug)),
                          ),
                      );
                    }
                  }}
                />
                {t("覆盖同名 Skill（自动备份）")}</label>
            </div>

            <div className="min-h-0 flex-1 overflow-auto divide-y divide-border">
              {loading ? (
                <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("正在生成差异预览...")}</div>
              ) : sourceSkills.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">{t("源机器没有全局 Skill。")}</div>
              ) : (
                sourceSkills.map((skill) => {
                  const conflict = targetSlugs.has(skill.slug);
                  const disabled = conflict && !overwrite;
                  return (
                    <label
                      key={skill.slug}
                      className={`flex items-center gap-3 px-4 py-3 ${
                        disabled ? "opacity-50" : "hover:bg-accent/30"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(skill.slug)}
                        disabled={disabled || syncing}
                        onChange={() => toggle(skill.slug)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{skill.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{skill.slug}</div>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {conflict ? (overwrite ? t("覆盖") : t("冲突")) : t("新增")}
                      </span>
                    </label>
                  );
                })
              )}
            </div>

            {(error || result) && (
              <div
                className={`border-t border-border px-4 py-3 text-xs ${
                  error ? "text-destructive" : "text-green-500"
                }`}
              >
                {error ?? result}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-border p-4">
              <button
                onClick={onClose}
                disabled={syncing}
                className="rounded border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
              >
                {t("关闭")}</button>
              <button
                onClick={() => void sync()}
                disabled={syncing || loading || selected.size === 0}
                className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {t("开始同步")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
