import { invoke } from "@tauri-apps/api/core";
import type {
  ProjectEntry,
  SessionIndexEntry,
  PaginatedMessages,
  RangeMessages,
  QuestionIndexEntry,
  MessageLocation,
  Trajectory,
  SearchResult,
  TokenUsageSummary,
  RequestLogPage,
  RequestLogFilter,
  ProjectCostEntry,
  SessionCostSummary,
  Bookmark,
  DeleteLevel,
  DeleteResult,
  ExportFormat,
  ScanProgress,
  RecycledItem,
  SkillsResult,
  ImportResult,
  SkillScope,
} from "../types";
import type { CliInstallation, ModelInfo, StartChatParams, ContinueChatParams, CliConfig } from "../types/chat";
import type {
  ProviderSyncStatus,
  SyncResult,
  CloneResult,
  RepairResult,
  RestoreOptions,
  RestoreResult,
} from "../types/providerSync";
import type {
  TransferExportRequest,
  TransferImportOptions,
  TransferJob,
  TransferPreview,
  RelocatePreview,
  RelocateRequest,
} from "../types/transfer";

export async function getProjects(source: string): Promise<ProjectEntry[]> {
  return invoke<ProjectEntry[]>("get_projects", { source });
}

export async function refreshProjectsCache(source: string): Promise<ProjectEntry[]> {
  return invoke<ProjectEntry[]>("refresh_projects_cache", { source });
}

export async function rebuildProjectsCache(source: string): Promise<ProjectEntry[]> {
  return invoke<ProjectEntry[]>("rebuild_projects_cache", { source });
}

export async function getSessions(
  source: string,
  projectId: string
): Promise<SessionIndexEntry[]> {
  return invoke<SessionIndexEntry[]>("get_sessions", { source, projectId });
}

export async function refreshSessionsCache(
  source: string,
  projectId: string
): Promise<SessionIndexEntry[]> {
  return invoke<SessionIndexEntry[]>("refresh_sessions_cache", { source, projectId });
}

export async function getInvalidSessions(
  source: string,
  projectId: string
): Promise<SessionIndexEntry[]> {
  return invoke<SessionIndexEntry[]>("get_invalid_sessions", { source, projectId });
}

export async function getMessages(
  source: string,
  filePath: string,
  page: number = 0,
  pageSize: number = 50,
  fromEnd: boolean = false
): Promise<PaginatedMessages> {
  return invoke<PaginatedMessages>("get_messages", {
    source,
    filePath,
    page,
    pageSize,
    fromEnd,
  });
}

/** Load `[start, end)` slice for the windowed (progressive) message view. */
export async function getMessagesRange(
  source: string,
  filePath: string,
  start: number,
  end: number,
): Promise<RangeMessages> {
  return invoke<RangeMessages>("get_messages_range", {
    source,
    filePath,
    start,
    end,
  });
}

/** Fetch all user-question navigation entries without loading every message. */
export async function getQuestionIndex(
  source: string,
  filePath: string,
): Promise<QuestionIndexEntry[]> {
  return invoke<QuestionIndexEntry[]>("get_question_index", { source, filePath });
}

export async function getMessageLocation(
  source: string,
  filePath: string,
  messageId: string,
): Promise<MessageLocation> {
  return invoke<MessageLocation>("get_message_location", { source, filePath, messageId });
}

export async function getTrajectory(
  source: string,
  filePath: string,
  maxRecords: number = 500,
  beforeRecord?: number,
  fast: boolean = false,
): Promise<Trajectory> {
  return invoke<Trajectory>("get_trajectory", {
    source,
    filePath,
    maxRecords,
    beforeRecord,
    fast,
  });
}

export async function globalSearch(
  source: string,
  query: string,
  maxResults: number = 50,
  scope: string = "all",
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>("global_search", { source, query, maxResults, scope });
}

export async function getStats(source: string, timeZone: string): Promise<TokenUsageSummary> {
  return invoke<TokenUsageSummary>("get_stats", { source, timeZone });
}

export async function getRequestLog(
  source: string,
  filter: RequestLogFilter = {},
): Promise<RequestLogPage> {
  return invoke<RequestLogPage>("get_request_log", {
    source,
    projectId: filter.projectId ?? null,
    sessionId: filter.sessionId ?? null,
    startDate: filter.startDate ?? null,
    endDate: filter.endDate ?? null,
    model: filter.model ?? null,
    page: filter.page ?? 0,
    pageSize: filter.pageSize ?? 200,
    timeZone: filter.timeZone ?? null,
  });
}

export async function getProjectCosts(source: string): Promise<ProjectCostEntry[]> {
  return invoke<ProjectCostEntry[]>("get_project_costs", { source });
}

