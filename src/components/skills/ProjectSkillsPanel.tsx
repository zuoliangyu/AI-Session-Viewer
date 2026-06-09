import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Sparkles,
  Globe,
  FolderOpen,
  ChevronRight,
  Loader2,
  AlertCircle,
  ArrowUpRight,
} from "lucide-react";
import { api } from "../../services/api";
import type { SkillEntry, SkillsResult, SkillScope } from "../../types";
import { SkillSection, SkillDetailModal, SkillDeleteConfirm } from "./SkillsView";

/**
 * Collapsible Skills panel for the sessions page. Shows the current project's
 * project-level skills plus global skills. Fetches lazily on first expand so
 * navigating between projects doesn't trigger a plugins-tree scan every time.
 */
export function ProjectSkillsPanel({ projectPath }: { projectPath: string | null }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SkillsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<SkillEntry | null>(null);
  const [tick, setTick] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<SkillEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const fetchedKey = useRef<string | null>(null);

  const reload = () => {
    fetchedKey.current = null;
    setTick((t) => t + 1);
  };

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
      reload();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const key = projectPath ?? "";
    if (fetchedKey.current === key && data) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listSkills(projectPath)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          fetchedKey.current = key;
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
  }, [open, projectPath, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = data ? data.project.length + data.global.length : null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-card/50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-foreground hover:bg-accent/30 transition-colors rounded-lg"
      >
        <ChevronRight
          className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="font-medium">Skills</span>
        {count !== null && (
          <span className="text-xs text-muted-foreground">（项目 + 全局 {count}）</span>
        )}
        <span
          role="link"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            navigate("/skills");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              navigate("/skills");
            }
          }}
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
          title="在 Skills 页查看全部（含插件）"
        >
          查看全部
          <ArrowUpRight className="w-3.5 h-3.5" />
        </span>
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1 border-t border-border">
          {loading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              加载中...
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 py-2 text-sm text-destructive">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          ) : data ? (
            <div className="pt-2">
              {projectPath && (
                <SkillSection
                  title="项目级"
                  icon={<FolderOpen className="w-4 h-4 text-green-500" />}
                  skills={data.project}
                  onSelect={setActive}
                  onDelete={setDeleteTarget}
                  emptyHint="该项目下没有 .claude/skills/"
                />
              )}
              <SkillSection
                title="全局"
                icon={<Globe className="w-4 h-4 text-blue-500" />}
                skills={data.global}
                onSelect={setActive}
                onDelete={setDeleteTarget}
                emptyHint="~/.claude/skills/ 下没有 Skills"
              />
            </div>
          ) : null}
        </div>
      )}

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
    </div>
  );
}
