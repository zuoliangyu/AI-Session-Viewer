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
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../services/api";
import type { SkillEntry, SkillsResult, SkillScope } from "../../types";
import { SkillSection, SkillDetailModal, SkillDeleteConfirm } from "./SkillsView";
import { ImportSkillsDialog } from "./ImportSkillsDialog";

export function SkillsPage() {
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
      <div className="px-6 pt-6 shrink-0">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <Sparkles className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Skills</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              查看全局、插件与项目级 Skills（{totalCount}）
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="bg-muted border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[16rem]"
              title="选择项目以查看其项目级 Skills"
            >
              <option value="">（不选项目）</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.alias ?? p.shortName}
                </option>
              ))}
            </select>
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-border bg-muted text-foreground hover:bg-accent/50 transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              导入
            </button>
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={loading}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-border bg-muted text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              刷新
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto px-6 pt-2 pb-12">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            扫描 Skills 中...
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        ) : data ? (
          <>
            {projectPath && (
              <SkillSection
                title="项目级 Skills"
                icon={<FolderOpen className="w-4 h-4 text-green-500" />}
                skills={data.project}
                onSelect={setActive}
                onDelete={setDeleteTarget}
                emptyHint={`该项目（${project?.alias ?? project?.shortName}）下没有 .claude/skills/`}
              />
            )}
            <SkillSection
              title="全局 Skills"
              icon={<Globe className="w-4 h-4 text-blue-500" />}
              skills={data.global}
              onSelect={setActive}
              onDelete={setDeleteTarget}
              emptyHint="~/.claude/skills/ 下没有 Skills"
            />
            <SkillSection
              title="插件 Skills"
              icon={<Puzzle className="w-4 h-4 text-purple-500" />}
              skills={data.plugin}
              onSelect={setActive}
              emptyHint="~/.claude/plugins/ 下没有 Skills"
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
    </div>
  );
}
