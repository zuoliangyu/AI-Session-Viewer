import { useRef, useState } from "react";
import {
  X,
  Upload,
  FileArchive,
  Loader2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { api } from "../../services/api";
import type { ImportResult, SkillScope } from "../../types";

declare const __IS_TAURI__: boolean;

export function ImportSkillsDialog({
  projectPath,
  projectName,
  defaultScope,
  onClose,
  onImported,
}: {
  /** Real path of the selectable project, or null if none is selected. */
  projectPath: string | null;
  projectName: string | null;
  defaultScope: SkillScope;
  onClose: () => void;
  /** Called after a successful import so the caller can refresh its list. */
  onImported: () => void;
}) {
  const canProject = !!projectPath;
  const [scope, setScope] = useState<SkillScope>(
    defaultScope === "project" && canProject ? "project" : "global",
  );
  const [overwrite, setOverwrite] = useState(false);
  // Web: the picked File. Tauri: the picked absolute path.
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pickedName = __IS_TAURI__
    ? path
      ? path.split(/[\\/]/).pop()
      : null
    : file?.name ?? null;

  const pickTauriFile = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Zip 压缩包", extensions: ["zip"] }],
    });
    if (typeof selected === "string") {
      setPath(selected);
      setResult(null);
      setError(null);
    }
  };

  const handleImport = async () => {
    const archive: File | string | null = __IS_TAURI__ ? path : file;
    if (!archive) {
      setError("请先选择 .zip 压缩包");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.importSkills(
        archive,
        scope,
        scope === "project" ? projectPath : null,
        overwrite,
      );
      setResult(res);
      if (res.imported.length > 0) {
        onImported();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-lg w-[28rem] max-w-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">导入 Skills</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Scope */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">导入到</p>
            <div className="flex gap-2">
              <button
                onClick={() => setScope("global")}
                className={`flex-1 px-3 py-1.5 text-xs rounded-md border transition-colors ${
                  scope === "global"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                全局（~/.claude/skills）
              </button>
              <button
                onClick={() => canProject && setScope("project")}
                disabled={!canProject}
                title={canProject ? undefined : "请先选择一个项目"}
                className={`flex-1 px-3 py-1.5 text-xs rounded-md border transition-colors disabled:opacity-40 ${
                  scope === "project"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                项目{projectName ? `（${projectName}）` : ""}
              </button>
            </div>
          </div>

          {/* File picker */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">压缩包（.zip）</p>
            {__IS_TAURI__ ? (
              <button
                onClick={pickTauriFile}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs rounded-md border border-border bg-muted text-foreground hover:bg-accent/50 transition-colors"
              >
                <FileArchive className="w-4 h-4 shrink-0" />
                <span className="truncate">{pickedName || "选择 .zip 文件…"}</span>
              </button>
            ) : (
              <>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs rounded-md border border-border bg-muted text-foreground hover:bg-accent/50 transition-colors"
                >
                  <FileArchive className="w-4 h-4 shrink-0" />
                  <span className="truncate">{pickedName || "选择 .zip 文件…"}</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setResult(null);
                    setError(null);
                  }}
                />
              </>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground/70">
              支持单个 skill（含 SKILL.md）或包含多个 skill 子目录的压缩包。
            </p>
          </div>

          {/* Overwrite */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="rounded border-border"
            />
            <span className="text-xs text-foreground">覆盖同名 skill</span>
          </label>

          {/* Result / error */}
          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {result && (
            <div className="space-y-1 text-xs">
              {result.imported.length > 0 && (
                <div className="flex items-start gap-1.5 text-green-500">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>已导入：{result.imported.join("、")}</span>
                </div>
              )}
              {result.skipped.length > 0 && (
                <p className="text-muted-foreground">
                  已跳过（已存在）：{result.skipped.join("、")}
                </p>
              )}
              {result.errors.length > 0 && (
                <div className="text-destructive">
                  {result.errors.map((er, i) => (
                    <p key={i}>{er}</p>
                  ))}
                </div>
              )}
              {result.imported.length === 0 &&
                result.skipped.length === 0 &&
                result.errors.length === 0 && (
                  <p className="text-muted-foreground">未导入任何内容。</p>
                )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
          >
            {result ? "关闭" : "取消"}
          </button>
          <button
            onClick={handleImport}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            导入
          </button>
        </div>
      </div>
    </div>
  );
}
