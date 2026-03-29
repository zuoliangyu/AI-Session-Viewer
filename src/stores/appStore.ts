import { create } from "zustand";
import type {
  ProjectEntry,
  SessionIndexEntry,
  DisplayMessage,
  TokenUsageSummary,
  SearchResult,
  Bookmark,
  DeleteLevel,
  RecycledItem,
} from "../types";
import { api } from "../services/api";

const MAIN_MESSAGES_PAGE_SIZE = 100;

interface AppState {
  // Source
  source: "claude" | "codex";
  setSource: (s: "claude" | "codex") => void;

  // Display settings
  showTimestamp: boolean;
  showModel: boolean;
  toggleTimestamp: () => void;
  toggleModel: () => void;

  // Terminal shell (Windows only)
  terminalShell: "cmd" | "powershell";
  setTerminalShell: (shell: "cmd" | "powershell") => void;

  // Projects
  projects: ProjectEntry[];
  projectsLoading: boolean;
  selectedProject: string | null;

  // Sessions
  sessions: SessionIndexEntry[];
  sessionsLoading: boolean;
  selectedFilePath: string | null;

  // Messages
  messages: DisplayMessage[];
  messagesLoading: boolean;
  messagesTotal: number;
  messagesPage: number;
  messagesHasMore: boolean;

  // Search
  searchQuery: string;
  searchScope: "all" | "content" | "session";
  searchResults: SearchResult[];
  searchLoading: boolean;

  // Stats
  tokenSummary: TokenUsageSummary | null;
  statsLoading: boolean;
  /** null = unknown (loading), true = first-time full scan, false = cache hit */
  statsIsFirstBuild: boolean | null;

  // Tags
  allTags: string[];
  tagFilter: string[];

  // Cross-project tags
  crossProjectTags: Record<string, string[]>;
  globalTagFilter: string[];

  // Bookmarks
  bookmarks: Bookmark[];
  bookmarksLoading: boolean;

  // Recyclebin
  recycledItems: RecycledItem[];
  recyclebinLoading: boolean;

  // Actions
  loadProjects: () => Promise<void>;
  selectProject: (projectId: string) => Promise<void>;
  selectSession: (filePath: string) => Promise<void>;
  deleteSession: (filePath: string, sessionId?: string) => Promise<void>;
  deleteProject: (projectId: string, level?: DeleteLevel) => Promise<void>;
  setProjectAlias: (projectId: string, alias: string | null) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  search: (query: string) => Promise<void>;
  setSearchScope: (scope: "all" | "content" | "session") => void;
  loadStats: () => Promise<void>;
  clearSelection: () => void;
  /** Silently refresh projects and current session list without loading states */
  refreshInBackground: (forceReload?: boolean) => Promise<void>;
  updateSessionMeta: (
    sessionId: string,
    alias: string | null,
    tags: string[]
  ) => Promise<void>;
  loadAllTags: () => Promise<void>;
  setTagFilter: (tags: string[]) => void;
  loadCrossProjectTags: () => Promise<void>;
  setGlobalTagFilter: (tags: string[]) => void;
  loadBookmarks: () => Promise<void>;
  addBookmark: (bookmark: Omit<Bookmark, "id" | "createdAt">) => Promise<void>;
  removeBookmark: (id: string) => Promise<void>;
  isBookmarked: (sessionId: string, messageId?: string | null) => boolean;

  loadRecycledItems: () => Promise<void>;
  restoreItem: (id: string) => Promise<void>;
  permanentlyDeleteItem: (id: string) => Promise<void>;
  emptyRecyclebin: () => Promise<void>;
  cleanupOrphanDirs: () => Promise<number>;
}

