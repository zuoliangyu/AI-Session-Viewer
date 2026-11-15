import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { loadAllOlderMessages } from "../src/services/messageLoading.ts";

// Real store and load-all loop, native type stripping, in-memory API responses.
const requests = [];
const deferRequest = (method, args) => new Promise((resolve, reject) => requests.push({ method, args, resolve, reject }));
globalThis.__requestIsolationApi = {
  globalSearch: (...args) => deferRequest("search", args),
  getMessages: (...args) => deferRequest("initial", args),
  getMessagesRange: (...args) => deferRequest("range", args),
  getProjects: async () => [], getSessions: async () => [],
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } });
const stubs = {
  "../services/api": "export const api = globalThis.__requestIsolationApi;",
  "../utils/perfDiagnostics": `export const PERF_DIAGNOSTICS_ENABLED = false;
    export const getMessagesPerfFields = () => ({});
    export const markPendingMessageCommit = () => {};
    export const nextPerfTraceId = () => 'test';
    export const recordPerfDiagnostic = () => {};`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier)) return { url: "asv-request-test:" + specifier, shortCircuit: true };
    if (specifier === "../utils/dateTime") return { url: new URL("../src/utils/dateTime.ts", import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("asv-request-test:")) return { format: "module", source: stubs[url.slice("asv-request-test:".length)], shortCircuit: true };
    return nextLoad(url, context);
  },
});
const messages = (start, end, prefix = "") => Array.from({ length: end - start }, (_, i) => ({
  uuid: `${prefix}${start + i}`, role: "user", content: [{ type: "text", text: `${start + i}` }],
}));
const range = (start, end, total = 1000) => ({ start, end, total, messages: messages(start, end) });
const tail = (total = 1000, prefix = "") => ({ total, hasMore: total > 30, messages: messages(Math.max(0, total - 30), total, prefix) });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const last = () => requests.at(-1);

