export interface ProviderCount {
  provider: string;
  count: number;
}

export interface SqliteProviderCount {
  provider: string;
  archived: boolean;
  count: number;
}

export interface EncryptedWarning {
  provider: string;
  count: number;
}

export interface BackupSummary {
  name: string;
  path: string;
  createdAt: string;
  targetProvider: string;
  changedSessionCount: number;
}

export interface ProviderSyncStatus {
  codexHome: string;
  currentProvider: string;
  currentProviderImplicit: boolean;
  configTomlPath: string;
  configTomlExists: boolean;
  configuredProviders: string[];
  rolloutStats: ProviderCount[];
  archivedStats: ProviderCount[];
  sqliteStats: SqliteProviderCount[];
  sqlitePath: string;
  sqliteExists: boolean;
  globalStatePath: string;
  globalStateExists: boolean;
  mismatchedRollouts: number;
  mismatchedArchived: number;
  mismatchedSqliteThreads: number;
  encryptedWarnings: EncryptedWarning[];
  backups: BackupSummary[];
}

export interface SyncResult {
  backupDir: string;
  targetProvider: string;
  updatedRollouts: number;
  updatedSqliteRows: number;
  globalStateUpdated: boolean;
  configUpdated: boolean;
  skippedLocked: string[];
}

export interface RestoreOptions {
  includeConfig: boolean;
  includeDb: boolean;
  includeSessions: boolean;
  includeGlobalState: boolean;
}

export interface RestoreResult {
  restoredFiles: number;
  restoredSessions: number;
}
