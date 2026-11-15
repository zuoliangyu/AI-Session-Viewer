import type { ChatPaneState } from "../stores/chatStore";
import type { DisplayMessage } from "../types";

export interface ChatHistorySnapshot {
  source: string;
  filePath: string;
  messages: DisplayMessage[];
  total: number;
  loadedStart: number;
  loading: boolean;
}

export function chatCompletionSucceeded(payload: unknown): boolean {
  try {
    const value = typeof payload === "string" ? JSON.parse(payload) : payload;
    return value?.success === true;
  } catch { return false; }
}

/** Keep live content until the final reply is present in newly appended history. */
export function historyHasCompletedTurn(pane: ChatPaneState, history: ChatHistorySnapshot, baselineTotal: number) {
  if (pane.completion !== "success" || pane.isStreaming || history.loading || history.source !== pane.source) return false;
  if (history.total <= baselineTotal) return false;
  const promptIndex = pane.messages.findIndex((message) => message.id === pane.turnPromptId);
  if (promptIndex < 0) return false;
  const reply = pane.messages.slice(promptIndex + 1).reverse().find((message) => message.role === "assistant");
  if (!reply) return false;
  const text = reply.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
  if (!text) return false;
  return history.messages.some((message, index) => {
    if (history.loadedStart + index < baselineTotal || message.role !== "assistant") return false;
    const recordedText = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
    return recordedText === text;
  });
}
