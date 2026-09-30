import { api } from "./api";
import type { ProjectEntry } from "../types";

export interface SessionLocation {
  projectId: string;
  filePath: string;
}

/** Recently active projects scanned when the session's project is unknown. */
const MAX_SCANNED_PROJECTS = 30;
const RETRY_DELAYS_MS = [0, 800, 2000];

function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(unified) ? unified.toLowerCase() : unified;
}

function orderCandidates(projects: ProjectEntry[], projectPath?: string): ProjectEntry[] {
  const byRecent = [...projects].sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
  if (!projectPath) return byRecent.slice(0, MAX_SCANNED_PROJECTS);
  const target = normalizePath(projectPath);
  const exact = byRecent.filter((project) => normalizePath(project.displayPath) === target);
  // Fall back to recent projects: Codex direct chats and renamed/moved
  // directories don't map 1:1 from cwd to a project entry.
  const rest = byRecent.filter((project) => !exact.includes(project)).slice(0, MAX_SCANNED_PROJECTS);
  return [...exact, ...rest];
}

async function findOnce(
  source: string,
  sessionId: string,
  projectPath: string | undefined,
  refresh: boolean,
): Promise<SessionLocation | null> {
  const projects = refresh ? await api.refreshProjectsCache(source) : await api.getProjects(source);
  for (const project of orderCandidates(projects, projectPath)) {
    const sessions = refresh
      ? await api.refreshSessionsCache(source, project.id)
      : await api.getSessions(source, project.id);
    const match = sessions.find((session) => session.sessionId === sessionId);
    if (match) return { projectId: project.id, filePath: match.filePath };
  }
  return null;
}

/**
 * Find the on-disk session for `sessionId` so a chat can be reopened in the
 * unified session page. A just-finished turn may not be indexed yet, so later
 * attempts force a cache refresh after a short delay.
 */
export async function locateSession(
  source: string,
  sessionId: string,
  projectPath?: string,
): Promise<SessionLocation | null> {
  for (const [attempt, delay] of RETRY_DELAYS_MS.entries()) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const found = await findOnce(source, sessionId, projectPath, attempt > 0);
      if (found) return found;
    } catch {
      // try again with a refreshed index
    }
  }
  return null;
}

export function sessionPagePath(location: SessionLocation): string {
  return `/projects/${encodeURIComponent(location.projectId)}/session/${encodeURIComponent(location.filePath)}`;
}
