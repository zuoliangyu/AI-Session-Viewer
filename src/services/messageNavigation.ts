import type { DisplayMessage, MessageLocation } from "../types";

export function buildSessionMessageUrl(
  projectId: string,
  filePath: string,
  messageId?: string | null,
  options: { matchedOnly?: boolean; searchQuery?: string } = {},
) {
  const params = new URLSearchParams();
  if (messageId) {
    params.set("scrollTo", messageId);
    if (options.matchedOnly) params.set("matchedOnly", "1");
  }
  if (options.searchQuery) params.set("searchQuery", options.searchQuery);
  const query = params.toString();
  return `/projects/${encodeURIComponent(projectId)}/session/${encodeURIComponent(filePath)}${query ? `?${query}` : ""}`;
}

/** Keep old billing links (#m=...) working alongside bookmark/search URLs. */
export function readMessageTarget(search: string, hash = "") {
  const target = new URLSearchParams(search).get("scrollTo");
  if (target) return target;
  if (!hash.startsWith("#m=")) return null;
  // Legacy billing links put the ID directly in the fragment, so '+' and '&'
  // are literal ID characters rather than form/query separators.
  const legacy = hash.slice(3);
  try { return decodeURIComponent(legacy) || null; }
  catch { return legacy || null; }
}

export function getDisplayMessageId(message: DisplayMessage, absoluteIndex: number) {
  return message.uuid || `${message.role}-${absoluteIndex}`;
}

export function getFocusedMessageWindow(messages: DisplayMessage[], offset: number, messageId: string) {
  const targetIndex = messages.findIndex((message, index) => getDisplayMessageId(message, offset + index) === messageId);
  if (targetIndex < 0) return { messages: [] as DisplayMessage[], offset };
  let start = targetIndex;
  let end = targetIndex;
  if (messages[targetIndex].role !== "user") {
    for (let index = targetIndex - 1; index >= 0; index--) {
      if (messages[index].role === "user") { start = index; break; }
    }
  }
  while (end + 1 < messages.length && messages[end + 1].role !== "user") end++;
  return { messages: messages.slice(start, end + 1), offset: offset + start };
}

interface NavigationState {
  source: string;
  selectedFilePath: string | null;
  messagesGeneration: number;
  messages: DisplayMessage[];
  messagesLoading: boolean;
  messagesError: string | null;
  loadedStart: number;
  jumpToMessageIndex: (index: number) => Promise<void>;
}

type NavigationResult =
  | { status: "found"; messageIndex: number; generation: number }
  | { status: "missing" }
  | { status: "cancelled" };

/** Resolve one ID, then load only its window. Never follow another session. */
export async function navigateToMessage(
  getState: () => NavigationState,
  locate: (source: string, filePath: string, messageId: string) => Promise<MessageLocation>,
  messageId: string,
  signal: AbortSignal,
): Promise<NavigationResult> {
  const initial = getState();
  let generation = initial.messagesGeneration;
  const isCurrent = () => !signal.aborted && getState().source === initial.source &&
    getState().selectedFilePath === initial.selectedFilePath && getState().messagesGeneration === generation;
  if (!initial.selectedFilePath || !isCurrent()) return { status: "cancelled" };

  try {
    // A scroll-driven page may still be finishing when a new URL target arrives.
    while (getState().messagesLoading) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (!isCurrent()) return { status: "cancelled" };
    }
    const state = getState();
    if (state.messagesError && state.messages.length === 0) throw new Error(state.messagesError);
    const loadedIndex = state.messages.findIndex((message, index) =>
      getDisplayMessageId(message, state.loadedStart + index) === messageId);
    if (loadedIndex >= 0) return { status: "found", messageIndex: state.loadedStart + loadedIndex, generation };

    const { messageIndex } = await locate(initial.source, initial.selectedFilePath, messageId);
    if (!isCurrent()) return { status: "cancelled" };
    if (messageIndex === null) return { status: "missing" };
    const pendingJump = getState().jumpToMessageIndex(messageIndex);
    generation = getState().messagesGeneration;
    await pendingJump;
    if (!isCurrent()) return { status: "cancelled" };
    const current = getState();
    if (current.messagesError) throw new Error(current.messagesError);
    const target = current.messages[messageIndex - current.loadedStart];
    if (!target || getDisplayMessageId(target, messageIndex) !== messageId) return { status: "missing" };
    return { status: "found", messageIndex, generation };
  } catch (error) {
    if (!isCurrent()) return { status: "cancelled" };
    throw error;
  }
}
