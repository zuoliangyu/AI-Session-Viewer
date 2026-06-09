import { useEffect, useState, type ReactNode } from "react";
import {
  Sparkles,
  X,
  Loader2,
  AlertCircle,
  Copy,
  Check,
  Trash2,
  AlertTriangle,
  Link2,
} from "lucide-react";
import { api } from "../../services/api";
import { MarkdownContent } from "../message/MarkdownContent";
import type { SkillEntry } from "../../types";

/** Strip the leading YAML frontmatter block so the rendered Markdown body
 *  doesn't start with a raw `--- name: ... ---` dump. */
export function stripFrontmatter(md: string): string {
  const text = md.replace(/^﻿/, "");
  const lines = text.split("\n");
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        return lines.slice(i + 1).join("\n").replace(/^\s+/, "");
      }
    }
  }
  return text;
}

const SCOPE_LABEL: Record<SkillEntry["scope"], string> = {
  global: "全局",
  project: "项目",
  plugin: "插件",
};

const SCOPE_BADGE_CLASS: Record<SkillEntry["scope"], string> = {
  global: "bg-blue-500/15 text-blue-500",
  project: "bg-green-500/15 text-green-500",
  plugin: "bg-purple-500/15 text-purple-500",
};

export function SkillCard({
  skill,
  onClick,
  onDelete,
}: {
  skill: SkillEntry;
  onClick: () => void;
  /** When provided, a delete affordance is shown on hover. */
  onDelete?: (skill: SkillEntry) => void;
}) {
  return (
    <div className="relative group">
      <button
        onClick={onClick}
        className="text-left w-full bg-card border border-border rounded-lg p-3 hover:border-primary/50 hover:bg-accent/30 transition-all"
      >
        <div className="flex items-center gap-2 mb-1 pr-6">
          <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">
            {skill.name}
          </span>
          {skill.isSymlink && (
            <Link2
              className="w-3 h-3 text-muted-foreground/60 shrink-0"
              aria-label="符号链接"
            />
          )}
          {skill.sourceLabel && (
            <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground truncate max-w-[8rem]">
              {skill.sourceLabel}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">
          {skill.description || "（无描述）"}
        </p>
      </button>
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(skill);
          }}
          className="absolute top-2 right-2 p-1 rounded text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-destructive hover:bg-accent/50 transition-colors"
          title="删除此 skill"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

export function SkillSection({
  title,
  icon,
  skills,
  onSelect,
  onDelete,
  emptyHint,
}: {
  title: string;
  icon: ReactNode;
  skills: SkillEntry[];
  onSelect: (skill: SkillEntry) => void;
  onDelete?: (skill: SkillEntry) => void;
  emptyHint: string;
}) {
  return (
    <section className="mb-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground mb-2">
        {icon}
        {title}
        <span className="text-xs font-normal text-muted-foreground">
          ({skills.length})
        </span>
      </h2>
      {skills.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {skills.map((s) => (
            <SkillCard
              key={s.path}
              skill={s}
              onClick={() => onSelect(s)}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function SkillDeleteConfirm({
  skill,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  skill: SkillEntry;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-lg p-6 max-w-sm w-full shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
          <h3 className="text-base font-semibold text-foreground">删除 Skill</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-2">
          确定删除 <span className="font-medium text-foreground">{skill.name}</span>
          （{skill.slug}）？
        </p>
        <p className="text-xs text-muted-foreground mb-4">
          {skill.isSymlink
            ? "该 skill 是符号链接，仅移除链接，原始文件保留。"
            : "将永久删除该 skill 目录及其全部内容，此操作不可恢复。"}
        </p>
        {error && (
          <p className="text-xs text-destructive mb-3 flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {skill.isSymlink ? "移除链接" : "永久删除"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SkillDetailModal({
  skill,
  onClose,
}: {
  skill: SkillEntry;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    api
      .getSkillContent(skill.path)
      .then((c) => {
        if (!cancelled) {
          setContent(stripFrontmatter(c));
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
  }, [skill.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-lg w-[52rem] max-w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Sparkles className="w-4 h-4 text-primary shrink-0" />
              <h2 className="text-sm font-semibold text-foreground truncate">
                {skill.name}
              </h2>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full ${SCOPE_BADGE_CLASS[skill.scope]}`}
              >
                {SCOPE_LABEL[skill.scope]}
              </span>
              {skill.sourceLabel && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {skill.sourceLabel}
                </span>
              )}
            </div>
            {skill.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {skill.description}
              </p>
            )}
            <button
              onClick={() => {
                navigator.clipboard.writeText(skill.path);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-foreground font-mono transition-colors max-w-full"
              title="复制路径"
            >
              <span className="truncate">{skill.path}</span>
              {copied ? (
                <Check className="w-3 h-3 text-green-500 shrink-0" />
              ) : (
                <Copy className="w-3 h-3 shrink-0" />
              )}
            </button>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-auto flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              加载中...
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 p-4 text-sm text-destructive">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          ) : content !== null ? (
            <MarkdownContent content={content} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
