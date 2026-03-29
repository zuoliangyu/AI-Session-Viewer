import type {
  ProjectEntry,
  SessionIndexEntry,
  PaginatedMessages,
  SearchResult,
  TokenUsageSummary,
  Bookmark,
  DeleteLevel,
  DeleteResult,
  RecycledItem,
} from "../types";
import type { CliInstallation, ModelInfo, StartChatParams, ContinueChatParams, CliConfig, QuickChatMessage } from "../types/chat";

function getToken(): string | null {
  return localStorage.getItem("asv_token");
}

function notifyAuthRequired(): void {
  window.dispatchEvent(new CustomEvent("asv-auth-required"));
}

function applyAuthHeader(headers: Record<string, string>): Record<string, string> {
  const token = getToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function probeWebSocketAuth(): Promise<void> {
  const resp = await fetch(new URL("/api/cli/detect", window.location.origin).toString(), {
    headers: applyAuthHeader({}),
  });

  if (resp.status === 401) {
    notifyAuthRequired();
    throw new Error("Authentication required");
  }

  if (!resp.ok) {
    throw new Error("WebSocket auth probe failed");
  }
}

export function buildAuthenticatedWebSocketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(path, `${protocol}//${window.location.host}`);
  const token = getToken();
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

type SseEvent = {
  event: string;
  data: string;
};

function extractJsonField<T = string>(raw: string, field: string): T | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && field in parsed) {
      return parsed[field] as T;
    }
  } catch {
    // Ignore non-JSON payloads
  }
  return null;
}

function dispatchSseEvent(
  event: SseEvent,
  onChunk: (text: string) => void,
  onError: (err: string) => void,
  onDone: () => void,
): boolean {
  const eventName = event.event || "message";
  const data = event.data;

  if (data === "[DONE]" || eventName === "done") {
    onDone();
    return true;
  }

  if (eventName === "error") {
    const errorMessage = extractJsonField<string>(data, "error") ?? data;
    onError(errorMessage || "Unknown error");
    return false;
  }

  const chunk =
    extractJsonField<string>(data, "chunk") ??
    extractJsonField<string>(data, "text") ??
    data;

  if (chunk) {
    onChunk(chunk);
  }

  return false;
}

function consumeSseBuffer(
  chunk: string,
  state: { buffer: string; eventName: string; dataLines: string[] },
  onChunk: (text: string) => void,
  onError: (err: string) => void,
  onDone: () => void,
): boolean {
  state.buffer += chunk;

  while (true) {
    const newlineIndex = state.buffer.indexOf("\n");
    if (newlineIndex < 0) break;

    const rawLine = state.buffer.slice(0, newlineIndex);
    state.buffer = state.buffer.slice(newlineIndex + 1);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line === "") {
      if (state.dataLines.length === 0 && !state.eventName) {
        continue;
      }

      const shouldStop = dispatchSseEvent(
        {
          event: state.eventName || "message",
          data: state.dataLines.join("\n"),
        },
        onChunk,
        onError,
        onDone,
      );

      state.eventName = "";
      state.dataLines = [];

      if (shouldStop) {
        return true;
      }
      continue;
    }

    if (line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    let value = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      state.eventName = value;
    } else if (field === "data") {
      state.dataLines.push(value);
    }
  }

  return false;
}

async function apiFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = applyAuthHeader({});

  const resp = await fetch(url.toString(), { headers });

  if (resp.status === 401) {
    // Trigger auth prompt
    notifyAuthRequired();
    throw new Error("Authentication required");
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || resp.statusText);
  }

  return resp.json();
}

async function apiDelete<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = applyAuthHeader({});

  const resp = await fetch(url.toString(), { method: "DELETE", headers });

  if (resp.status === 401) {
    notifyAuthRequired();
    throw new Error("Authentication required");
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || resp.statusText);
  }

  return resp.json();
}

export async function getProjects(source: string): Promise<ProjectEntry[]> {
  return apiFetch("/api/projects", { source });
}

export async function refreshProjectsCache(source: string): Promise<ProjectEntry[]> {
  return getProjects(source);
}

