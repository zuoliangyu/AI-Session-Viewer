import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import ts from "typescript";
import {
  buildSessionMessageUrl, getDisplayMessageId, getFocusedMessageWindow,
  navigateToMessage, readMessageTarget,
} from "../src/services/messageNavigation.ts";

// Real navigation and store code, with a 10k-message session represented by
// deterministic in-memory ranges. No session files, network, or compilation.
const requests = [];
const deferred = (method, args) => new Promise((resolve, reject) => requests.push({ method, args, resolve, reject }));
globalThis.__messageNavigationApi = {
  getMessageLocation: (...args) => deferred("location", args),
  getMessagesRange: (...args) => deferred("range", args),
};
const invocations = [];
globalThis.__messageNavigationInvoke = async (command, args) => {
  invocations.push({ command, args });
  return { messageIndex: 123 };
};
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
} });
const stubs = {
  "../services/api": "export const api = globalThis.__messageNavigationApi;",
  "@tauri-apps/api/core": "export const invoke = globalThis.__messageNavigationInvoke;",
  "./nodeConfig": "export const getApiBaseUrl = () => 'https://memory.test'; export const getApiToken = () => null;",
  "../i18n/index.js": "export const t = (key) => key;",
  "../utils/perfDiagnostics": `export const PERF_DIAGNOSTICS_ENABLED = false;
    export const getMessagesPerfFields = () => ({});
    export const markPendingMessageCommit = () => {};
    export const nextPerfTraceId = () => 'test';
    export const recordPerfDiagnostic = () => {};`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier)) return { url: "asv-navigation-test:" + specifier, shortCircuit: true };
    if (specifier === "../utils/dateTime") return {
      url: new URL("../src/utils/dateTime.ts", import.meta.url).href, shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("asv-navigation-test:")) return {
      format: "module", source: stubs[url.slice("asv-navigation-test:".length)], shortCircuit: true,
    };
    return nextLoad(url, context);
  },
});
const makeMessage = (index) => ({
  uuid: `id-${index}`, role: ["user", "assistant", "tool"][index % 3],
  parentUuid: null, timestamp: null, model: null,
  content: [{ type: "text", text: `message ${index}` }],
});
const range = (start, end) => ({
  start, end, total: 10000,
  messages: Array.from({ length: end - start }, (_, index) => makeMessage(start + index)),
});
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const last = () => requests.at(-1);
const replyRange = () => {
  const request = last();
  assert.equal(request.method, "range");
  request.resolve(range(request.args[2], request.args[3]));
};

