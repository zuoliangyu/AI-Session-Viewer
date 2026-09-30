import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useCallback, useRef, useState, type PointerEvent } from "react";
import { getQuestionHue } from "./questionPalette";

export interface RailMarker {
  id: string;
  /** Position of the question as a 0–100 percentage of the whole session. */
  percent: number;
  preview: string;
  timestamp: string | null;
}

interface Props {
  /** Current reading position as a 0–100 percentage of the whole session. */
  currentPercent: number;
  onJump: (percent: number) => void;
  disabled?: boolean;
  /** User-question ticks drawn on the rail (replaces the separate timeline dots). */
  markers?: RailMarker[];
  activeMarkerId?: string | null;
  onMarkerClick?: (id: string) => void;
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/**
 * A vertical "session minimap" rail on the right edge. Clicking or dragging to
 * a height jumps to that percentage of the whole conversation. While dragging
 * we only show a live label and defer the actual jump to pointer-up, so we
 * don't thrash the loaded window on every move.
 */
export function SessionPositionRail({
  currentPercent,
  onJump,
  disabled = false,
  markers = [],
  activeMarkerId = null,
  onMarkerClick,
}: Props) {
  const { t } = useTranslation();
  const [hoveredMarker, setHoveredMarker] = useState<RailMarker | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragPercent, setDragPercent] = useState(0);

  const percentFromClientY = useCallback((clientY: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    return clampPercent(((clientY - rect.top) / rect.height) * 100);
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (disabled || e.button !== 0) return;
      e.preventDefault();
      pointerIdRef.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      setDragPercent(percentFromClientY(e.clientY));
    },
    [disabled, percentFromClientY]
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (pointerIdRef.current !== e.pointerId) return;
      setDragPercent(percentFromClientY(e.clientY));
    },
    [percentFromClientY]
  );

  const endDrag = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (pointerIdRef.current !== e.pointerId) return;
      pointerIdRef.current = null;
      const finalPercent = percentFromClientY(e.clientY);
      setDragging(false);
      onJump(finalPercent);
    },
    [onJump, percentFromClientY]
  );

  const onPointerCancel = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
  }, []);

  const displayPercent = clampPercent(dragging ? dragPercent : currentPercent);

  return (
    <div className="absolute right-1 top-24 bottom-28 z-20 flex w-3 items-stretch">
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={onPointerCancel}
        className={`group relative h-full w-2.5 cursor-pointer rounded-full border border-border/50 bg-muted/40 transition-colors hover:bg-muted/70 ${
          dragging ? "bg-muted/70" : ""
        }`}
        title={t("点击或拖动跳到会话对应位置")}
      >
        {/* Filled portion up to the current position */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 rounded-full bg-primary/15"
          style={{ height: `${displayPercent}%` }}
        />
        {/* Thumb */}
        <div
          className={`pointer-events-none absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-sm transition-transform ${
            dragging ? "scale-125" : "group-hover:scale-110"
          }`}
          style={{ top: `${displayPercent}%` }}
        />
        {/* User-question ticks, placed at their true position in the session */}
        {markers.map((marker, index) => {
          const hue = getQuestionHue(index);
          const active = marker.id === activeMarkerId;
          return (
            <button
              key={marker.id}
              type="button"
              aria-label={marker.preview}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onMarkerClick?.(marker.id);
              }}
              onMouseEnter={() => setHoveredMarker(marker)}
              onMouseLeave={() => setHoveredMarker(null)}
              onFocus={() => setHoveredMarker(marker)}
              onBlur={() => setHoveredMarker(null)}
              className={`absolute left-1/2 z-10 h-1 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full ${hue.swatch} transition-opacity ${
                active ? "opacity-100 ring-1 ring-foreground/40" : "opacity-50 hover:opacity-100"
              }`}
              style={{ top: `${clampPercent(marker.percent)}%` }}
            />
          );
        })}
        {hoveredMarker && !dragging && (
          <div
            className="pointer-events-none absolute right-full mr-3 max-w-[16rem] -translate-y-1/2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground shadow-lg"
            style={{ top: `${clampPercent(hoveredMarker.percent)}%` }}
          >
            <p className="truncate">{hoveredMarker.preview}</p>
            {hoveredMarker.timestamp && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">{hoveredMarker.timestamp}</p>
            )}
          </div>
        )}
        {/* Live percentage label while dragging */}
        {dragging && (
          <div
            className="pointer-events-none absolute right-full mr-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2 py-0.5 text-[10px] font-mono text-foreground shadow-lg"
            style={{ top: `${displayPercent}%` }}
          >
            {Math.round(displayPercent)}%
          </div>
        )}
      </div>
    </div>
  );
}
