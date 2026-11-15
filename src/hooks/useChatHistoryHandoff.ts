import { useEffect, useLayoutEffect, useRef } from "react";
import { useChatStore, type ChatPaneState } from "../stores/chatStore";
import { historyHasCompletedTurn, type ChatHistorySnapshot } from "../services/chatLifecycle";

/** A completed reply stays visible until the historical message window owns it. */
export function useChatHistoryHandoff(
  paneId: string,
  pane: ChatPaneState | undefined,
  history: ChatHistorySnapshot,
  refresh: () => Promise<void>,
) {
  const historyRef = useRef(history);
  historyRef.current = history;
  const baselineRef = useRef<{ turnId: number; total: number; source: string; filePath: string } | null>(null);
  const refreshedTurnRef = useRef(0);

  useLayoutEffect(() => {
    const rememberTurn = () => {
      const current = useChatStore.getState().getPaneState(paneId);
      if (!current.turnId || baselineRef.current?.turnId === current.turnId) return;
      const snapshot = historyRef.current;
      baselineRef.current = { turnId: current.turnId, total: snapshot.total, source: snapshot.source, filePath: snapshot.filePath };
    };
    rememberTurn();
    return useChatStore.subscribe(rememberTurn);
  }, [paneId]);

  useEffect(() => {
    const baseline = baselineRef.current;
    if (!pane || pane.completion !== "success" || !baseline || baseline.turnId !== pane.turnId) return;
    if (baseline.source !== history.source || baseline.filePath !== history.filePath) return;
    if (refreshedTurnRef.current !== pane.turnId) {
      refreshedTurnRef.current = pane.turnId;
      void refresh().catch(() => {}); // Keep live content when refreshing fails.
    }
    if (!historyHasCompletedTurn(pane, history, baseline.total)) return;
    const current = useChatStore.getState().getPaneState(paneId);
    if (current.turnId === pane.turnId && current.completion === "success") {
      useChatStore.getState().clearPane(paneId);
    }
  }, [paneId, pane, history.messages, history.total, history.loadedStart, history.loading, history.source, history.filePath, refresh]);
}