export async function getSessionCost(
  source: string,
  filePath: string,
): Promise<SessionCostSummary> {
  return invoke<SessionCostSummary>("get_session_cost", { source, filePath });
}

export async function deleteSession(
  filePath: string,
  source?: string,
  projectId?: string,
  sessionId?: string
): Promise<void> {
  return invoke<void>("delete_session", {
    filePath,
    source: source || "",
    projectId: projectId || "",
    sessionId: sessionId || "",
  });
}

export async function deleteProject(
  source: string,
  projectId: string,
  level: DeleteLevel = "sessionOnly"
): Promise<DeleteResult> {
  return invoke<DeleteResult>("delete_project", { source, projectId, level });
}

export async function exportSession(
  source: string,
  filePath: string,
  format: ExportFormat
): Promise<string> {
  return invoke<string>("export_session", { source, filePath, format });
}

export async function writeExportFile(
  path: string,
  content: string
): Promise<void> {
  return invoke<void>("write_export_file", { path, content });
}

export async function getScanProgress(): Promise<ScanProgress> {
  return invoke<ScanProgress>("get_scan_progress");
}

// Session archive transfer. In Tauri an archive "handle" is its local path.
export async function startTransferExport(
  request: TransferExportRequest,
  outputPath: string | null,
): Promise<string> {
  if (!outputPath) throw new Error("outputPath is required in desktop mode");
  return invoke<string>("transfer_start_export", { request, outputPath });
}

export async function getTransferJob(jobId: string): Promise<TransferJob> {
  return invoke<TransferJob>("transfer_job_status", { jobId });
}

export async function cancelTransferJob(jobId: string): Promise<void> {
  return invoke<void>("transfer_cancel", { jobId });
}

export async function downloadTransferExport(_jobId: string, _fileName: string): Promise<void> {
  throw new Error("downloadTransferExport is not supported in desktop mode");
}

export async function prepareTransferArchive(
  archive: File | string,
  _onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
  if (typeof archive !== "string") throw new Error("Desktop import requires a file path");
  return archive;
}

export async function discardTransferArchive(_handle: string): Promise<void> {}

export async function inspectTransferArchive(handle: string): Promise<TransferPreview> {
  return invoke<TransferPreview>("transfer_inspect", { archivePath: handle });
}

export async function startTransferImport(
  handle: string,
  options: TransferImportOptions,
): Promise<string> {
  return invoke<string>("transfer_start_import", { archivePath: handle, options });
}

export async function previewProjectRelocate(request: RelocateRequest): Promise<RelocatePreview> {
  return invoke<RelocatePreview>("transfer_relocate_preview", { request });
}

export async function startProjectRelocate(request: RelocateRequest): Promise<string> {
  return invoke<string>("transfer_start_relocate", { request });
}

// Skills API
export async function listSkills(projectPath?: string | null): Promise<SkillsResult> {
  return invoke<SkillsResult>("list_skills", { projectPath: projectPath ?? null });
}

export async function getSkillContent(path: string): Promise<string> {
  return invoke<string>("get_skill_content", { path });
}

export async function deleteSkill(
  scope: SkillScope,
  projectPath: string | null,
  slug: string,
): Promise<void> {
  return invoke<void>("delete_skill", { scope, projectPath: projectPath ?? null, slug });
}

/** In Tauri mode `archive` is the absolute path to the .zip on disk. */
export async function importSkills(
  archive: File | string,
  scope: SkillScope,
  projectPath: string | null,
  overwrite: boolean,
): Promise<ImportResult> {
  const archivePath = typeof archive === "string" ? archive : "";
  return invoke<ImportResult>("import_skills", {
    archivePath,
    scope,
    projectPath: projectPath ?? null,
    overwrite,
  });
}

export async function updateSessionMeta(
  source: string,
  projectId: string,
  sessionId: string,
  alias: string | null,
  tags: string[],
  filePath: string | null
): Promise<void> {
  return invoke<void>("update_session_meta", {
    source,
    projectId,
    sessionId,
    alias,
    tags,
    filePath,
  });
}

export async function renameChatSession(
  source: string,
  projectPath: string,
  sessionId: string,
  alias: string | null
): Promise<void> {
  return invoke<void>("rename_chat_session", {
    source,
    projectPath,
    sessionId,
    alias,
  });
}

export async function getAllTags(
  source: string,
  projectId: string
): Promise<string[]> {
  return invoke<string[]>("get_all_tags", { source, projectId });
}

export async function getCrossProjectTags(
  source: string
): Promise<Record<string, string[]>> {
  return invoke<Record<string, string[]>>("get_cross_project_tags", { source });
}

export async function resumeSession(
  source: string,
  sessionId: string,
  projectPath: string,
  filePath?: string,
  shell?: string
): Promise<void> {
  return invoke<void>("resume_session", { source, sessionId, projectPath, filePath, shell });
}

