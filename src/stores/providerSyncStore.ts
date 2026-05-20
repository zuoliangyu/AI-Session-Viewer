import { create } from "zustand";
import { api } from "../services/api";
import type {
  ProviderSyncStatus,
  SyncResult,
  RestoreOptions,
  RestoreResult,
} from "../types/providerSync";

interface ProviderSyncState {
  status: ProviderSyncStatus | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  lastResult: SyncResult | null;
  lastRestore: RestoreResult | null;

  loadStatus: () => Promise<void>;
  runSync: (provider: string | null, keep?: number) => Promise<SyncResult>;
  runSwitch: (provider: string, keep?: number) => Promise<SyncResult>;
  runRestore: (
    backupDir: string,
    options?: RestoreOptions,
  ) => Promise<RestoreResult>;
  prune: (keep?: number) => Promise<number>;
  clearError: () => void;
}

export const useProviderSyncStore = create<ProviderSyncState>((set) => ({
  status: null,
  loading: false,
  error: null,
  busy: false,
  lastResult: null,
  lastRestore: null,

  loadStatus: async () => {
    set({ loading: true, error: null });
    try {
      const status = await api.providerSyncStatus();
      set({ status, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  runSync: async (provider, keep = 5) => {
    set({ busy: true, error: null });
    try {
      const result = await api.providerSyncRun(provider, keep);
      const status = await api.providerSyncStatus();
      set({ busy: false, lastResult: result, status });
      return result;
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  runSwitch: async (provider, keep = 5) => {
    set({ busy: true, error: null });
    try {
      const result = await api.providerSyncSwitch(provider, keep);
      const status = await api.providerSyncStatus();
      set({ busy: false, lastResult: result, status });
      return result;
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  runRestore: async (backupDir, options) => {
    set({ busy: true, error: null });
    try {
      const result = await api.providerSyncRestore(backupDir, options);
      const status = await api.providerSyncStatus();
      set({ busy: false, lastRestore: result, status });
      return result;
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  prune: async (keep = 5) => {
    set({ busy: true, error: null });
    try {
      const removed = await api.providerSyncPrune(keep);
      const status = await api.providerSyncStatus();
      set({ busy: false, status });
      return removed;
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  clearError: () => set({ error: null }),
}));
