import { useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import { FileJson, FileText, FileCode } from "lucide-react";
import type { ExportFormat } from "../../types";
import { FORMAT_LABEL } from "../../services/exportHelpers";

interface ExportFormatMenuProps {
  anchorRect: DOMRect;
  /** 标题，默认「导出为」。 */
  title?: string;
  onPick: (format: ExportFormat) => void;
  onClose: () => void;
}

const FORMATS: { format: ExportFormat; icon: typeof FileJson }[] = [
  { format: "json", icon: FileJson },
  { format: "markdown", icon: FileText },
  { format: "html", icon: FileCode },
];

/** 选择导出格式的小浮层（portal 定位，自动翻转防溢出）。 */
export function ExportFormatMenu({
  anchorRect,
  title = "导出为",
  onPick,
  onClose,
}: ExportFormatMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const menuWidth = 160;
  const menuHeight = 150;
  let left = anchorRect.right - menuWidth;
  let top = anchorRect.bottom + 4;
  if (left < 8) left = 8;
  if (top + menuHeight > window.innerHeight - 8) {
    top = anchorRect.top - menuHeight - 4;
  }

  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 bg-card border border-border rounded-lg shadow-lg py-1"
      style={{ left, top, width: menuWidth }}
    >
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border">
        {title}
      </div>
      {FORMATS.map(({ format, icon: Icon }) => (
        <button
          key={format}
          onClick={() => {
            onPick(format);
            onClose();
          }}
          className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-accent/50 transition-colors flex items-center gap-2"
        >
          <Icon className="w-3.5 h-3.5" />
          {FORMAT_LABEL[format]}
        </button>
      ))}
    </div>,
    document.body,
  );
}