try {
  const { useAppStore } = await import("../src/stores/appStore.ts");
  const state = () => useAppStore.getState();
  const openWindow = (filePath = "A", start = 900, end = 930, total = 1000) => useAppStore.setState({
    selectedProject: null, selectedFilePath: filePath, messagesGeneration: state().messagesGeneration + 1,
    messages: messages(start, end), messagesTotal: total, loadedStart: start, loadedEnd: end,
    messagesHasMore: start > 0, messagesHasNewer: end < total, messagesLoading: false, messagesError: null,
  });

  const oldSearch = state().search("old");
  const oldSearchResponse = last();
  await state().search("");
  oldSearchResponse.resolve([{ matchedText: "old" }]);
  await oldSearch;
  assert.equal(state().searchQuery, "");
  assert.deepEqual(state().searchResults, [], "Clearing search invalidates outstanding results");

  const searchA = state().search("first");
  const searchAResponse = last();
  const searchB = state().search("second");
  last().resolve([{ matchedText: "second" }]);
  await searchB;
  searchAResponse.resolve([{ matchedText: "first" }]);
  await searchA;
  assert.deepEqual(state().searchResults, [{ matchedText: "second" }]);

  const beforeSwitch = state().search("same");
  const beforeSwitchResponse = last();
  state().setSource("codex");
  state().setSource("claude");
  const afterSwitch = state().search("same");
  const afterSwitchResponse = last();
  beforeSwitchResponse.reject(new Error("old source failure"));
  await beforeSwitch;
  assert.equal(state().searchLoading, true, "A -> B -> A must not admit A's old failure");
  afterSwitchResponse.resolve([{ matchedText: "fresh" }]);
  await afterSwitch;

  const beforeScope = state().search("scope");
  const beforeScopeResponse = last();
  state().setSearchScope("tags");
  const afterScopeResponse = last();
  beforeScopeResponse.resolve([{ matchedText: "content result" }]);
  await beforeScope;
  assert.equal(state().searchLoading, true);
  afterScopeResponse.resolve([{ matchedText: "tag result" }]);
  await settle();
  assert.deepEqual(state().searchResults, [{ matchedText: "tag result" }]);

  // Original corruption case: older [870,900) arrives after a jump to the tail.
  openWindow();
  const older = state().loadMoreMessages();
  const olderResponse = last();
  const jump = state().jumpToMessageIndex(999);
  last().resolve(range(984, 1000));
  await jump;
  olderResponse.resolve(range(870, 900));
  await older;
  assert.equal(state().loadedStart, 984);
  assert.deepEqual(state().messages, messages(984, 1000));
  assert.equal(state().messages.length, state().loadedEnd - state().loadedStart);

  openWindow();
  const newer = state().loadNewerMessages();
  const newerResponse = last();
  const otherJump = state().jumpToMessageIndex(0);
  const otherJumpResponse = last();
  newerResponse.reject(new Error("old page failure"));
  await newer;
  assert.equal(state().messagesLoading, true, "An old failure cannot end the new jump's spinner");
  otherJumpResponse.resolve(range(0, 16));
  await otherJump;
  assert.deepEqual(state().messages, messages(0, 16));

  openWindow();
  const staleJump = state().jumpToMessageIndex(0);
  const staleJumpResponse = last();
  const freshJump = state().jumpToMessageIndex(500);
  const freshJumpResponse = last();
  staleJumpResponse.reject(new Error("superseded jump failed"));
  await staleJump;
  assert.equal(state().messagesLoading, true);
  freshJumpResponse.resolve(range(485, 516));
  await freshJump;
  assert.deepEqual(state().messages, messages(485, 516));

  openWindow("A", 970, 1000);
  const background = state().refreshInBackground();
  await settle();
  const backgroundResponse = last();
  const foreground = state().loadMoreMessages();
  const foregroundResponse = last();
  backgroundResponse.resolve(tail(1001));
  await background;
  assert.equal(state().messagesLoading, true, "Background completion cannot replace an active page request");
  foregroundResponse.resolve(range(940, 970, 1001));
  await foreground;
  assert.equal(state().loadedStart, 940);
  assert.equal(state().messages.length, 60);

  openWindow();
  const failingOldPage = state().loadMoreMessages();
  const failingResponse = last();
  const newSession = state().selectSession("B");
  last().resolve(tail(120, "B:"));
  await newSession;
  failingResponse.reject(new Error("A failed after B loaded"));
  await failingOldPage;
  assert.equal(state().messagesHasMore, true);
  assert.equal(state().messages[0].uuid, "B:90");

  // Initial-load deduplication is scoped to the navigation generation.
  const firstA = state().selectSession("A");
  const firstAResponse = last();
  const interimB = state().selectSession("B");
  const interimBResponse = last();
  const countBeforeReturn = requests.length;
  const finalA = state().selectSession("A");
  const finalAResponse = last();
  assert.equal(requests.length, countBeforeReturn + 1, "Returning to A starts a fresh request");
  firstAResponse.resolve(tail(100, "stale:"));
  interimBResponse.reject(new Error("stale B failure"));
  await Promise.all([firstA, interimB]);
  assert.equal(state().messagesLoading, true);
  assert.deepEqual(state().messages, []);
  finalAResponse.resolve(tail(130, "fresh:"));
  await finalA;
  assert.equal(state().messages[0].uuid, "fresh:100");

  const duplicateA = state().selectSession("duplicate");
  const duplicateResponse = last();
  const beforeDuplicate = requests.length;
  const duplicateB = state().selectSession("duplicate");
  assert.equal(requests.length, beforeDuplicate, "Duplicate initial effects still share one request");
  duplicateResponse.resolve(tail(50));
  await Promise.all([duplicateA, duplicateB]);
  assert.equal(state().messagesLoading, false);

  const oldReload = state().reloadLatestMessages();
  const oldReloadResponse = last();
  const pendingSession = state().selectSession("pending");
  const pendingResponse = last();
  oldReloadResponse.resolve(tail(200));
  await oldReload;
  assert.equal(state().messagesLoading, true, "Old finally cannot finish a newer request");
  state().clearSelection();
  pendingResponse.resolve(tail(200));
  await pendingSession;
  assert.deepEqual(state().messages, []);
  assert.equal(state().messagesLoading, false);

  // The load-all loop cannot follow navigation into B.
  openWindow();
  const all = loadAllOlderMessages(state, new AbortController().signal);
  const allResponse = last();
  const switchToB = state().selectSession("B");
  last().resolve(tail(100, "B:"));
  await switchToB;
  const countAtB = requests.length;
  allResponse.resolve(range(870, 900));
  await all;
  assert.equal(requests.length, countAtB, "Load-all must not issue B's older page");
  assert.equal(state().messages.length, 30);

  openWindow("A", 60, 90, 90);
  const controller = new AbortController();
  const cancelled = loadAllOlderMessages(state, controller.signal);
  const cancelResponse = last();
  const countAtAbort = requests.length;
  controller.abort();
  cancelResponse.resolve(range(30, 60, 90));
  await cancelled;
  assert.equal(requests.length, countAtAbort, "Unmount/stop aborts further pages");

  openWindow("A", 60, 90, 90);
  const complete = loadAllOlderMessages(state, new AbortController().signal);
  last().resolve(range(30, 60, 90));
  await settle();
  last().resolve(range(0, 30, 90));
  await complete;
  assert.equal(state().loadedStart, 0);
  assert.equal(state().messages.length, 90, "Valid contiguous pagination still completes");
  console.log("Search, message window, and load-all isolation checks passed");
} finally {
  hooks.deregister();
  delete globalThis.__requestIsolationApi;
}
