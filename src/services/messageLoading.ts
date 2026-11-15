interface MessageLoadingState {
  source: string;
  selectedFilePath: string | null;
  messagesGeneration: number;
  messagesHasMore: boolean;
  messagesLoading: boolean;
  loadedStart: number;
  loadMoreMessages: () => Promise<void>;
}

/** Load older pages only for the window that was active when the user asked. */
export async function loadAllOlderMessages(
  getState: () => MessageLoadingState,
  signal: AbortSignal,
) {
  const initial = getState();
  if (!initial.selectedFilePath) return;
  const isCurrent = (state: MessageLoadingState) => !signal.aborted &&
    state.source === initial.source && state.selectedFilePath === initial.selectedFilePath &&
    state.messagesGeneration === initial.messagesGeneration;

  for (let page = 0; page < 500; page += 1) {
    const state = getState();
    if (!isCurrent(state)) return;
    if (state.messagesLoading) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      continue;
    }
    if (!state.messagesHasMore) return;
    await state.loadMoreMessages();
    const after = getState();
    if (!isCurrent(after) || after.loadedStart >= state.loadedStart) return;
  }
}
