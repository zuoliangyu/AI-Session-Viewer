export interface Project {
  encodedName: string;
  displayPath: string;
  shortName: string;
  sessionCount: number;
  lastModified: string | null;
}

export interface SessionIndexEntry {
  sessionId: string;
  fullPath: string | null;
  fileMtime: number | null;
  firstPrompt: string | null;
  messageCount: number | null;
  created: string | null;
  modified: string | null;
  gitBranch: string | null;
  projectPath: string | null;
  isSidechain: boolean | null;
}

export type DisplayContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: string }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

export interface DisplayMessage {
  uuid: string | null;
  role: string;
  timestamp: string | null;
  content: DisplayContentBlock[];
}

export interface PaginatedMessages {
  messages: DisplayMessage[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

export interface StatsCache {
  version: number | null;
  lastComputedDate: string | null;
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
}

export interface TokenUsageSummary {
  totalTokens: number;
  tokensByModel: Record<string, number>;
  dailyTokens: { date: string; tokens: number }[];
}

export interface SearchResult {
  encodedName: string;
  projectName: string;
  sessionId: string;
  firstPrompt: string | null;
  matchedText: string;
  role: string;
  timestamp: string | null;
}
