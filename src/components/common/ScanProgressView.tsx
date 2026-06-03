import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../../services/api";
import type { ScanProgress } from "../../types";

interface ScanProgressViewProps {
  /** 后端无进度时的回退文案，例如「加载项目列表」。 */
  label: string;
}

/**
 * 加载态下显示冷启动扫描进度。轮询后端 get_scan_progress，
 * 有 total 时显示确定进度条 + X/Y，否则显示不确定进度 + 已用秒数，
 * 让用户明确知道是在扫描而不是卡死。
 */
export function ScanProgressView({ label }: ScanProgressViewProps) {
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [show, setShow] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    // 缓存命中时加载是瞬时的——延迟一点再显示，避免进度条一闪而过。
    const showTimer = setTimeout(() => setShow(true), 150);
    let cancelled = false;

    const poll = async () => {
      try {
        const p = await api.getScanProgress();
        if (!cancelled) setProgress(p);
      } catch {
        /* 轮询失败静默忽略，下个周期再试 */
      }
    };
    poll();
    const pollTimer = setInterval(poll, 250);
    const elapsedTimer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)),
      500,
    );

    return () => {
      cancelled = true;
      clearTimeout(showTimer);
      clearInterval(pollTimer);
      clearInterval(elapsedTimer);
    };
  }, []);

  if (!show) {
    return <div className="text-muted-foreground">{label}...</div>;
  }

  const total = progress?.total ?? 0;
  const scanned = progress?.scanned ?? 0;
  const determinate = total > 0 && progress?.active !== false;
  const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
  const phase = progress?.active ? progress.phase : label;

  return (
    <div className="max-w-md">
      <div className="flex items-center gap-2 text-sm text-foreground mb-2">
        <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
        <span>{phase}…</span>
        {determinate && (
          <span className="text-muted-foreground tabular-nums">
            {scanned} / {total}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{elapsed}s</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        {determinate ? (
          <div
            className="h-full bg-primary transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="h-full w-1/3 bg-primary/70 rounded-full animate-pulse" />
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        首次启动需要扫描会话缓存，请稍候…
      </p>
    </div>
  );
}
