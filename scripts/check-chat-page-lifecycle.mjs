import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import ts from "typescript";

// Execute the production store and hooks. The hook host supplies only React's
// ref/effect lifecycle; APIs, animation frames and timers stay in memory.
let host;
const equalDeps = (left, right) => left?.length === right?.length && left.every((value, index) => Object.is(value, right[index]));
class HookHost {
  slots = [];
  render(callback) {
    host = this;
    this.index = 0;
    this.pending = [];
    const result = callback();
    for (const run of this.pending) run();
    host = null;
    return result;
  }
  unmount() { for (const slot of this.slots) slot?.cleanup?.(); this.slots = []; }
}
globalThis.__chatPageReact = {
  useRef(value) { const index = host.index++; return host.slots[index] ??= { current: value }; },
  useCallback(callback, deps) {
    const index = host.index++;
    if (!equalDeps(host.slots[index]?.deps, deps)) host.slots[index] = { deps, callback };
    return host.slots[index].callback;
  },
  useEffect(callback, deps) {
    const index = host.index++;
    const previous = host.slots[index];
    if (equalDeps(previous?.deps, deps)) return;
    const currentHost = host;
    host.pending.push(() => {
      previous?.cleanup?.();
      currentHost.slots[index] = { deps, cleanup: callback() };
    });
  },
};
const defer = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const starts = [], resumes = [], cancellations = [];
globalThis.__chatPageApi = {
  startChat(params) { const request = { params, ...defer() }; starts.push(request); return request.promise; },
  continueChat(params) { const request = { params, ...defer() }; resumes.push(request); return request.promise; },
  cancelChat(id) { const request = { id, ...defer() }; cancellations.push(request); return request.promise; },
};
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } });
const savedRaf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback) => queueMicrotask(callback);
const savedTimeout = globalThis.setTimeout, savedClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let timerId = 0;
globalThis.setTimeout = (callback) => { timers.set(++timerId, callback); return timerId; };
globalThis.clearTimeout = (id) => timers.delete(id);
const runTimers = () => { const current = [...timers.values()]; timers.clear(); for (const callback of current) callback(); };
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const stubs = {
  "../services/api": "export const api = globalThis.__chatPageApi;",
  "../i18n/index.js": "export const t = (key) => key;",
  react: `export const { useRef, useCallback, useEffect } = globalThis.__chatPageReact;
    export const useLayoutEffect = useEffect;`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier) && (specifier !== "react" || context.parentURL?.includes("/src/hooks/"))) {
      return { url: "asv-chat-page:" + specifier, shortCircuit: true };
    }
    if (specifier === "../stores/chatStore" || specifier === "../services/chatLifecycle") {
      return { url: new URL(`${specifier.replace("../", "../src/")}.ts`, import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("asv-chat-page:")) return { format: "module", source: stubs[url.slice("asv-chat-page:".length)], shortCircuit: true };
    return nextLoad(url, context);
  },
});

