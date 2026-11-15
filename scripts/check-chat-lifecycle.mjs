import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes as stripTypes } from "node:module";

// Exercise the real transport module with an in-memory WebSocket and fetch.
// No server, CLI, credentials or network connection is used.
let source = stripTypes(await readFile(new URL("../src/services/webApi.ts", import.meta.url), "utf8"));
source = source
  .replace('import { t } from "../i18n/index.js";', 'const t = (text) => text;')
  .replace('import { getApiBaseUrl, getApiToken } from "./nodeConfig";',
    'const getApiBaseUrl = () => "http://mock.invalid"; const getApiToken = () => null;');

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  static autoOpen = true;
  readyState = 0;
  sent = [];
  constructor() {
    super();
    MockWebSocket.instances.push(this);
    if (MockWebSocket.autoOpen) queueMicrotask(() => this.open());
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  send(raw) {
    assert.equal(this.readyState, 1);
    this.sent.push(JSON.parse(raw));
  }
  receive(frame) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

globalThis.WebSocket = MockWebSocket;
let fetchGate = null;
globalThis.fetch = async (url) => {
  if (fetchGate) await fetchGate;
  return Response.json(String(url).includes("ws-ticket") ? { ticket: "mock-ticket" } : []);
};
const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const received = [];
api.subscribeToChatWebSocketMessages((raw) => received.push(JSON.parse(raw)));
const params = (id) => ({ source: "codex", sessionId: id, projectPath: "/mock", prompt: "hello", model: "", skipPermissions: false });
const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Mock transport did not reach the expected state");
};
const acknowledge = (socket, id) => socket.receive({ type: "session_id", sessionId: id, data: `thread-${id}` });

const first = api.startChat(params("first"));
const second = api.startChat(params("second"));
await waitFor(() => MockWebSocket.instances.at(-1)?.sent.length === 2);
const initial = MockWebSocket.instances.at(-1);
acknowledge(initial, "first");
acknowledge(initial, "second");
await Promise.all([first, second]);
initial.close();
for (const id of ["first", "second"]) {
  assert.equal(received.filter((frame) => frame.type === "error" && frame.sessionId === id).length, 1);
  assert.equal(received.filter((frame) => frame.type === "complete" && frame.sessionId === id && !frame.success).length, 1);
}

let releaseFetch;
fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
const cancelledBeforeSend = api.startChat(params("cancel-before-send"));
await api.cancelChat("cancel-before-send");
releaseFetch();
assert.equal(await cancelledBeforeSend, "cancel-before-send");
fetchGate = null;
assert.ok(!MockWebSocket.instances.some((socket) => socket.sent.some((frame) => frame.sessionId === "cancel-before-send")));

const beforeHandshake = api.startChat(params("cancel-before-handshake"));
const socket = MockWebSocket.instances.at(-1);
await waitFor(() => socket.sent.some((frame) => frame.sessionId === "cancel-before-handshake"));
await api.cancelChat("cancel-before-handshake");
assert.ok(socket.sent.some((frame) => frame.action === "cancel" && frame.sessionId === "cancel-before-handshake"));
await assert.rejects(api.continueChat(params("cancel-before-handshake")), /Chat already active/);
socket.receive({ type: "complete", success: false, sessionId: "cancel-before-handshake" });
assert.equal(await beforeHandshake, "cancel-before-handshake");

const completed = api.startChat(params("completed"));
await waitFor(() => socket.sent.some((frame) => frame.sessionId === "completed"));
acknowledge(socket, "completed");
await completed;
socket.receive({ type: "complete", success: true, sessionId: "completed" });
socket.close();
assert.equal(received.filter((frame) => frame.type === "complete" && frame.sessionId === "completed").length, 1);

MockWebSocket.autoOpen = false;
const count = MockWebSocket.instances.length;
const opening = api.startChat(params("closed-while-opening")).then(() => null, (error) => error);
await waitFor(() => MockWebSocket.instances.length > count);
api.closeChatWebSocket();
assert.ok(await opening instanceof Error);