export const useAppStore = create<AppState>((set, get) => ({
  source: "claude",
  setSource: (s) => {
    set({
      source: s,
      projects: [],
      projectsLoading: false,
      sessions: [],
      sessionsLoading: false,
      messages: [],
      messagesLoading: false,
      selectedProject: null,
      selectedFilePath: null,
      searchResults: [],
      searchQuery: "",
      searchScope: "all",
      searchLoading: false,
      tokenSummary: null,
      statsLoading: false,
      statsIsFirstBuild: null,
      allTags: [],
      tagFilter: [],
      crossProjectTags: {},
      globalTagFilter: [],
    });
  },

  showTimestamp: localStorage.getItem("showTimestamp") !== "false",
  showModel: localStorage.getItem("showModel") !== "false",
  toggleTimestamp: () => {
    const next = !get().showTimestamp;
    localStorage.setItem("showTimestamp", String(next));
    set({ showTimestamp: next });
  },
  toggleModel: () => {
    const next = !get().showModel;
    localStorage.setItem("showModel", String(next));
    set({ showModel: next });
  },

  terminalShell: (localStorage.getItem("terminalShell") === "powershell" ? "powershell" : "cmd") as "cmd" | "powershell",
  setTerminalShell: (shell) => {
    localStorage.setItem("terminalShell", shell);
    set({ terminalShell: shell });
  },

  projects: [],
  projectsLoading: false,
  selectedProject: null,

  sessions: [],
  sessionsLoading: false,
  selectedFilePath: null,

  messages: [],
  messagesLoading: false,
  messagesTotal: 0,
  messagesPage: 0,
  messagesHasMore: false,

  searchQuery: "",
  searchScope: "all",
  searchResults: [],
  searchLoading: false,

  tokenSummary: null,
  statsLoading: false,
  statsIsFirstBuild: null,

  allTags: [],
  tagFilter: [],

  crossProjectTags: {},
  globalTagFilter: [],

  bookmarks: [],
  bookmarksLoading: false,

  recycledItems: [],
  recyclebinLoading: false,

  loadProjects: async () => {
    const requestSource = get().source;
    set({ projectsLoading: true });
    try {
      const projects = await api.getProjects(requestSource);
      if (get().source !== requestSource) return;
      set({ projects, projectsLoading: false });
    } catch (e) {
      console.error("Failed to load projects:", e);
      if (get().source === requestSource) {
        set({ projectsLoading: false });
      }
    }
  },

  selectProject: async (projectId: string) => {
    const requestSource = get().source;
    set({
      selectedProject: projectId,
      sessions: [],
      sessionsLoading: true,
      selectedFilePath: null,
      messages: [],
      messagesTotal: 0,
      messagesPage: 0,
      tagFilter: [],
    });
    try {
      const sessions = await api.getSessions(requestSource, projectId);
      // Stale check: ignore result if user already navigated to another project
      if (
        get().source !== requestSource ||
        get().selectedProject !== projectId
      ) {
        return;
      }
      set((state) => ({
        sessions,
        sessionsLoading: false,
        projects: state.projects.map((p) =>
          p.id === projectId ? { ...p, sessionCount: sessions.length } : p
        ),
      }));
      // Load all tags for this project
      if (get().selectedProject === projectId) {
        get().loadAllTags();
      }
    } catch (e) {
      console.error("Failed to load sessions:", e);
      if (
        get().source === requestSource &&
        get().selectedProject === projectId
      ) {
        set({ sessions: [], sessionsLoading: false });
      }
    }
  },

  selectSession: async (filePath: string) => {
    const requestSource = get().source;
    set({
      selectedFilePath: filePath,
      messagesLoading: true,
      messages: [],
      messagesTotal: 0,
      messagesPage: 0,
    });
    try {
      const result = await api.getMessages(requestSource, filePath, 0, MAIN_MESSAGES_PAGE_SIZE, true);
      if (
        get().source !== requestSource ||
        get().selectedFilePath !== filePath
      ) {
        return;
      }
      set({
        messages: result.messages,
        messagesTotal: result.total,
        messagesPage: 0,
        messagesHasMore: result.hasMore,
        messagesLoading: false,
      });
    } catch (e) {
      console.error("Failed to load messages:", e);
      if (
        get().source === requestSource &&
        get().selectedFilePath === filePath
      ) {
        set({ messagesLoading: false });
      }
    }
  },

  deleteSession: async (filePath: string, sessionId?: string) => {
    const { source, selectedProject } = get();
    await api.deleteSession(filePath, source, selectedProject || undefined, sessionId);
    set((state) => ({
      sessions: state.sessions.filter((s) => s.filePath !== filePath),
    }));
  },

  deleteProject: async (projectId: string, level?: DeleteLevel) => {
    const { source } = get();
    await api.deleteProject(source, projectId, level || "sessionOnly");
    // 在 await 完成后重新读取 selectedProject，避免竞态
    set((state) => {
      const filtered = state.projects.filter((p) => p.id !== projectId);
      if (state.selectedProject === projectId) {
        return {
          projects: filtered,
          selectedProject: null,
          selectedFilePath: null,
          sessions: [],
          messages: [],
          messagesTotal: 0,
          messagesPage: 0,
          messagesHasMore: false,
        };
      }
      return { projects: filtered };
    });
  },

  setProjectAlias: async (projectId: string, alias: string | null) => {
    const { source, projects } = get();
    const prev = projects;
    // 乐观更新
    set({ projects: projects.map(p =>
      p.id === projectId ? { ...p, alias } : p
    )});
    try {
      await api.setProjectAlias(source, projectId, alias);
    } catch (e) {
      set({ projects: prev }); // 回滚
      throw e;
    }
  },

  loadMoreMessages: async () => {
    const state = get();
    if (
      !state.selectedFilePath ||
      !state.messagesHasMore ||
      state.messagesLoading
    ) {
      return;
    }

    const nextPage = state.messagesPage + 1;
    set({ messagesLoading: true });
    try {
      const result = await api.getMessages(
        state.source,
        state.selectedFilePath,
        nextPage,
        MAIN_MESSAGES_PAGE_SIZE,
        true
      );
      set({
        messages: [...result.messages, ...state.messages],
        messagesPage: nextPage,
        messagesHasMore: result.hasMore,
        messagesLoading: false,
      });
    } catch (e) {
      console.error("Failed to load more messages:", e);
      set({ messagesLoading: false });
    }
  },

  search: async (query: string) => {
    const scope = get().searchScope;
    set({ searchQuery: query, searchLoading: true });
    if (!query.trim()) {
      set({ searchResults: [], searchLoading: false });
      return;
    }
    try {
      const results = await api.globalSearch(get().source, query, 50, scope);
      set({ searchResults: results, searchLoading: false });
    } catch (e) {
      console.error("Failed to search:", e);
      set({ searchLoading: false });
    }
  },

  setSearchScope: (scope) => {
    set({ searchScope: scope });
    const query = get().searchQuery;
    if (query.trim()) {
      void get().search(query);
    }
  },

  loadStats: async () => {
    set({ statsLoading: true, statsIsFirstBuild: null });
    try {
      const tokenSummary = await api.getStats(get().source);
      set({ tokenSummary, statsLoading: false, statsIsFirstBuild: tokenSummary.isFirstBuild });
    } catch (e) {
      console.error("Failed to load stats:", e);
      set({ statsLoading: false });
    }
  },

  clearSelection: () => {
    set({
      selectedProject: null,
      selectedFilePath: null,
      sessions: [],
      messages: [],
    });
  },

  refreshInBackground: async (forceReload = false) => {
    const { source, selectedProject } = get();
    try {
      const loadProjects = forceReload
        ? api.refreshProjectsCache
        : api.getProjects;
      const loadSessions = forceReload
        ? api.refreshSessionsCache
        : api.getSessions;
      const projects = await loadProjects(source);
      if (get().source !== source) return;

      if (selectedProject) {
        // Fetch sessions first, then update projects + sessions atomically
        // to avoid sessionCount flashing between raw file count and filtered count
        const sessions = await loadSessions(source, selectedProject);
        if (
          get().source !== source ||
          get().selectedProject !== selectedProject
        ) {
          return;
        }
        set({
          sessions,
          projects: projects.map((p) =>
            p.id === selectedProject
              ? { ...p, sessionCount: sessions.length }
              : p
          ),
        });
      } else {
        set({ projects });
      }
    } catch (e) {
      console.error("Background refresh failed:", e);
    }

    // 静默刷新当前会话消息（仅当 page=0，不打断用户上翻历史）
    const { selectedFilePath, messagesPage, source: currentSource } = get();
    if (selectedFilePath && messagesPage === 0) {
      try {
        const result = await api.getMessages(currentSource, selectedFilePath, 0, MAIN_MESSAGES_PAGE_SIZE, true);
        if (
          get().source !== currentSource ||
          get().selectedFilePath !== selectedFilePath ||
          get().messagesPage !== 0
        ) {
          return;
        }
        set({
          messages: result.messages,
          messagesTotal: result.total,
          messagesHasMore: result.hasMore,
        });
      } catch {
        // 静默失败
      }
    }
  },

  updateSessionMeta: async (
    sessionId: string,
    alias: string | null,
    tags: string[]
  ) => {
    const { source, selectedProject, sessions } = get();
    if (!selectedProject) return;
    const session = sessions.find(s => s.sessionId === sessionId);
    const filePath = session?.filePath ?? null;
    await api.updateSessionMeta(source, selectedProject, sessionId, alias, tags, filePath);
    // Update local state
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.sessionId === sessionId
          ? { ...s, alias, tags: tags.length > 0 ? tags : null }
          : s
      ),
    }));
    // Refresh tags
    get().loadAllTags();
  },

  loadAllTags: async () => {
    const { source, selectedProject } = get();
    if (!selectedProject) return;
    try {
      const allTags = await api.getAllTags(source, selectedProject);
      set({ allTags });
    } catch (e) {
      console.error("Failed to load tags:", e);
    }
  },

  setTagFilter: (tags: string[]) => {
    set({ tagFilter: tags });
  },

  loadCrossProjectTags: async () => {
    try {
      const crossProjectTags = await api.getCrossProjectTags(get().source);
      set({ crossProjectTags });
    } catch (e) {
      console.error("Failed to load cross-project tags:", e);
    }
  },

  setGlobalTagFilter: (tags: string[]) => {
    set({ globalTagFilter: tags });
  },

  loadBookmarks: async () => {
    set({ bookmarksLoading: true });
    try {
      const bookmarks = await api.listBookmarks();
      set({ bookmarks, bookmarksLoading: false });
    } catch (e) {
      console.error("Failed to load bookmarks:", e);
      set({ bookmarksLoading: false });
    }
  },

  addBookmark: async (bookmark) => {
    try {
      const created = await api.addBookmark(bookmark);
      set((state) => ({ bookmarks: [...state.bookmarks, created] }));
    } catch (e) {
      console.error("Failed to add bookmark:", e);
    }
  },

  removeBookmark: async (id) => {
    try {
      await api.removeBookmark(id);
      set((state) => ({
        bookmarks: state.bookmarks.filter((b) => b.id !== id),
      }));
    } catch (e) {
      console.error("Failed to remove bookmark:", e);
    }
  },

  isBookmarked: (sessionId, messageId) => {
    return get().bookmarks.some(
      (b) => b.sessionId === sessionId && b.messageId === (messageId ?? null)
    );
  },

  loadRecycledItems: async () => {
    set({ recyclebinLoading: true });
    try {
      const recycledItems = await api.listRecycledItems();
      set({ recycledItems, recyclebinLoading: false });
    } catch (e) {
      console.error("Failed to load recycled items:", e);
      set({ recyclebinLoading: false });
    }
  },

  restoreItem: async (id: string) => {
    await api.restoreRecycledItem(id);
    set((state) => ({
      recycledItems: state.recycledItems.filter((item) => item.id !== id),
    }));
  },

  permanentlyDeleteItem: async (id: string) => {
    await api.permanentlyDeleteRecycledItem(id);
    set((state) => ({
      recycledItems: state.recycledItems.filter((item) => item.id !== id),
    }));
  },

  emptyRecyclebin: async () => {
    await api.emptyRecyclebin();
    set({ recycledItems: [] });
  },

  cleanupOrphanDirs: async () => {
    const { source } = get();
    const count = await api.cleanupOrphanDirs(source);
    // 刷新回收站列表
    if (count > 0) {
      const recycledItems = await api.listRecycledItems();
      set({ recycledItems });
    }
    return count;
  },
}));