try {
  const { useChatStore } = await import("../src/stores/chatStore.ts");
  const { useChatPageLifecycle } = await import("../src/hooks/useChatPageLifecycle.ts");
  const { useChatHistoryHandoff } = await import("../src/hooks/useChatHistoryHandoff.ts");
  const { chatCompletionSucceeded } = await import("../src/services/chatLifecycle.ts");
  const state = () => useChatStore.getState();
  const pane = (id) => state().getPaneState(id);
  const startResume = async (id) => {
    const pending = state().continueExistingChatInPane(id, "session", "/project", "prompt", "model");
    await flush();
    return { pending, request: resumes.at(-1), turnId: pane(id).turnId };
  };

  const initialStart = state().startNewChatInPane("sync", "/project", "prompt", "model");
  await flush();
  const syncPane = pane("sync");
  state().completePane("sync", syncPane.streamId, syncPane.turnId, true);
  starts.at(-1).resolve("real-session");
  await initialStart;
  assert.equal(pane("sync").sessionId, "real-session", "Synchronous complete must not lose the real session ID");
  assert.equal(pane("sync").completion, "success");

  const failed = await startResume("failed");
  failed.request.reject(new Error("start refused"));
  await failed.pending;
  state().completePane("failed", "session", failed.turnId, true);
  assert.equal(pane("failed").completion, "error");
  assert.equal(pane("failed").error, "start refused");
  assert.equal(pane("failed").messages.length, 1);

  const cancelled = await startResume("cancelled");
  const cancelPromise = state().cancelPane("cancelled");
  cancellations.at(-1).resolve();
  await cancelPromise;
  state().completePane("cancelled", "session", cancelled.turnId, true);
  assert.equal(pane("cancelled").completion, "cancelled");
  assert.equal(pane("cancelled").messages.length, 1);
  cancelled.request.resolve();
  await cancelled.pending;
  const replacement = await startResume("cancelled");
  state().completePane("cancelled", "session", cancelled.turnId, false);
  assert.equal(pane("cancelled").completion, null, "Old completion cannot finish a new turn sharing the same stream ID");
  replacement.request.resolve(); await replacement.pending;

  // Exercise the actual page event handler, not just the store guard.
  const pageSource = await readFile(new URL("../src/components/message/MessagesPage.tsx", import.meta.url), "utf8");
  const page = ts.createSourceFile("MessagesPage.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const handler = page.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "handlePaneWebChatMessage");
  assert.ok(handler);
  const handlerSource = stripTypeScriptTypes(handler.getText(page));
  const handleFrame = new Function("useChatStore", "isActualChatError", "chatCompletionSucceeded", `${handlerSource}; return handlePaneWebChatMessage;`)(useChatStore, () => true, chatCompletionSucceeded);
  handleFrame("cancelled", "session", cancelled.turnId, JSON.stringify({ type: "complete", success: true, sessionId: "session" }));
  assert.equal(pane("cancelled").completion, null);
  handleFrame("cancelled", "session", replacement.turnId, JSON.stringify({ type: "complete", success: false, sessionId: "session" }));
  assert.equal(pane("cancelled").completion, "error");
  assert.ok(pane("cancelled").error);

  // Unmount cancels synchronously and clears before cancellation settles.
  const leavingHost = new HookHost();
  leavingHost.render(() => useChatPageLifecycle("leaving", "A"));
  const leaving = await startResume("leaving");
  const cancelCount = cancellations.length;
  leavingHost.unmount();
  assert.equal(cancellations.length, cancelCount + 1);
  assert.equal(pane("leaving").streamId, null);
  const remountedHost = new HookHost();
  remountedHost.render(() => useChatPageLifecycle("leaving", "B"));
  const remounted = await startResume("leaving");
  cancellations.at(-1).resolve();
  leaving.request.resolve(); await leaving.pending;
  assert.equal(pane("leaving").turnId, remounted.turnId);
  assert.equal(pane("leaving").isStreaming, true, "Late cancellation must not clear a remounted turn");
  state().completePane("leaving", "session", remounted.turnId, true);
  remounted.request.resolve(); await remounted.pending;
  const beforeFinishedLeave = cancellations.length;
  remountedHost.unmount();
  assert.equal(cancellations.length, beforeFinishedLeave, "Leaving a completed pane does not cancel its session");

  // Cover both sides of await cancel: unmount before scheduling and after it.
  for (const unmountBeforeAck of [true, false]) {
    const delayedHost = new HookHost();
    const sendAfterCancel = delayedHost.render(() => useChatPageLifecycle("delay", "A"));
    const running = await startResume("delay");
    let sent = 0;
    const delayed = sendAfterCancel(() => { sent++; });
    if (unmountBeforeAck) delayedHost.unmount();
    cancellations.at(-1).resolve(); await delayed;
    if (!unmountBeforeAck) { assert.equal(timers.size, 1); delayedHost.unmount(); }
    runTimers();
    assert.equal(sent, 0, "A queued answer cannot restart a task after leaving");
    running.request.resolve(); await running.pending;
  }
  const liveHost = new HookHost();
  const liveSend = liveHost.render(() => useChatPageLifecycle("live-delay", "A"));
  const live = await startResume("live-delay");
  let liveSent = 0;
  const queued = liveSend(() => { liveSent++; });
  cancellations.at(-1).resolve(); await queued;
  runTimers();
  assert.equal(liveSent, 1, "A still-mounted cancelled turn may send its queued answer");
  live.request.resolve(); await live.pending; liveHost.unmount();

  const historyHost = new HookHost();
  let refreshes = 0;
  const refresh = async () => { refreshes++; };
  let history = { source: "claude", filePath: "A", messages: [], total: 100, loadedStart: 70, loading: false };
  const renderHistory = (snapshot = pane("history")) => historyHost.render(() => useChatHistoryHandoff("history", snapshot, history, refresh));
  renderHistory();
  const historyTurn = await startResume("history");
  state().setPaneState("history", (current) => ({ ...current, messages: [...current.messages, {
    id: "reply", role: "assistant", content: [{ type: "text", text: "finished reply" }], timestamp: "now",
  }] }));
  state().completePane("history", "session", historyTurn.turnId, true);
  historyTurn.request.resolve(); await historyTurn.pending;
  renderHistory();
  assert.equal(refreshes, 1);
  assert.equal(pane("history").messages.length, 2, "Success alone never clears live content");
  history = { ...history, total: 102, loadedStart: 20, messages: [{ uuid: "old", role: "assistant", content: [{ type: "text", text: "finished reply" }] }] };
  renderHistory();
  assert.equal(pane("history").messages.length, 2, "An identical old reply in a middle window is not acceptance");
  history = { ...history, loadedStart: 101 };
  renderHistory();
  assert.equal(pane("history").messages.length, 0, "Only newly appended, visible matching history accepts the reply");
  assert.equal(refreshes, 1);

  // A failed refresh keeps the reply, and a stale render cannot clear a newer turn.
  const retained = await startResume("history");
  state().setPaneState("history", (current) => ({ ...current, messages: [...current.messages, {
    id: "retained", role: "assistant", content: [{ type: "text", text: "not yet recorded" }], timestamp: "now",
  }] }));
  state().completePane("history", "session", retained.turnId, true);
  retained.request.resolve(); await retained.pending;
  const retainedPane = pane("history");
  historyHost.render(() => useChatHistoryHandoff("history", retainedPane, history, async () => { throw new Error("refresh failed"); }));
  await flush();
  assert.equal(pane("history").messages.length, 2);
  const newer = await startResume("history");
  history = { ...history, total: 104, loadedStart: 103, messages: [{ uuid: "retained", role: "assistant", content: [{ type: "text", text: "not yet recorded" }] }] };
  renderHistory(retainedPane);
  assert.equal(pane("history").turnId, newer.turnId);
  assert.equal(pane("history").messages.length, 3, "Old successful handoff cannot clear a newer prompt");
  newer.request.resolve(); await newer.pending;

  for (const id of ["failed", "cancelled"]) {
    const failureHost = new HookHost();
    const before = pane(id).messages.length;
    failureHost.render(() => useChatHistoryHandoff(id, pane(id), history, refresh));
    runTimers();
    assert.equal(pane(id).messages.length, before);
    assert.equal(refreshes, 1, "Failed/cancelled turns do not enter successful handoff");
    failureHost.unmount();
  }
  historyHost.unmount();
  console.log("Chat page lifecycle checks passed (terminal states, real page frames, unmount, delayed answers, accepted history).");
} finally {
  hooks.deregister();
  globalThis.setTimeout = savedTimeout; globalThis.clearTimeout = savedClearTimeout;
  if (savedRaf) globalThis.requestAnimationFrame = savedRaf; else delete globalThis.requestAnimationFrame;
  if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage); else delete globalThis.localStorage;
  delete globalThis.__chatPageReact; delete globalThis.__chatPageApi;
}
