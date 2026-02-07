import { create } from "zustand";
import type {
  Project,
  SessionIndexEntry,
  DisplayMessage,
  PaginatedMessages,
  StatsCache,
  TokenUsageSummary,
  SearchResult,
} from "../types";
import * as api from "../services/tauriApi";

interface AppState {
  // Projects
  projects: Project[];
  projectsLoading: boolean;
  selectedProject: string | null;

  // Sessions
  sessions: SessionIndexEntry[];
  sessionsLoading: boolean;
  selectedSession: string | null;

  // Messages
  messages: DisplayMessage[];
  messagesLoading: boolean;
  messagesTotal: number;
  messagesPage: number;
  messagesHasMore: boolean;

  // Search
  searchQuery: string;
  searchResults: SearchResult[];
  searchLoading: boolean;

  // Stats
  stats: StatsCache | null;
  tokenSummary: TokenUsageSummary | null;
  statsLoading: boolean;

  // Actions
  loadProjects: () => Promise<void>;
  selectProject: (encodedName: string) => Promise<void>;
  selectSession: (
    encodedName: string,
    sessionId: string
  ) => Promise<void>;
  deleteSession: (
    encodedName: string,
    sessionId: string
  ) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  search: (query: string) => Promise<void>;
  loadStats: () => Promise<void>;
  clearSelection: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  projectsLoading: false,
  selectedProject: null,

  sessions: [],
  sessionsLoading: false,
  selectedSession: null,

  messages: [],
  messagesLoading: false,
  messagesTotal: 0,
  messagesPage: 0,
  messagesHasMore: false,

  searchQuery: "",
  searchResults: [],
  searchLoading: false,

  stats: null,
  tokenSummary: null,
  statsLoading: false,

  loadProjects: async () => {
    set({ projectsLoading: true });
    try {
      const projects = await api.getProjects();
      set({ projects, projectsLoading: false });
    } catch (e) {
      console.error("Failed to load projects:", e);
      set({ projectsLoading: false });
    }
  },

  selectProject: async (encodedName: string) => {
    set({
      selectedProject: encodedName,
      sessionsLoading: true,
      selectedSession: null,
      messages: [],
      messagesTotal: 0,
      messagesPage: 0,
    });
    try {
      const sessions = await api.getSessions(encodedName);
      set({ sessions, sessionsLoading: false });
    } catch (e) {
      console.error("Failed to load sessions:", e);
      set({ sessionsLoading: false });
    }
  },

  selectSession: async (encodedName: string, sessionId: string) => {
    set({
      selectedSession: sessionId,
      messagesLoading: true,
      messages: [],
      messagesTotal: 0,
      messagesPage: 0,
    });
    try {
      const result = await api.getMessages(encodedName, sessionId, 0, 50);
      set({
        messages: result.messages,
        messagesTotal: result.total,
        messagesPage: 0,
        messagesHasMore: result.hasMore,
        messagesLoading: false,
      });
    } catch (e) {
      console.error("Failed to load messages:", e);
      set({ messagesLoading: false });
    }
  },

  deleteSession: async (encodedName: string, sessionId: string) => {
    await api.deleteSession(encodedName, sessionId);
    set((state) => ({
      sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
    }));
  },

  loadMoreMessages: async () => {
    const state = get();
    if (
      !state.selectedProject ||
      !state.selectedSession ||
      !state.messagesHasMore ||
      state.messagesLoading
    ) {
      return;
    }

    const nextPage = state.messagesPage + 1;
    set({ messagesLoading: true });
    try {
      const result = await api.getMessages(
        state.selectedProject,
        state.selectedSession,
        nextPage,
        50
      );
      set({
        messages: [...state.messages, ...result.messages],
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
    set({ searchQuery: query, searchLoading: true });
    if (!query.trim()) {
      set({ searchResults: [], searchLoading: false });
      return;
    }
    try {
      const results = await api.globalSearch(query, 50);
      set({ searchResults: results, searchLoading: false });
    } catch (e) {
      console.error("Failed to search:", e);
      set({ searchLoading: false });
    }
  },

  loadStats: async () => {
    set({ statsLoading: true });
    try {
      const [stats, tokenSummary] = await Promise.all([
        api.getGlobalStats(),
        api.getTokenSummary(),
      ]);
      set({ stats, tokenSummary, statsLoading: false });
    } catch (e) {
      console.error("Failed to load stats:", e);
      set({ statsLoading: false });
    }
  },

  clearSelection: () => {
    set({
      selectedProject: null,
      selectedSession: null,
      sessions: [],
      messages: [],
    });
  },
}));
