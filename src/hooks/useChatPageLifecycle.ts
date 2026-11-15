import { useCallback, useLayoutEffect, useRef } from "react";
import { useChatStore } from "../stores/chatStore";

const owners = new Map<string, symbol>();

/** Dispose only this mounted pane, and never send a delayed reply after leaving. */
export function useChatPageLifecycle(paneId: string, scope: string) {
  const ownerRef = useRef<symbol | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const owner = Symbol();
    ownerRef.current = owner;
    owners.set(paneId, owner);
    return () => {
      ownerRef.current = null;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      if (owners.get(paneId) !== owner) return;
      owners.delete(paneId);
      const state = useChatStore.getState();
      const pane = state.getPaneState(paneId);
      if (pane.streamId && pane.completion === null) void state.cancelPane(paneId);
      // cancelPane captures the routing ID before its first await. Clear now;
      // an eventual cancellation response must not clear a remounted pane.
      state.clearPane(paneId);
    };
  }, [paneId, scope]);

  return useCallback(async (send: () => void) => {
    const owner = ownerRef.current;
    if (!owner || owners.get(paneId) !== owner) return;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    const pane = useChatStore.getState().getPaneState(paneId);
    const isCurrent = () => ownerRef.current === owner && owners.get(paneId) === owner &&
      useChatStore.getState().getPaneState(paneId).turnId === pane.turnId;
    if (pane.streamId && pane.completion === null) {
      await useChatStore.getState().cancelPane(paneId);
      if (!isCurrent()) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (isCurrent()) send();
      }, 150);
    } else if (isCurrent()) {
      send();
    }
  }, [paneId, scope]);
}
