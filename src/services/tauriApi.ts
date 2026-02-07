import { invoke } from "@tauri-apps/api/core";
import type {
  Project,
  SessionIndexEntry,
  PaginatedMessages,
  SearchResult,
  StatsCache,
  TokenUsageSummary,
} from "../types";

export async function getProjects(): Promise<Project[]> {
  return invoke<Project[]>("get_projects");
}

export async function getSessions(
  encodedName: string
): Promise<SessionIndexEntry[]> {
  return invoke<SessionIndexEntry[]>("get_sessions", { encodedName });
}

export async function getMessages(
  encodedName: string,
  sessionId: string,
  page: number = 0,
  pageSize: number = 50
): Promise<PaginatedMessages> {
  return invoke<PaginatedMessages>("get_messages", {
    encodedName,
    sessionId,
    page,
    pageSize,
  });
}

export async function globalSearch(
  query: string,
  maxResults: number = 50
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>("global_search", { query, maxResults });
}

export async function getGlobalStats(): Promise<StatsCache> {
  return invoke<StatsCache>("get_global_stats");
}

export async function getTokenSummary(): Promise<TokenUsageSummary> {
  return invoke<TokenUsageSummary>("get_token_summary");
}

export async function resumeSession(
  sessionId: string,
  projectPath: string
): Promise<void> {
  return invoke<void>("resume_session", { sessionId, projectPath });
}
