interface NodePair {
  sourceId: string;
  targetId: string;
}

/** Keep a completed preview attached to the node pair that produced it. */
export function createSyncPreviewGuard() {
  let version = 0;
  let request: NodePair | null = null;
  let preview: NodePair | null = null;
  let syncing = false;

  const canSync = (sourceId: string, targetId: string) =>
    !syncing && preview?.sourceId === sourceId && preview.targetId === targetId;

  return {
    begin(sourceId: string, targetId: string) {
      request = { sourceId, targetId };
      preview = null;
      return ++version;
    },
    isCurrent(requestVersion: number) {
      return requestVersion === version;
    },
    accept(requestVersion: number) {
      if (requestVersion !== version || !request) return false;
      preview = request;
      return true;
    },
    invalidate() {
      version += 1;
      request = null;
      preview = null;
    },
    canSync,
    tryStartSync(sourceId: string, targetId: string) {
      if (!canSync(sourceId, targetId)) return false;
      syncing = true;
      return true;
    },
    isSyncing() {
      return syncing;
    },
    finishSync() {
      syncing = false;
    },
  };
}
