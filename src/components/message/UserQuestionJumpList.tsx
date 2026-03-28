import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface UserQuestionItem {
  id: string;
  preview: string;
}

interface Props {
  items: UserQuestionItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: (collapsed: boolean) => void;
}

export function UserQuestionJumpList({
  items,
  activeId,
  onSelect,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dragging: boolean;
    suppressClick: boolean;
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    dragging: false,
    suppressClick: false,
  });
  const [position, setPosition] = useState({ x: 16, y: 16 });

  const stopDrag = useCallback((target?: EventTarget | null) => {
    const state = dragStateRef.current;
    if (state.pointerId !== null && target instanceof Element && target.hasPointerCapture(state.pointerId)) {
      target.releasePointerCapture(state.pointerId);
    }
    dragStateRef.current.pointerId = null;
  }, []);

  const clampPosition = useCallback((x: number, y: number) => {
    const root = rootRef.current;
    const parent = root?.parentElement;
    if (!root || !parent) return { x, y };

    const parentRect = parent.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const margin = 16;
    const maxX = Math.max(margin, parentRect.width - rootRect.width - margin);
    const maxY = Math.max(margin, parentRect.height - rootRect.height - margin);

    return {
      x: Math.min(Math.max(margin, x), maxX),
      y: Math.min(Math.max(margin, y), maxY),
    };
  }, []);

  useEffect(() => {
    const updatePosition = () => {
      setPosition((prev) => clampPosition(prev.x, prev.y));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [clampPosition, collapsed]);

  const startDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;

    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
      dragging: false,
      suppressClick: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [position.x, position.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const state = dragStateRef.current;
    if (state.pointerId !== e.pointerId) return;

    const deltaX = e.clientX - state.startX;
    const deltaY = e.clientY - state.startY;
    if (!state.dragging && Math.hypot(deltaX, deltaY) < 4) return;

    state.dragging = true;
    state.suppressClick = true;
    e.preventDefault();

    setPosition(clampPosition(state.originX + deltaX, state.originY + deltaY));
  }, [clampPosition]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (dragStateRef.current.pointerId !== e.pointerId) return;
    stopDrag(e.currentTarget);
  }, [stopDrag]);

  const handleClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragStateRef.current.suppressClick) return;
    dragStateRef.current.suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleCollapsedClick = useCallback(() => {
    if (dragStateRef.current.suppressClick) {
      dragStateRef.current.suppressClick = false;
      return;
    }
    onToggleCollapsed(false);
  }, [onToggleCollapsed]);

  const floatingStyle = useMemo(
    () => ({ left: `${position.x}px`, top: `${position.y}px` }),
    [position.x, position.y]
  );

  if (items.length === 0) return null;

  if (collapsed) {
    return (
      <div
        ref={rootRef}
        className="pointer-events-auto absolute z-20"
        style={floatingStyle}
        onClickCapture={handleClickCapture}
      >
        <button
          type="button"
          onClick={handleCollapsedClick}
          onPointerDown={startDrag}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="flex h-12 w-12 cursor-grab items-center justify-center rounded-full border border-border bg-card text-sm font-semibold text-foreground shadow-lg transition-all hover:-translate-y-0.5 hover:bg-accent active:cursor-grabbing"
          title={`提问定位（共 ${items.length} 条）`}
          aria-label={`展开提问定位，共 ${items.length} 条`}
        >
          问
        </button>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto absolute z-20 w-[min(20rem,calc(100%-2rem))]"
      style={floatingStyle}
      onClickCapture={handleClickCapture}
    >
      <div className="rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-card/85">
        <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-3">
          <div
            className="min-w-0 flex-1 cursor-grab active:cursor-grabbing"
            onPointerDown={startDrag}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <p className="text-sm font-medium text-foreground">提问定位</p>
            <p className="text-xs text-muted-foreground">只显示当前会话里的提问，点击跳转</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">
              {items.length} 条
            </span>
            <button
              type="button"
              onClick={() => onToggleCollapsed(true)}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="收起提问定位"
            >
              收起
            </button>
          </div>
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto p-2">
          {items.map((item) => {
            const isActive = item.id === activeId;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className={`flex w-full items-center rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                  isActive
                    ? "bg-primary/12 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                title={item.preview}
              >
                <span className="min-w-0 flex-1 truncate">{item.preview}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