export async function getSessions(
  source: string,
  projectId: string
): Promise<SessionIndexEntry[]> {
  return apiFetch("/api/sessions", { source, projectId });
}

export async function refreshSessionsCache(
  source: string,
  projectId: string
): Promise<SessionIndexEntry[]> {
  return getSessions(source, projectId);
}

export async function getInvalidSessions(
  source: string,
  projectId: string
): Promise<SessionIndexEntry[]> {
  return apiFetch("/api/sessions/invalid", { source, projectId });
}

export async function getMessages(
  source: string,
  filePath: string,
  page: number = 0,
  pageSize: number = 50,
  fromEnd: boolean = false
): Promise<PaginatedMessages> {
  return apiFetch("/api/messages", {
    source,
    filePath,
    page: String(page),
    pageSize: String(pageSize),
    fromEnd: String(fromEnd),
  });
}

export async function globalSearch(
  source: string,
  query: string,
  maxResults: number = 50,
  scope: string = "all",
): Promise<SearchResult[]> {
  return apiFetch("/api/search", { source, query, maxResults: String(maxResults), scope });
}

export async function getStats(source: string): Promise<TokenUsageSummary> {
  return apiFetch("/api/stats", { source });
}

export async function deleteSession(
  filePath: string,
  source?: string,
  projectId?: string,
  sessionId?: string
): Promise<void> {
  const params: Record<string, string> = { filePath };
  if (source) params.source = source;
  if (projectId) params.projectId = projectId;
  if (sessionId) params.sessionId = sessionId;
  await apiDelete("/api/sessions", params);
}

export async function deleteProject(
  source: string,
  projectId: string,
  level: DeleteLevel = "sessionOnly"
): Promise<DeleteResult> {
  return await apiDelete<DeleteResult>("/api/projects", { source, projectId, level });
}

async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = applyAuthHeader({ "Content-Type": "application/json" });

  const resp = await fetch(new URL(path, window.location.origin).toString(), {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

  if (resp.status === 401) {
    notifyAuthRequired();
    throw new Error("Authentication required");
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || resp.statusText);
  }

  return resp.json();
}

export async function updateSessionMeta(
  source: string,
  projectId: string,
  sessionId: string,
  alias: string | null,
  tags: string[],
  filePath: string | null
): Promise<void> {
  await apiPut("/api/sessions/meta", { source, projectId, sessionId, alias, tags, filePath });
}

export async function getAllTags(
  source: string,
  projectId: string
): Promise<string[]> {
  return apiFetch("/api/tags", { source, projectId });
}

export async function getCrossProjectTags(
  source: string
): Promise<Record<string, string[]>> {
  return apiFetch("/api/cross-tags", { source });
}

export interface ForkResult {
  newSessionId: string;
  newFilePath: string;
  messageCount: number;
  firstPrompt: string | null;
}

export async function forkAndResume(
  _source: string,
  _originalFilePath: string,
  _userMsgUuid: string,
  _projectPath: string,
  _shell?: string
): Promise<ForkResult> {
  throw new Error("Fork is not available in web mode");
}

// Web mode: resume not available, use clipboard instead
export async function resumeSession(
  _source: string,
  _sessionId: string,
  _projectPath: string,
  _filePath?: string,
  _shell?: string
): Promise<void> {
  // No-op in web mode; handled by UI directly
}

export async function getInstallType(): Promise<"installed" | "portable"> {
  return "installed"; // Not applicable in web mode
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = applyAuthHeader({ "Content-Type": "application/json" });

  const resp = await fetch(new URL(path, window.location.origin).toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (resp.status === 401) {
    notifyAuthRequired();
    throw new Error("Authentication required");
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || resp.statusText);
  }

  return resp.json();
}

// Chat API
export async function detectCli(): Promise<CliInstallation[]> {
  return apiFetch("/api/cli/detect");
}

export async function getCliConfig(source: string): Promise<CliConfig> {
  return apiFetch("/api/cli/config", { source });
}

