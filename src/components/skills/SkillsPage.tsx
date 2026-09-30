import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  Globe,
  FolderOpen,
  Puzzle,
  RefreshCw,
  Loader2,
  AlertCircle,
  Upload,
  ArrowLeftRight,
  Plug,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../services/api";
import type { SkillEntry, SkillsResult, SkillScope } from "../../types";
import { SkillSection, SkillDetailModal, SkillDeleteConfirm } from "./SkillsView";
import { ImportSkillsDialog } from "./ImportSkillsDialog";
import { SkillSyncDialog } from "./SkillSyncDialog";
import { ConfigSyncDialog } from "./ConfigSyncDialog";

export function SkillsPage() {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const selectedProject = useAppStore((s) => s.selectedProject);
  const loadProjects = useAppStore((s) => s.loadProjects);

  const [projectId, setProjectId] = useState<string>(selectedProject ?? "");
  const [data, setData] = useState<SkillsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<SkillEntry | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showImport, setShowImport] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [showConfigSync, setShowConfigSync] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Ensure the project dropdown is populated even on a direct visit to /skills.
  // loadProjects() dedups in-flight requests, so this is cheap.
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const project = projects.find((p) => p.id === projectId);
  // Virtual (codex no-cwd) projects have no real path to scan.
  const projectPath = project && !project.isVirtual ? project.displayPath : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listSkills(projectPath)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, refreshKey]);

  const totalCount = useMemo(
    () =>
      data ? data.global.length + data.plugin.length + data.project.length : 0,
    [data],
  );

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const scope = deleteTarget.scope as SkillScope;
      await api.deleteSkill(
        scope,
        scope === "project" ? projectPath : null,
        deleteTarget.slug,
      );
      setDeleteTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="workspace-list-header">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <Sparkles className="w-6 h-6 text-primary" />
          <div>
            <h1 className="workspace-page-title">Skills</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t("查看全局、插件与项目级 Skills（")}{totalCount}）
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="bg-muted border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[16rem]"
              title={t("选择项目以查看其项目级 Skills")}
            >
              <option value="">{t("（不选项目）")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.alias ?? p.shortName}
                </option>
              ))}
            </select>
            <button
              onClick={() => setShowSync(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-border bg-muted text-foreground hover:bg-accent/50 transition-colors"
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
              {t("跨机同步")}</button>
            <button
              onClick={() => setShowConfigSync(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-border bg-muted text-foreground hover:bg-accent/50 transition-colors"
            >
              <Plug className="w-3.5 h-3.5" />
              {t("MCP / 插件")}</button>
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-border bg-muted text-foreground hover:bg-accent/50 transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              {t("导入")}</button>
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={loading}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-border bg-muted text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              {t("刷新")}</button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="workspace-list-body">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t("扫描 Skills 中...")}</div>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        ) : data ? (
          <>
            {projectPath && (
              <SkillSection
                title={t("项目级 Skills")}
                icon={<FolderOpen className="w-4 h-4 text-success" />}
                skills={data.project}
                onSelect={setActive}
                onDelete={setDeleteTarget}
                emptyHint={t("该项目（{{v0}}）下没有 .claude/skills/", { v0: project?.alias ?? project?.shortName })}
              />
            )}
            <SkillSection
              title={t("全局 Skills")}
              icon={<Globe className="w-4 h-4 text-info" />}
              skills={data.global}
              onSelect={setActive}
              onDelete={setDeleteTarget}
              emptyHint={t("~/.claude/skills/ 下没有 Skills")}
            />
            <SkillSection
              title={t("插件 Skills")}
              icon={<Puzzle className="w-4 h-4 text-purple-500" />}
              skills={data.plugin}
              onSelect={setActive}
              emptyHint={t("~/.claude/plugins/ 下没有 Skills")}
            />
          </>
        ) : null}
      </div>

      {active && (
        <SkillDetailModal skill={active} onClose={() => setActive(null)} />
      )}

      {deleteTarget && (
        <SkillDeleteConfirm
          skill={deleteTarget}
          busy={deleteBusy}
          error={deleteError}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteError(null);
          }}
        />
      )}

      {showImport && (
        <ImportSkillsDialog
          projectPath={projectPath}
          projectName={project ? (project.alias ?? project.shortName) : null}
          defaultScope={projectPath ? "project" : "global"}
          onClose={() => setShowImport(false)}
          onImported={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {showSync && (
        <SkillSyncDialog
          onClose={() => setShowSync(false)}
          onSynced={() => setRefreshKey((key) => key + 1)}
        />
      )}

      {showConfigSync && (
        <ConfigSyncDialog onClose={() => setShowConfigSync(false)} />
      )}
    </div>
  );
}
