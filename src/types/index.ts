export interface ProjectEntry {
  source: string;
  id: string;
  displayPath: string;
  shortName: string;
  sessionCount: number;
  lastModified: string | null;
  modelProvider: string | null;
  alias: string | null;
  pathExists: boolean;
}

/** Scan-time health classification of a session file.
 *  - `valid`   — has messages and JSONL parsed cleanly.
 *  - `empty`   — file exists but has no user/assistant messages.
 *  - `corrupt` — has messages but a non-last line failed to parse
 *               (typically mid-file NUL bytes from a crashed CC writer). */
export type SessionStatus = "valid" | "empty" | "corrupt";

export interface SessionIndexEntry {
  source: string;
  sessionId: string;
  filePath: string;
  firstPrompt: string | null;
  messageCount: number;
  created: string | null;
  modified: string | null;
  gitBranch: string | null;
  projectPath: string | null;
  // Claude-specific
  isSidechain: boolean | null;
  // Codex-specific
  cwd: string | null;
  modelProvider: string | null;
  cliVersion: string | null;
  // User metadata
  alias: string | null;
  tags: string[] | null;
  /** Optional for backward compat with older API responses. Treat
   *  missing value as `"valid"` for main-list rows and `"empty"` for
   *  rows returned by `getInvalidSessions`. */
  status?: SessionStatus;
}

export type DisplayContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: string }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { type: "reasoning"; text: string }
  | { type: "function_call"; name: string; arguments: string; callId: string }
  | { type: "function_call_output"; callId: string; output: string };

export interface DisplayMessage {
  uuid: string | null;
  parentUuid: string | null;
  role: string;
  timestamp: string | null;
  model: string | null;
  content: DisplayContentBlock[];
}

export interface PaginatedMessages {
  messages: DisplayMessage[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Result of a range-based message load `[start, end)`. */
export interface RangeMessages {
  messages: DisplayMessage[];
  total: number;
  start: number;
  end: number;
}

export interface TokenUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  tokensByModel: Record<string, number>;
  costByModel: Record<string, number>;
  dailyTokens: DailyTokenEntry[];
  sessionCount: number;
  messageCount: number;
  isFirstBuild: boolean;
}

export interface DailyTokenEntry {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  messageCount: number;
  /** Per-model cache hit ratio for this day. */
  cacheHitRatioByModel: Record<string, number>;
}

/** Single assistant request as recorded in a JSONL file. */
export interface RequestRecord {
  timestamp: string;
  source: string;
  projectId: string;
  sessionId: string;
  filePath: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Milliseconds between the preceding user message and this assistant message. */
  durationMs: number | null;
  messageUuid: string | null;
}

export interface RequestLogPage {
  records: RequestRecord[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export interface ProjectCostEntry {
  source: string;
  projectId: string;
  displayName: string;
  requestCount: number;
  totalTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface SessionCostSummary {
  source: string;
  sessionId: string;
  filePath: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  avgCostUsd: number | null;
  requests: RequestRecord[];
}

export interface RequestLogFilter {
  projectId?: string | null;
  sessionId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  model?: string | null;
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  source: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  firstPrompt: string | null;
  alias: string | null;
  tags: string[] | null;
  matchedText: string;
  role: string;
  timestamp: string | null;
  filePath: string;
  totalMessageCount: number;
  matchedMessageId: string | null;
}

export interface Bookmark {
  id: string;
  source: string;
  projectId: string;
  sessionId: string;
  filePath: string;
  messageId: string | null;
  preview: string;
  sessionTitle: string;
  projectName: string;
  createdAt: string;
}

export type DeleteLevel = "sessionOnly" | "withCcConfig";

export interface DeleteResult {
  sessionsDeleted: number;
  configCleaned: boolean;
  bookmarksRemoved: number;
}

export interface RecycledItem {
  id: string;
  itemType: string;
  reason: string;
  source: string;
  projectId: string;
  sessionTitle: string | null;
  projectName: string | null;
  originalPath: string;
  storedName: string;
  movedAt: string;
}