export async function startQuickChat(
  source: string,
  messages: QuickChatMessage[],
  model: string,
  onChunk: (text: string) => void,
  onError: (err: string) => void,
  onDone: () => void,
): Promise<() => void> {
  const headers: Record<string, string> = applyAuthHeader({ "Content-Type": "application/json" });

  const resp = await fetch(new URL("/api/quick-chat", window.location.origin).toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({ source, messages, model }),
  });

  if (resp.status === 401) {
    notifyAuthRequired();
    onError("Authentication required");
    onDone();
    return () => {};
  }

  if (!resp.ok) {
    const text = await resp.text();
    onError(text || resp.statusText);
    onDone();
    return () => {};
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    onError("No response body");
    onDone();
    return () => {};
  }

  let cancelled = false;
  const decoder = new TextDecoder();
  const sseState = {
    buffer: "",
    eventName: "",
    dataLines: [] as string[],
  };

  const readLoop = async () => {
    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;

        const shouldStop = consumeSseBuffer(
          decoder.decode(value, { stream: true }),
          sseState,
          onChunk,
          onError,
          onDone,
        );
        if (shouldStop) {
          return;
        }
      }

      const trailing = decoder.decode();
      if (trailing) {
        const shouldStop = consumeSseBuffer(trailing, sseState, onChunk, onError, onDone);
        if (shouldStop) {
          return;
        }
      }

      if (sseState.buffer || sseState.dataLines.length > 0 || sseState.eventName) {
        const shouldStop = consumeSseBuffer("\n", sseState, onChunk, onError, onDone);
        if (shouldStop) {
          return;
        }
      }
    } catch (e) {
      if (!cancelled) {
        onError(String(e));
      }
    }
    if (!cancelled) onDone();
  };

  readLoop();

  return () => {
    cancelled = true;
    reader.cancel().catch(() => {});
  };
}

export async function listModels(
  source: string,
  apiKey: string = "",
  baseUrl: string = ""
): Promise<ModelInfo[]> {
  return apiPost("/api/models", { source, apiKey, baseUrl });
}

// Chat WebSocket connection — managed externally by useChatStream
let chatWs: WebSocket | null = null;
let chatWsResolve: ((sessionId: string) => void) | null = null;
const chatWsSubscribers = new Set<(rawMessage: string) => void>();
let chatWsOpenPromise: Promise<WebSocket> | null = null;

function dispatchChatWsMessage(rawMessage: string): void {
  for (const subscriber of chatWsSubscribers) {
    subscriber(rawMessage);
  }
}

function attachChatWebSocketListeners(ws: WebSocket): void {
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      dispatchChatWsMessage(event.data);
    }
  });

  ws.addEventListener("close", () => {
    if (chatWs === ws) {
      chatWs = null;
      chatWsOpenPromise = null;
    }
  });

  ws.addEventListener("error", () => {
    if (chatWs === ws && ws.readyState !== WebSocket.OPEN) {
      chatWs = null;
      chatWsOpenPromise = null;
    }
  });
}

async function openChatWebSocket(): Promise<WebSocket> {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    return chatWs;
  }

  if (chatWsOpenPromise) {
    return chatWsOpenPromise;
  }

  chatWsOpenPromise = (async () => {
    await probeWebSocketAuth();

    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      return chatWs;
    }

    const ws = new WebSocket(buildAuthenticatedWebSocketUrl("/ws/chat"));
    attachChatWebSocketListeners(ws);
    chatWs = ws;

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };

      const handleError = () => {
        cleanup();
        reject(new Error("WebSocket connection failed"));
      };

      const handleClose = () => {
        cleanup();
        reject(new Error("WebSocket connection closed before opening"));
      };

      const cleanup = () => {
        ws.removeEventListener("open", handleOpen);
        ws.removeEventListener("error", handleError);
        ws.removeEventListener("close", handleClose);
      };

      ws.addEventListener("open", handleOpen, { once: true });
      ws.addEventListener("error", handleError, { once: true });
      ws.addEventListener("close", handleClose, { once: true });
    });

    return ws;
  })();

  try {
    return await chatWsOpenPromise;
  } catch (error) {
    chatWsOpenPromise = null;
    throw error;
  }
}

export function subscribeToChatWebSocketMessages(listener: (rawMessage: string) => void): () => void {
  chatWsSubscribers.add(listener);

  return () => {
    chatWsSubscribers.delete(listener);
  };
}

