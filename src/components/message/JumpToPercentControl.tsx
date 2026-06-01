import { useState, type KeyboardEvent } from "react";

interface Props {
  onJump: (percent: number) => void;
  disabled?: boolean;
}

const PRESETS = [0, 25, 50, 75, 100];

export function JumpToPercentControl({ onJump, disabled = false }: Props) {
  const [value, setValue] = useState("");

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    onJump(Math.max(0, Math.min(100, parsed)));
  };

  return (
    <span className="inline-flex items-center gap-1" title="跳到会话的百分比位置（只加载该位置附近的一小段）">
      <span className="text-[11px] text-muted-foreground">跳至</span>
      {PRESETS.map((p) => (
        <button
          key={p}
          type="button"
          disabled={disabled}
          onClick={() => onJump(p)}
          className="rounded border border-border/60 bg-background/50 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          {p}%
        </button>
      ))}
      <span className="inline-flex items-center rounded border border-border/60 bg-background/50 px-1 py-0.5">
        <input
          type="number"
          min={0}
          max={100}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="%"
          className="w-9 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60 disabled:opacity-60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          aria-label="跳到指定百分比"
        />
        <span className="text-[11px] text-muted-foreground">%</span>
      </span>
    </span>
  );
}
