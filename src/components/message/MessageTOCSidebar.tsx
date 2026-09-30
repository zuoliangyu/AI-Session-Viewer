import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useRef } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";


interface TOCItem {
  id: string;
  preview: string;
  timestamp: string | null;
}

interface Props {
  items: TOCItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: (collapsed: boolean) => void;
}

export function MessageTOCSidebar({
  items,
  activeId,
  onSelect,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the active question into view within the TOC viewport when it changes.
  useEffect(() => {
    if (collapsed || !activeId || !listRef.current) return;
    const target = listRef.current.querySelector(`[data-toc-id="${activeId}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeId, collapsed]);

  if (items.length === 0) return null;

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center rounded-lg border border-border bg-card py-2">
        <button
          type="button"
          onClick={() => onToggleCollapsed(false)}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t("展开提问目录（共 {{v0}} 条）", { v0: items.length })}
          aria-label={t("展开提问目录")}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <span className="mt-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {items.length}
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{t("提问目录")}</p>
          <p className="text-[11px] text-muted-foreground">{t("共")}{items.length} {t("条提问")}</p>
        </div>
        <button
          type="button"
          onClick={() => onToggleCollapsed(true)}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t("折叠提问目录")}
          aria-label={t("折叠提问目录")}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto px-1.5 py-2">
        {items.map((item, index) => {
          const isActive = item.id === activeId;

          return (
            <button
              key={item.id}
              type="button"
              data-toc-id={item.id}
              onClick={() => onSelect(item.id)}
              title={item.preview}
              className={`mb-1 flex w-full items-start gap-2 rounded-md border-l-[3px] px-2 py-1.5 text-left text-sm transition-colors border-transparent ${
                isActive
                  ? "bg-accent/60 text-foreground border-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <span
                className={`mt-0.5 inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full px-1 font-mono text-[10px] text-white bg-muted-foreground/60`}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 break-words leading-snug">
                  {item.preview}
                </span>
                {item.timestamp && (
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {item.timestamp}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
