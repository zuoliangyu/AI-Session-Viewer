import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";

interface Props {
  /** The scroll viewport element that wraps the messages. Selections outside this element are ignored. */
  scopeRef: { readonly current: HTMLElement | null };
  onReply: (text: string) => void;
  /** When true, the button is disabled (e.g. while a stream is running). */
  disabled?: boolean;
}

interface FloatingState {
  text: string;
  x: number;
  y: number;
}

const BUTTON_OFFSET_Y = 8;
const MAX_SELECTION_CHARS = 4000;

function getActiveSelectionText(): { text: string; range: Range | null } {
  if (typeof window === "undefined") return { text: "", range: null };
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return { text: "", range: null };
  }
  const range = selection.getRangeAt(0);
  const text = selection.toString();
  return { text, range };
}

function isRangeInsideElement(range: Range, element: HTMLElement): boolean {
  const container = range.commonAncestorContainer;
  return element.contains(container.nodeType === Node.TEXT_NODE ? container.parentNode : container);
}

export function SelectionReplyButton({ scopeRef, onReply, disabled }: Props) {
  const [floating, setFloating] = useState<FloatingState | null>(null);
  const pendingClickRef = useRef(false);

  const update = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope) {
      setFloating(null);
      return;
    }

    const { text, range } = getActiveSelectionText();
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized || !range) {
      setFloating(null);
      return;
    }

    if (!isRangeInsideElement(range, scope)) {
      setFloating(null);
      return;
    }

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setFloating(null);
      return;
    }

    // Position above the selection, horizontally centered on the selection,
    // then clamp to the viewport so the button doesn't overflow.
    const buttonWidth = 88;
    const buttonHeight = 32;
    const centerX = rect.left + rect.width / 2;
    const x = Math.min(
      window.innerWidth - buttonWidth - 8,
      Math.max(8, centerX - buttonWidth / 2)
    );
    let y = rect.top - buttonHeight - BUTTON_OFFSET_Y;
    if (y < 8) {
      // Not enough room above — show below the selection instead.
      y = rect.bottom + BUTTON_OFFSET_Y;
    }

    setFloating({
      text: text.length > MAX_SELECTION_CHARS ? text.slice(0, MAX_SELECTION_CHARS) : text,
      x,
      y,
    });
  }, [scopeRef]);

  useEffect(() => {
    const handleMouseUp = () => {
      // Defer: the selection is not finalized until after the mouseup event fires.
      requestAnimationFrame(update);
    };
    const handleSelectionChange = () => {
      if (pendingClickRef.current) return;
      update();
    };
    const handleScrollOrResize = () => {
      if (floating) update();
    };
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // Keep the button visible when the user clicks on it.
      if (target?.closest("[data-selection-reply-button]")) {
        pendingClickRef.current = true;
        return;
      }
      pendingClickRef.current = false;
    };

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);

    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("selectionchange", handleSelectionChange);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [floating, update]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFloating(null);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  if (!floating) return null;

  const handleClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const payload = floating.text;
    setFloating(null);
    pendingClickRef.current = false;
    // Clear the native selection after reply so the button doesn't immediately reappear.
    window.getSelection()?.removeAllRanges();
    onReply(payload);
  };

  return (
    <button
      data-selection-reply-button
      type="button"
      onMouseDown={(e) => {
        // Prevent the mousedown from clearing the text selection in some browsers.
        e.preventDefault();
      }}
      onClick={handleClick}
      disabled={disabled}
      className="fixed z-50 inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-lg transition-transform hover:-translate-y-0.5 hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-zinc-800 dark:hover:bg-zinc-700"
      style={{ left: `${floating.x}px`, top: `${floating.y}px` }}
      title={disabled ? "当前无法回复所选文本" : "以所选内容为引用开始回复"}
    >
      <span>Reply</span>
      <CornerDownLeft className="h-3.5 w-3.5" />
    </button>
  );
}