try {
  const { useAppStore } = await import("../src/stores/appStore.ts");
  const state = () => useAppStore.getState();
  const openWindow = (filePath = "A", start = 9970, end = 10000) => useAppStore.setState({
    source: "claude", selectedProject: "project", selectedFilePath: filePath,
    messagesGeneration: state().messagesGeneration + 1,
    messages: range(start, end).messages, messagesTotal: 10000,
    loadedStart: start, loadedEnd: end, messagesHasMore: start > 0,
    messagesHasNewer: end < 10000, messagesLoading: false, messagesError: null,
  });
  const navigate = (id, controller = new AbortController()) => navigateToMessage(
    state, globalThis.__messageNavigationApi.getMessageLocation, id, controller.signal,
  );

  // One URL format for search, bookmarks and billing, including special chars.
  const project = "project %/中文";
  const path = "C:/session %/文件.jsonl";
  const id = 'message +%&"[]/#';
  const url = new URL(buildSessionMessageUrl(project, path, id, { matchedOnly: true, searchQuery: "a & b" }), "https://example.test");
  assert.ok(url.pathname.includes(encodeURIComponent(path)));
  assert.equal(readMessageTarget(url.search, url.hash), id);
  assert.equal(url.searchParams.get("matchedOnly"), "1");
  assert.equal(url.searchParams.get("searchQuery"), "a & b");
  assert.equal(readMessageTarget("", "#m=legacy-assistant"), "legacy-assistant");
  assert.equal(readMessageTarget("", "#m=legacy+id&part"), "legacy+id&part");
  assert.equal(readMessageTarget("", "#m=legacy%20id"), "legacy id");
  assert.equal(readMessageTarget("?scrollTo=bookmark-user"), "bookmark-user");
  assert.equal(readMessageTarget("?scrollTo=new", "#m=old"), "new");
  assert.equal(readMessageTarget("", "#unrelated"), null);
  assert.equal(buildSessionMessageUrl("project", "A"), "/projects/project/session/A");

  // Old user, assistant and tool messages each use one lookup and one window.
  for (const index of [99, 100, 101]) {
    openWindow();
    const before = requests.length;
    const pending = navigate(`id-${index}`);
    assert.deepEqual(last().args, ["claude", "A", `id-${index}`]);
    last().resolve({ messageIndex: index });
    await settle();
    assert.deepEqual(last().args, ["claude", "A", index - 15, index + 16]);
    replyRange();
    const result = await pending;
    assert.deepEqual(result, { status: "found", messageIndex: index, generation: state().messagesGeneration });
    assert.equal(requests.length - before, 2, "Navigation never fetches all preceding pages");
    assert.equal(state().messages.length, 31);
    assert.equal(state().messages[index - state().loadedStart].role, makeMessage(index).role);
  }

  // Already loaded targets need neither a lookup nor another range request.
  const beforeLoaded = requests.length;
  assert.equal((await navigate("id-101")).messageIndex, 101);
  assert.equal(requests.length, beforeLoaded);

  // A focused search slice retains the original absolute indices for anchors.
  const focused = getFocusedMessageWindow(range(90, 115).messages, 90, "id-100");
  assert.equal(focused.offset, 99);
  assert.deepEqual(focused.messages.map((message) => message.uuid), ["id-99", "id-100", "id-101"]);
  assert.equal(focused.offset + focused.messages.findIndex((message) => message.uuid === "id-100"), 100);
  assert.equal(getFocusedMessageWindow(range(90, 115).messages, 90, "missing").messages.length, 0);
  const synthetic = { ...makeMessage(99), uuid: null };
  assert.equal(getDisplayMessageId(synthetic, 99), "user-99");
  const syntheticWindow = [makeMessage(98), synthetic, makeMessage(100)];
  assert.equal(getFocusedMessageWindow(syntheticWindow, 98, "user-99").offset, 99);

  // Execute the page's real anchor derivation, including its memo dependencies.
  // A focused slice starts after the loaded window but must retain the same ID.
  const pageSource = await readFile(new URL("../src/components/message/MessagesPage.tsx", import.meta.url), "utf8");
  const pageAst = ts.createSourceFile("MessagesPage.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let anchorDeclaration;
  const findAnchors = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "userDots") anchorDeclaration = node;
    ts.forEachChild(node, findAnchors);
  };
  findAnchors(pageAst);
  assert.ok(anchorDeclaration, "MessagesPage must expose its current-window anchor derivation");
  const deriveAnchors = new Function("displayedWindow", "loadedStart", "timeZone", "t", "extractUserQuestionPreview", "formatTime", "useMemo",
    `${stripTypeScriptTypes(`function derive() { const ${anchorDeclaration.getText(pageAst)}; return userDots; }`)} return derive();`);
  const anchorsFor = (window) => deriveAnchors(window, 98, "UTC", (key) => key,
    (message) => message.content[0].text, (timestamp) => timestamp, (callback) => callback());
  const fullAnchors = anchorsFor({ messages: syntheticWindow, offset: 98 });
  const focusedAnchors = anchorsFor(getFocusedMessageWindow(syntheticWindow, 98, "user-99"));
  assert.deepEqual(focusedAnchors, fullAnchors);
  assert.equal(focusedAnchors[0].id, getDisplayMessageId(synthetic, 99));
  assert.deepEqual(anchorsFor(getFocusedMessageWindow(syntheticWindow, 98, "missing")), []);

  openWindow();
  const missing = navigate("deleted-id");
  const beforeMissing = requests.length;
  last().resolve({ messageIndex: null });
  assert.deepEqual(await missing, { status: "missing" });
  assert.equal(requests.length, beforeMissing);

  // Leaving a page while the index is pending prevents the window request.
  const controller = new AbortController();
  const cancelled = navigate("id-100", controller);
  const beforeCancel = requests.length;
  controller.abort();
  last().resolve({ messageIndex: 100 });
  assert.deepEqual(await cancelled, { status: "cancelled" });
  assert.equal(requests.length, beforeCancel);

  // Session and source A -> B -> A both invalidate the old target resolution.
  for (const switchSession of [true, false]) {
    openWindow();
    const pending = navigate("id-100");
    const obsolete = last();
    if (switchSession) { openWindow("B"); openWindow("A"); }
    else { state().setSource("codex"); state().setSource("claude"); }
    obsolete.reject(new Error("old lookup failure"));
    assert.deepEqual(await pending, { status: "cancelled" });
  }

  // A switch during the range request cannot install the old window or scroll.
  openWindow();
  const duringRange = navigate("id-100");
  last().resolve({ messageIndex: 100 });
  await settle();
  const obsoleteRange = last();
  openWindow("B");
  obsoleteRange.resolve(range(85, 116));
  assert.deepEqual(await duringRange, { status: "cancelled" });
  assert.equal(state().selectedFilePath, "B");
  assert.equal(state().loadedStart, 9970);

  openWindow();
  const lookupFailure = navigate("id-100");
  last().reject(new Error("index unavailable"));
  await assert.rejects(lookupFailure, /index unavailable/);

  const rangeFailure = navigate("id-100");
  last().resolve({ messageIndex: 100 });
  await settle();
  const savedConsoleError = console.error;
  console.error = () => {};
  try {
    last().reject(new Error("window unavailable"));
    await assert.rejects(rangeFailure, /window unavailable/);
  } finally { console.error = savedConsoleError; }
  const retry = navigate("id-100");
  last().resolve({ messageIndex: 100 });
  await settle();
  replyRange();
  assert.equal((await retry).status, "found");
  assert.equal(state().messagesError, null);

  // A deleted/replaced target between lookup and fetch is not highlighted.
  openWindow();
  const changed = navigate("id-100");
  last().resolve({ messageIndex: 100 });
  await settle();
  const changedRange = range(85, 116);
  changedRange.messages[15].uuid = "replacement";
  last().resolve(changedRange);
  assert.deepEqual(await changed, { status: "missing" });

  const tauriApi = await import("../src/services/tauriApi.ts");
  assert.deepEqual(await tauriApi.getMessageLocation("claude", path, id), { messageIndex: 123 });
  assert.deepEqual(invocations.at(-1), {
    command: "get_message_location", args: { source: "claude", filePath: path, messageId: id },
  });

  const savedFetch = globalThis.fetch;
  const fetches = [];
  globalThis.fetch = async (url) => {
    fetches.push(new URL(url));
    return new Response(JSON.stringify({ messageIndex: 321 }), { status: 200 });
  };
  try {
    const webApi = await import("../src/services/webApi.ts");
    assert.deepEqual(await webApi.getMessageLocation("codex", path, id), { messageIndex: 321 });
    assert.equal(fetches.at(-1).pathname, "/api/messages/location");
    assert.equal(fetches.at(-1).searchParams.get("source"), "codex");
    assert.equal(fetches.at(-1).searchParams.get("filePath"), path);
    assert.equal(fetches.at(-1).searchParams.get("messageId"), id);
  } finally { globalThis.fetch = savedFetch; }

  console.log("Message deep-link navigation regression checks passed");
} finally {
  hooks.deregister();
  if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
  else delete globalThis.localStorage;
  delete globalThis.__messageNavigationApi;
  delete globalThis.__messageNavigationInvoke;
}
