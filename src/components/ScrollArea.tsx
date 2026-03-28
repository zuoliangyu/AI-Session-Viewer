import {
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  type UIEventHandler,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

type ScrollAreaProps = {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  onViewportScroll?: UIEventHandler<HTMLDivElement>;
} & HTMLAttributes<HTMLDivElement>;

function cn(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }

  if (typeof ref === "function") {
    ref(value);
    return;
  }

  ref.current = value;
}

export function ScrollArea({
  children,
  className,
  viewportClassName,
  contentClassName,
  viewportRef,
  onViewportScroll,
  ...props
}: ScrollAreaProps) {
  const internalViewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef({
    pointerId: -1,
    startY: 0,
    startScrollTop: 0,
  });
  const [thumb, setThumb] = useState({ size: 0, offset: 0, visible: false });
  const viewportId = useId();
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    internalViewportRef.current = node;
    assignRef(viewportRef, node);
  }, [viewportRef]);

  useEffect(() => {
    const viewport = internalViewportRef.current;
    const content = contentRef.current;

    if (!viewport || !content) {
      return;
    }

    const updateThumb = () => {
      const { clientHeight, scrollHeight, scrollTop } = viewport;
      const canScroll = scrollHeight > clientHeight + 1;

      if (!canScroll) {
        setThumb({ size: 0, offset: 0, visible: false });
        return;
      }

      const trackHeight = clientHeight;
      const nextSize = Math.max((clientHeight / scrollHeight) * trackHeight, 44);
      const maxOffset = trackHeight - nextSize;
      const maxScroll = scrollHeight - clientHeight;
      const nextOffset = maxScroll <= 0 ? 0 : (scrollTop / maxScroll) * maxOffset;

      setThumb({
        size: nextSize,
        offset: nextOffset,
        visible: true,
      });
    };

    updateThumb();
    viewport.addEventListener("scroll", updateThumb, { passive: true });

    const observer = new ResizeObserver(updateThumb);
    observer.observe(viewport);
    observer.observe(content);

    return () => {
      viewport.removeEventListener("scroll", updateThumb);
      observer.disconnect();
    };
  }, []);

  const scrollToRatio = (ratio: number) => {
    const viewport = internalViewportRef.current;

    if (!viewport) {
      return;
    }

    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    viewport.scrollTop = Math.max(0, Math.min(maxScroll, ratio * maxScroll));
  };

  const handleTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }

    const trackRect = event.currentTarget.getBoundingClientRect();
    const nextRatio = (event.clientY - trackRect.top - thumb.size / 2) / (trackRect.height - thumb.size);
    scrollToRatio(Number.isFinite(nextRatio) ? nextRatio : 0);
  };

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = internalViewportRef.current;

    if (!viewport) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: viewport.scrollTop,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = internalViewportRef.current;
    const { pointerId, startY, startScrollTop } = dragStateRef.current;

    if (!viewport || pointerId !== event.pointerId) {
      return;
    }

    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    const maxOffset = viewport.clientHeight - thumb.size;

    if (maxScroll <= 0 || maxOffset <= 0) {
      return;
    }

    const deltaY = event.clientY - startY;
    viewport.scrollTop = startScrollTop + (deltaY / maxOffset) * maxScroll;
  };

  const handleThumbPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current.pointerId = -1;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div className={cn("scroll-area-root", className)} {...props}>
      <div
        id={viewportId}
        ref={setViewportRef}
        onScroll={onViewportScroll}
        className={cn("scroll-area-viewport", viewportClassName)}
      >
        <div ref={contentRef} className={cn("scroll-area-content", contentClassName)}>
          {children}
        </div>
      </div>

      <div
        className={cn("scroll-area-track", thumb.visible ? "opacity-100" : "opacity-0")}
        onPointerDown={handleTrackPointerDown}
        aria-hidden="true"
      >
        <div
          className="scroll-area-thumb"
          style={{
            height: `${thumb.size}px`,
            transform: `translateY(${thumb.offset}px)`,
          }}
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={handleThumbPointerUp}
        />
      </div>
    </div>
  );
}
