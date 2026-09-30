import { ClaudeMark, CodexMark, GrokMark, OmpMark } from "./ProviderMarks";

export type SessionSource = "claude" | "codex" | "grok" | "omp";

export const SOURCE_OPTIONS = [
  {
    id: "claude",
    label: "Claude",
    icon: ClaudeMark,
    iconClass: "text-[#D97757]",
  },
  {
    id: "codex",
    label: "Codex",
    icon: CodexMark,
    iconClass: "text-foreground",
  },
  {
    id: "grok",
    label: "Grok",
    icon: GrokMark,
    iconClass: "text-foreground",
  },
  {
    id: "omp",
    label: "Oh My Pi",
    icon: OmpMark,
    iconClass: "text-foreground",
  },
] as const;

const HIDDEN_SOURCES_KEY = "hiddenSessionSources";
/** Fired on `window` when the hidden-source preference changes, so the sidebar
 *  and the settings page stay in sync without sharing component state. */
export const HIDDEN_SOURCES_CHANGED = "asv:hidden-sources-changed";

export function readHiddenSources(): SessionSource[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(HIDDEN_SOURCES_KEY) || "[]");
    const hidden = SOURCE_OPTIONS.filter((option) => Array.isArray(stored) && stored.includes(option.id)).map(
      (option) => option.id,
    );
    return hidden.length < SOURCE_OPTIONS.length ? hidden : [];
  } catch {
    return [];
  }
}

/** Persist the hidden sources. At least one source must stay visible. */
export function writeHiddenSources(next: SessionSource[]): boolean {
  if (next.length >= SOURCE_OPTIONS.length) return false;
  try {
    localStorage.setItem(HIDDEN_SOURCES_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: still notify so the current window updates
  }
  window.dispatchEvent(new Event(HIDDEN_SOURCES_CHANGED));
  return true;
}
