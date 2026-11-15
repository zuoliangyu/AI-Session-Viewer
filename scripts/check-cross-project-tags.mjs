import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Run the real store with Node's native type stripping and an in-memory API.
const calls = [];
globalThis.__tagCheckApi = {
  getCrossProjectTags(source) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ source, resolve, reject });
    return promise;
  },
  updateSessionMeta: async () => {},
  getAllTags: async () => [],
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: () => null,
  setItem: () => {},
} });
const stubs = {
  "../services/api": "export const api = globalThis.__tagCheckApi;",
  "../utils/perfDiagnostics": `export const PERF_DIAGNOSTICS_ENABLED = false;
    export const getMessagesPerfFields = () => ({});
    export const markPendingMessageCommit = () => {};
    export const nextPerfTraceId = () => 'test';
    export const recordPerfDiagnostic = () => {};`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier)) return { url: "asv-tags-test:" + specifier, shortCircuit: true };
    if (specifier === "../utils/dateTime") return {
      url: new URL("../src/utils/dateTime.ts", import.meta.url).href, shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("asv-tags-test:")) return {
      format: "module", source: stubs[url.slice("asv-tags-test:".length)], shortCircuit: true,
    };
    return nextLoad(url, context);
  },
});

try {
  const { useAppStore } = await import("../src/stores/appStore.ts");
  const state = () => useAppStore.getState();

  for (const source of ["claude", "codex", "grok", "omp"]) {
    state().setSource(source);
    assert.equal(state().crossProjectTagsStatus, "idle");
    const before = calls.length;
    const first = state().loadCrossProjectTags();
    const second = state().loadCrossProjectTags();
    assert.equal(calls.length, before + 1, "Concurrent page effects share the request");
    calls.at(-1).resolve({});
    await Promise.all([first, second]);
    assert.equal(state().crossProjectTagsStatus, "loaded");
    for (let i = 0; i < 10; i++) await state().loadCrossProjectTags();
    assert.equal(calls.length, before + 1, `${source}: an empty result is already loaded`);
  }

  state().setSource("claude");
  const failed = state().loadCrossProjectTags();
  calls.at(-1).reject(new Error("temporary read failure"));
  await failed;
  assert.equal(state().crossProjectTagsStatus, "error");
  assert.equal(state().crossProjectTagsError, "temporary read failure");
  const beforeRetry = calls.length;
  await state().loadCrossProjectTags();
  assert.equal(calls.length, beforeRetry, "An error must not cause automatic retry loops");
  const retry = state().loadCrossProjectTags(true);
  calls.at(-1).resolve({ project: ["fixed"] });
  await retry;
  assert.deepEqual(state().crossProjectTags, { project: ["fixed"] });
  assert.equal(state().crossProjectTagsError, null);

  // Switching away and back must invalidate both old data and old error/finally handlers.
  const old = state().loadCrossProjectTags(true);
  const oldResponse = calls.at(-1);
  state().setSource("codex");
  state().setSource("claude");
  const current = state().loadCrossProjectTags();
  const currentResponse = calls.at(-1);
  oldResponse.reject(new Error("stale error"));
  await old;
  assert.equal(state().crossProjectTagsStatus, "loading");
  assert.equal(state().crossProjectTagsError, null);
  currentResponse.resolve({ fresh: ["latest"] });
  await current;

  const staleSuccess = state().loadCrossProjectTags(true);
  const staleResponse = calls.at(-1);
  state().setSource("omp");
  staleResponse.resolve({ wrongSource: ["old"] });
  await staleSuccess;
  assert.equal(state().crossProjectTagsStatus, "idle");
  assert.deepEqual(state().crossProjectTags, {});

  // Editing tags must not leave the completed cache hiding the new tag on navigation.
  useAppStore.setState({ selectedProject: "project", sessions: [], crossProjectTagsStatus: "loaded" });
  await state().updateSessionMeta("session", null, ["new tag"]);
  assert.equal(state().crossProjectTagsStatus, "idle");
  const edited = state().loadCrossProjectTags();
  calls.at(-1).resolve({ project: ["new tag"] });
  await edited;
  assert.deepEqual(state().crossProjectTags, { project: ["new tag"] });

  console.log("Cross-project tag regression checks passed");
} finally {
  hooks.deregister();
  delete globalThis.__tagCheckApi;
}
