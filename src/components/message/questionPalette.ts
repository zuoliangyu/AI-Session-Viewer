// Cycling palette to visually distinguish adjacent user questions in long
// sessions. Used by UserMessage bubbles, the TOC sidebar, and TimelineDots so
// the same question shares one color across all three surfaces.

export interface QuestionHue {
  /** Filled-bubble background tint (used by the user message body when expanded). */
  bubbleBg: string;
  /** Collapsed-preview background (more transparent than bubbleBg). */
  previewBg: string;
  /** Border color (used for the bubble's left ribbon and TOC active state). */
  border: string;
  /** Solid swatch for index badges and timeline dots. */
  swatch: string;
  /** Text color when used as accent (e.g. on muted backgrounds). */
  text: string;
}

const PALETTE: QuestionHue[] = [
  {
    bubbleBg: "bg-indigo-500/10",
    previewBg: "bg-indigo-500/5",
    border: "border-indigo-400/60 dark:border-indigo-400/50",
    swatch: "bg-indigo-500",
    text: "text-indigo-600 dark:text-indigo-300",
  },
  {
    bubbleBg: "bg-sky-500/10",
    previewBg: "bg-sky-500/5",
    border: "border-sky-400/60 dark:border-sky-400/50",
    swatch: "bg-sky-500",
    text: "text-sky-600 dark:text-sky-300",
  },
  {
    bubbleBg: "bg-emerald-500/10",
    previewBg: "bg-emerald-500/5",
    border: "border-emerald-400/60 dark:border-emerald-400/50",
    swatch: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-300",
  },
  {
    bubbleBg: "bg-amber-500/10",
    previewBg: "bg-amber-500/5",
    border: "border-amber-400/70 dark:border-amber-400/60",
    swatch: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-300",
  },
  {
    bubbleBg: "bg-rose-500/10",
    previewBg: "bg-rose-500/5",
    border: "border-rose-400/60 dark:border-rose-400/50",
    swatch: "bg-rose-500",
    text: "text-rose-600 dark:text-rose-300",
  },
  {
    bubbleBg: "bg-violet-500/10",
    previewBg: "bg-violet-500/5",
    border: "border-violet-400/60 dark:border-violet-400/50",
    swatch: "bg-violet-500",
    text: "text-violet-600 dark:text-violet-300",
  },
];

export function getQuestionHue(index: number): QuestionHue {
  if (!Number.isFinite(index) || index < 0) return PALETTE[0];
  return PALETTE[index % PALETTE.length];
}
