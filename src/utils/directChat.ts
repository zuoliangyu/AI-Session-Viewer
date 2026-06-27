import type { ProjectEntry } from "../types";

/** Backend sentinel prefix for Codex Desktop "direct chat" date buckets
 *  (`<codex-direct>/YYYY-MM-DD`). Mirrors `DIRECT_PREFIX` in
 *  crates/session-core/src/provider/codex.rs. */
export const DIRECT_PREFIX = "<codex-direct>/";

/** Stable id for the synthetic top-level "Codex 直连对话" aggregate card that
 *  collapses all date buckets. Not a real backend project id — the UI routes it
 *  to the date-list page instead of the session list. */
export const DIRECT_GROUP_ID = "<codex-direct-group>";

/** Whether a project is one of the per-date direct-chat buckets. */
export function isDirectBucket(p: ProjectEntry): boolean {
  return p.id.startsWith(DIRECT_PREFIX);
}

/** The `YYYY-MM-DD` of a direct-chat bucket, or null if not one. */
export function directBucketDate(p: ProjectEntry): string | null {
  return p.id.startsWith(DIRECT_PREFIX) ? p.id.slice(DIRECT_PREFIX.length) : null;
}

/** Build the synthetic aggregate card from the direct-chat buckets, summing
 *  session counts and taking the most recent lastModified. Returns null when
 *  there are no direct buckets. */
export function buildDirectGroup(buckets: ProjectEntry[]): ProjectEntry | null {
  if (buckets.length === 0) return null;
  const sessionCount = buckets.reduce((n, b) => n + b.sessionCount, 0);
  const lastModified = buckets.reduce<string | null>((acc, b) => {
    if (!b.lastModified) return acc;
    return !acc || b.lastModified > acc ? b.lastModified : acc;
  }, null);
  return {
    source: "codex",
    id: DIRECT_GROUP_ID,
    displayPath: `Codex Desktop 直接对话（${buckets.length} 天）`,
    shortName: "Codex 直连对话",
    sessionCount,
    lastModified,
    modelProvider: null,
    alias: null,
    pathExists: true,
    isVirtual: true,
  };
}

/**
 * Collapse the per-date direct-chat buckets in `projects` into a single
 * aggregate card pinned to the front. Non-direct projects keep their relative
 * order. Returns the list unchanged when there are no direct buckets.
 */
export function collapseDirectBuckets(projects: ProjectEntry[]): ProjectEntry[] {
  const buckets = projects.filter(isDirectBucket);
  if (buckets.length === 0) return projects;
  const rest = projects.filter((p) => !isDirectBucket(p));
  const group = buildDirectGroup(buckets);
  return group ? [group, ...rest] : rest;
}
