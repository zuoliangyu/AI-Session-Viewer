import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { FolderOpen, ChevronDown } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { isRemoteNodeActive } from "../../services/nodeConfig";

declare const __IS_TAURI__: boolean;

interface Props {
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}

export function FolderSelector({ value, onChange, disabled }: Props) {
  const { t } = useTranslation();
  const usesLocalTauri = __IS_TAURI__ && !isRemoteNodeActive();
  const [showDropdown, setShowDropdown] = useState(false);
  const projects = useAppStore((s) => s.projects);

  const handleBrowse = async () => {
    if (usesLocalTauri) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ directory: true, multiple: false });
        if (selected) {
          onChange(selected as string);
        }
      } catch {
        // dialog plugin not available, fallback to manual input
      }
    }
  };

  const projectPaths = projects
    .map((p) => p.displayPath)
    .filter((p): p is string => !!p);

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("选择或输入工作目录...")}
            disabled={disabled}
            className="w-full bg-muted border border-border rounded-lg pl-3 pr-8 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
          {projectPaths.length > 0 && (
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              disabled={disabled}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          )}
        </div>
        {usesLocalTauri && (
          <button
            onClick={handleBrowse}
            disabled={disabled}
            className="shrink-0 p-2 rounded-lg border border-border bg-muted hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            title={t("浏览文件夹")}
          >
            <FolderOpen className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Dropdown with existing project paths */}
      {showDropdown && projectPaths.length > 0 && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setShowDropdown(false)}
          />
          <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {projectPaths.map((path) => (
              <button
                key={path}
                onClick={() => {
                  onChange(path);
                  setShowDropdown(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent transition-colors"
              >
                <FolderOpen className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{path}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
