import { invoke } from "@tauri-apps/api/core";
import type {
  ProjectEntry,
  SessionIndexEntry,
  PaginatedMessages,
  SearchResult,
  TokenUsageSummary,
} from "../types";

export async function getProjects(source: string): Promise<ProjectEntry[]> {
  return invoke<ProjectEntry[]>("get_projects", { source });
}

export async function getSessions(
  source: string,
  projectId: string
): Promise<SessionIndexEntry[]> {
  return invoke<SessionIndexEntry[]>("get_sessions", { source, projectId });
}

export async function getMessages(
  source: string,
  filePath: string,
  page: number = 0,
  pageSize: number = 50
): Promise<PaginatedMessages> {
  return invoke<PaginatedMessages>("get_messages", {
    source,
    filePath,
    page,
    pageSize,
  });
}

export async function globalSearch(
  source: string,
  query: string,
  maxResults: number = 50
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>("global_search", { source, query, maxResults });
}

export async function getStats(source: string): Promise<TokenUsageSummary> {
  return invoke<TokenUsageSummary>("get_stats", { source });
}

export async function deleteSession(filePath: string): Promise<void> {
  return invoke<void>("delete_session", { filePath });
}

export async function resumeSession(
  source: string,
  sessionId: string,
  projectPath: string,
  filePath?: string
): Promise<void> {
  return invoke<void>("resume_session", { source, sessionId, projectPath, filePath });
}