export async function connectFileWatcherWebSocket(): Promise<WebSocket> {
  await probeWebSocketAuth();
  return new WebSocket(buildAuthenticatedWebSocketUrl("/ws"));
}

export function closeChatWebSocket(): void {
  if (chatWs) {
    chatWs.close();
    chatWs = null;
  }
  chatWsOpenPromise = null;
}

export async function startChat(params: StartChatParams): Promise<string> {
  const ws = await openChatWebSocket();

  return new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.send(
        JSON.stringify({
          action: "start",
          source: params.source,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          projectPath: params.projectPath,
          prompt: params.prompt,
          model: params.model,
          skipPermissions: params.skipPermissions,
          apiKey: params.apiKey || "",
          baseUrl: params.baseUrl || "",
        })
      );
    };

    chatWsResolve = resolve;

    const onMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "session_id") {
          ws.removeEventListener("message", onMessage);
          if (chatWsResolve) {
            chatWsResolve(data.data);
            chatWsResolve = null;
          }
        } else if (data.type === "auth_required") {
          ws.removeEventListener("message", onMessage);
          notifyAuthRequired();
          reject(new Error("Authentication required"));
        } else if (data.type === "error") {
          ws.removeEventListener("message", onMessage);
          reject(new Error(data.data || "Chat stream error"));
        }
      } catch {
        // not JSON, ignore
      }
    };

    ws.addEventListener("message", onMessage);

    onOpen();
  });
}

export async function continueChat(params: ContinueChatParams): Promise<string> {
  const ws = await openChatWebSocket();

  return new Promise((resolve, reject) => {
    const sendMsg = () => {
      ws.send(
        JSON.stringify({
          action: "continue",
          source: params.source,
          sessionId: params.sessionId,
          projectPath: params.projectPath,
          prompt: params.prompt,
          model: params.model,
          skipPermissions: params.skipPermissions,
          apiKey: params.apiKey || "",
          baseUrl: params.baseUrl || "",
        })
      );
    };

    chatWsResolve = resolve;

    const onMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "session_id") {
          ws.removeEventListener("message", onMessage);
          if (chatWsResolve) {
            chatWsResolve(data.data);
            chatWsResolve = null;
          }
        } else if (data.type === "auth_required") {
          ws.removeEventListener("message", onMessage);
          notifyAuthRequired();
          reject(new Error("Authentication required"));
        } else if (data.type === "error") {
          ws.removeEventListener("message", onMessage);
          reject(new Error(data.data || "Chat stream error"));
        }
      } catch {
        // ignore
      }
    };

    ws.addEventListener("message", onMessage);

    sendMsg();
  });
}

export async function cancelChat(_sessionId: string): Promise<void> {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ action: "cancel" }));
  }
}

// Bookmarks API
export async function listBookmarks(source?: string): Promise<Bookmark[]> {
  const params: Record<string, string> = {};
  if (source) params.source = source;
  return apiFetch("/api/bookmarks", params);
}

export async function addBookmark(bookmark: Omit<Bookmark, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<Bookmark> {
  return apiPost("/api/bookmarks", { id: "", createdAt: "", ...bookmark });
}

export async function removeBookmark(id: string): Promise<void> {
  await apiDelete(`/api/bookmarks/${encodeURIComponent(id)}`);
}

export async function setProjectAlias(
  source: string,
  projectId: string,
  alias: string | null
): Promise<void> {
  await apiPut("/api/projects/alias", { source, projectId, alias });
}

// Recyclebin API (web mode stubs — not supported)
export async function listRecycledItems(): Promise<RecycledItem[]> {
  return [];
}

export async function restoreRecycledItem(_id: string): Promise<void> {
  throw new Error("Recyclebin is not available in web mode");
}

export async function permanentlyDeleteRecycledItem(_id: string): Promise<void> {
  throw new Error("Recyclebin is not available in web mode");
}

export async function emptyRecyclebin(): Promise<number> {
  throw new Error("Recyclebin is not available in web mode");
}

export async function cleanupOrphanDirs(_source: string): Promise<number> {
  throw new Error("Orphan dir cleanup is not available in web mode");
}