export interface ForkResult {
  newSessionId: string;
  newFilePath: string;
  projectPath: string;
  projectId: string;
}

export async function forkSession(
  source: string,
  originalFilePath: string,
  userMsgUuid: string,
): Promise<ForkResult> {
  return invoke<ForkResult>("fork_session", {
    source,
    originalFilePath,
    userMsgUuid,
  });
}

export async function getInstallType(): Promise<"installed" | "portable"> {
  return invoke<"installed" | "portable">("get_install_type");
}

// Chat API
export async function detectCli(): Promise<CliInstallation[]> {
  return invoke<CliInstallation[]>("detect_cli");
}

export async function getCliConfig(source: string): Promise<CliConfig> {
  return invoke<CliConfig>("get_cli_config", { source });
}

export async function listModels(
  source: string,
  apiKey: string = "",
  baseUrl: string = ""
): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models", { source, apiKey, baseUrl });
}

export async function startChat(params: StartChatParams): Promise<string> {
  return invoke<string>("start_chat", {
    source: params.source,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    projectPath: params.projectPath,
    prompt: params.prompt,
    model: params.model,
    skipPermissions: params.skipPermissions,
    cliPath: params.cliPath || "",
    apiKey: params.apiKey || "",
    baseUrl: params.baseUrl || "",
  });
}

export async function continueChat(params: ContinueChatParams): Promise<string> {
  return invoke<string>("continue_chat", {
    source: params.source,
    sessionId: params.sessionId,
    projectPath: params.projectPath,
    prompt: params.prompt,
    model: params.model,
    skipPermissions: params.skipPermissions,
    cliPath: params.cliPath || "",
    apiKey: params.apiKey || "",
    baseUrl: params.baseUrl || "",
  });
}

export async function cancelChat(sessionId: string): Promise<void> {
  return invoke<void>("cancel_chat", { sessionId });
}

// Bookmarks API
export async function listBookmarks(source?: string): Promise<Bookmark[]> {
  return invoke<Bookmark[]>("list_bookmarks", { source: source || null });
}

export async function addBookmark(bookmark: Omit<Bookmark, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<Bookmark> {
  return invoke<Bookmark>("add_bookmark", {
    bookmark: { id: bookmark.id || "", createdAt: bookmark.createdAt || "", ...bookmark },
  });
}

export async function removeBookmark(id: string): Promise<void> {
  return invoke<void>("remove_bookmark", { id });
}

export async function setProjectAlias(
  source: string,
  projectId: string,
  alias: string | null
): Promise<void> {
  return invoke<void>("set_project_alias", { source, projectId, alias });
}

// Recyclebin API
export async function listRecycledItems(): Promise<RecycledItem[]> {
  return invoke<RecycledItem[]>("list_recycled_items");
}

export async function restoreRecycledItem(id: string): Promise<void> {
  return invoke<void>("restore_recycled_item", { id });
}

export async function permanentlyDeleteRecycledItem(id: string): Promise<void> {
  return invoke<void>("permanently_delete_recycled_item", { id });
}

export async function emptyRecyclebin(): Promise<number> {
  return invoke<number>("empty_recyclebin");
}

export async function cleanupOrphanDirs(source: string): Promise<number> {
  return invoke<number>("cleanup_orphan_dirs", { source });
}

// Provider Sync API
export async function providerSyncStatus(): Promise<ProviderSyncStatus> {
  return invoke<ProviderSyncStatus>("provider_sync_status");
}

export async function providerSyncRun(
  provider: string | null,
  keep: number = 5,
): Promise<SyncResult> {
  return invoke<SyncResult>("provider_sync_run", { provider, keep });
}

export async function providerSyncSwitch(
  provider: string,
  keep: number = 5,
): Promise<SyncResult> {
  return invoke<SyncResult>("provider_sync_switch", { provider, keep });
}

export async function providerSyncClone(
  filePaths: string[],
  provider: string,
  keep: number = 5,
): Promise<CloneResult> {
  return invoke<CloneResult>("provider_sync_clone", { filePaths, provider, keep });
}

export async function providerSyncRepair(
  providers: string[],
  template: string | null,
  keep: number = 5,
): Promise<RepairResult> {
  return invoke<RepairResult>("provider_sync_repair", { providers, template, keep });
}

export async function providerSyncRestore(
  backupDir: string,
  options?: RestoreOptions,
): Promise<RestoreResult> {
  return invoke<RestoreResult>("provider_sync_restore", { backupDir, options });
}

export async function providerSyncPrune(keep: number = 5): Promise<number> {
  return invoke<number>("provider_sync_prune", { keep });
}