MockWebSocket.autoOpen = true;
const fresh = api.startChat(params("fresh"));
await waitFor(() => MockWebSocket.instances.at(-1)?.sent.some((frame) => frame.sessionId === "fresh"));
const latest = MockWebSocket.instances.at(-1);
acknowledge(latest, "fresh");
await fresh;
const eventCount = received.length;
initial.receive({ type: "complete", success: false, sessionId: "fresh" });
initial.close();
assert.equal(received.length, eventCount, "a stale socket must not affect the new connection");
api.closeChatWebSocket();
assert.ok(received.some((frame) => frame.type === "complete" && frame.sessionId === "fresh" && !frame.success));

const startCalls = [];
const continueCalls = [];
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
globalThis.__chatLifecycleApi = {
  startChat(parameters) { const pending = deferred(); startCalls.push({ parameters, ...pending }); return pending.promise; },
  continueChat(parameters) { const pending = deferred(); continueCalls.push({ parameters, ...pending }); return pending.promise; },
  async cancelChat() {},
};
globalThis.__chatLifecycleCreate = (initialize) => {
  let state;
  const get = () => state;
  const set = (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; };
  state = initialize(set, get);
  return { getState: get, setState: set };
};
const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
globalThis.requestAnimationFrame = (callback) => queueMicrotask(callback);
let storeSource = stripTypes(await readFile(new URL("../src/stores/chatStore.ts", import.meta.url), "utf8"));
storeSource = storeSource
  .replace('import { t } from "../i18n/index.js";', 'const t = (text) => text;')
  .replace('import { create } from "zustand";', 'const create = globalThis.__chatLifecycleCreate;')
  .replace('import { api } from "../services/api";', 'const api = globalThis.__chatLifecycleApi;');
const { useChatStore } = await import(`data:text/javascript;base64,${Buffer.from(storeSource).toString("base64")}`);
const state = () => useChatStore.getState();

// Late failure and late session-id success from an old start cannot overwrite
// a replacement stream, even when cancellation happened during startup.
for (const lateOutcome of ["reject", "resolve"]) {
  const offset = startCalls.length;
  const old = state().startNewChatInPane("pane", "/mock", "old", "model");
  await waitFor(() => startCalls.length === offset + 1);
  await state().cancelPane("pane");
  const replacement = state().startNewChatInPane("pane", "/mock", "new", "model");
  await waitFor(() => startCalls.length === offset + 2);
  const currentId = state().getPaneState("pane").streamId;
  startCalls[offset][lateOutcome](lateOutcome === "reject" ? new Error("old failure") : "old-real-id");
  await old;
  assert.equal(state().getPaneState("pane").streamId, currentId);
  assert.equal(state().getPaneState("pane").sessionId, currentId);
  assert.equal(state().getPaneState("pane").error, null);
  assert.equal(state().getPaneState("pane").isStreaming, true);
  startCalls[offset + 1].resolve("new-real-id");
  await replacement;
  assert.equal(state().getPaneState("pane").sessionId, "new-real-id");
}

const oldResume = state().continueExistingChatInPane("resume", "same-session", "/mock", "old", "model");
await waitFor(() => continueCalls.length === 1);
await state().cancelPane("resume");
const newResume = state().continueExistingChatInPane("resume", "same-session", "/mock", "new", "model");
await waitFor(() => continueCalls.length === 2);
continueCalls[0].reject(new Error("stale resume failure"));
await oldResume;
assert.equal(state().getPaneState("resume").isStreaming, true);
assert.equal(state().getPaneState("resume").error, null);
continueCalls[1].resolve("same-session");
await newResume;

const paints = [];
globalThis.requestAnimationFrame = (callback) => paints.push(callback);
const previousCalls = startCalls.length;
const cancelledBeforePaint = state().startNewChatInPane("paint", "/mock", "cancelled", "model");
await state().cancelPane("paint");
paints.shift()();
await cancelledBeforePaint;
assert.equal(startCalls.length, previousCalls, "cancel before paint must never invoke the transport");

console.log("Chat lifecycle checks passed (disconnect, startup cancellation, stale sockets and stale pane requests).");
