import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Execute the production store with native type stripping. Deferred API calls
// paginate deterministic records in memory, without loading user session files.
const calls = [];
const records = Array.from({ length: 1203 }, (_, index) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  source: "claude", projectId: index < 600 ? "project-a" : "project-b",
  sessionId: "session", filePath: "/session.jsonl", model: "model-a",
  inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens: 3, costUsd: 0.01, isPriced: true, durationMs: 10,
  messageUuid: `message-${index + 1}`,
}));
globalThis.__requestLogCheckApi = {
  getRequestLog(source, filter) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ source, filter, resolve, reject });
    return promise;
  },
};
function reply(call, overrides = {}) {
  const filtered = records.filter((record) =>
    (!call.filter.projectId || call.filter.projectId === record.projectId) &&
    (!call.filter.model || call.filter.model === record.model));
  const page = call.filter.page ?? 0;
  const pageSize = call.filter.pageSize ?? 500;
  call.resolve({
    records: filtered.slice(page * pageSize, (page + 1) * pageSize),
    total: filtered.length, page, pageSize,
    hasMore: (page + 1) * pageSize < filtered.length,
    totalCostUsd: filtered.length * 0.01, totalInputTokens: filtered.length,
    totalOutputTokens: filtered.length * 2, totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0, hasUnpricedUsage: false,
    ...overrides,
  });
}
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
} });
const stubs = {
  "../services/api": "export const api = globalThis.__requestLogCheckApi;",
  "../utils/perfDiagnostics": `export const PERF_DIAGNOSTICS_ENABLED = false;
    export const getMessagesPerfFields = () => ({});
    export const markPendingMessageCommit = () => {};
    export const nextPerfTraceId = () => 'test';
    export const recordPerfDiagnostic = () => {};`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier)) return { url: "asv-request-log-test:" + specifier, shortCircuit: true };
    if (specifier === "../utils/dateTime") return {
      url: new URL("../src/utils/dateTime.ts", import.meta.url).href, shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("asv-request-log-test:")) return {
      format: "module", source: stubs[url.slice("asv-request-log-test:".length)], shortCircuit: true,
    };
    return nextLoad(url, context);
  },
});

try {
  const { useAppStore } = await import("../src/stores/appStore.ts");
  const state = () => useAppStore.getState();
  const load = async (filter) => {
    const request = state().loadRequestLog(filter);
    const call = calls.at(-1);
    reply(call);
    await request;
    return call;
  };

  await load();
  assert.equal(state().requestLog.length, 500);
  assert.equal(state().requestLog[0].messageUuid, "message-1");
  assert.equal(state().requestLogPage, 0);
  assert.equal(state().requestLogPageSize, 500);
  assert.equal(state().requestLogHasMore, true);
  assert.equal(state().requestLogTotal, 1203);
  assert.ok(Math.abs(state().requestLogTotalCost - 12.03) < 1e-10);

  await load({ page: state().requestLogPage + 1 });
  assert.equal(state().requestLogPage, 1);
  assert.equal(state().requestLog[0].messageUuid, "message-501", "The first request after the old hard limit is reachable");
  assert.equal(state().requestLog.length, 500, "Pages replace rows instead of accumulating all records");
  await load({ page: state().requestLogPage + 1 });
  assert.equal(state().requestLogPage, 2);
  assert.equal(state().requestLog.at(-1).messageUuid, "message-1203");
  assert.equal(state().requestLog.length, 203);
  assert.equal(state().requestLogHasMore, false);
  await load({ page: state().requestLogPage - 1 });
  assert.equal(state().requestLog[0].messageUuid, "message-501");

  // Failure preserves the visible page and retries the failed target page.
  const failed = state().loadRequestLog({ page: 2 });
  assert.equal(state().requestLogLoading, true);
  assert.equal(state().requestLogPage, 1);
  calls.at(-1).reject(new Error("temporary page failure"));
  await failed;
  assert.equal(state().requestLogLoading, false);
  assert.equal(state().requestLogError, "temporary page failure");
  assert.equal(state().requestLog[0].messageUuid, "message-501");
  const retried = await load();
  assert.equal(retried.filter.page, 2);
  assert.equal(state().requestLogError, null);

  // Applying filters always returns to page zero, even with an old page value.
  const oldPage = state().loadRequestLog({ page: 1 });
  const oldPageCall = calls.at(-1);
  const filtered = state().loadRequestLog({ projectId: "project-b", page: 2 });
  const filteredCall = calls.at(-1);
  assert.equal(filteredCall.filter.page, 0);
  assert.equal(state().requestLog.length, 0, "Old filter rows are cleared before the response");
  reply(oldPageCall);
  await oldPage;
  assert.equal(state().requestLogLoading, true);
  assert.equal(state().requestLog.length, 0);
  reply(filteredCall);
  await filtered;
  assert.equal(state().requestLog[0].messageUuid, "message-601");
  assert.equal(state().requestLogTotal, 603);
  await load({ page: 1 });
  const cleared = await load({ projectId: null, sessionId: null, model: null, startDate: null, endDate: null });
  assert.equal(cleared.filter.page, 0);
  assert.equal(state().requestLogTotal, 1203);

  // Page requests arriving out of order cannot roll back rows or clear errors.
  const older = state().loadRequestLog({ page: 1 });
  const olderCall = calls.at(-1);
  const newer = state().loadRequestLog({ page: 2 });
  const newerCall = calls.at(-1);
  reply(newerCall);
  await newer;
  olderCall.reject(new Error("obsolete page error"));
  await older;
  assert.equal(state().requestLogPage, 2);
  assert.equal(state().requestLogError, null);

  // Explicit filter updates invalidate an in-flight page even before reloading.
  const pendingFilter = state().loadRequestLog({ page: 1 });
  const pendingFilterCall = calls.at(-1);
  state().setRequestLogFilter({ model: "model-a" });
  assert.equal(state().requestLogFilter.page, 0);
  assert.equal(state().requestLogPage, 0);
  reply(pendingFilterCall);
  await pendingFilter;
  assert.equal(state().requestLog.length, 0);
  assert.equal(state().requestLogLoading, false);

  // A -> B -> A must not revive either successful or failed requests from A.
  for (const failure of [false, true]) {
    const obsolete = state().loadRequestLog();
    const obsoleteCall = calls.at(-1);
    state().setSource("codex");
    state().setSource("claude");
    assert.equal(state().requestLogFilter.page, 0);
    assert.equal(state().requestLogHasMore, false);
    const current = state().loadRequestLog();
    const currentCall = calls.at(-1);
    if (failure) obsoleteCall.reject(new Error("obsolete source error"));
    else reply(obsoleteCall);
    await obsolete;
    assert.equal(state().requestLogLoading, true);
    assert.equal(state().requestLog.length, 0);
    assert.equal(state().requestLogError, null);
    reply(currentCall);
    await current;
  }

  await load({ page: 1 });
  const oldTimeZone = state().loadRequestLog({ page: 2 });
  const oldTimeZoneCall = calls.at(-1);
  state().setTimeZone("UTC");
  assert.equal(state().requestLogFilter.page, 0);
  reply(oldTimeZoneCall);
  await oldTimeZone;
  assert.equal(state().requestLog.length, 0);
  assert.equal((await load()).filter.timeZone, "UTC");

  // The backend is authoritative about the returned page and page size.
  const serverPage = state().loadRequestLog({ page: 2 });
  reply(calls.at(-1), { page: 1, pageSize: 200, hasMore: true, records: records.slice(200, 400) });
  await serverPage;
  assert.equal(state().requestLogPage, 1);
  assert.equal(state().requestLogPageSize, 200);
  assert.equal(state().requestLogFilter.page, 1);
  assert.equal(state().requestLogFilter.pageSize, 200);
  assert.equal((await load({ page: 2 })).filter.pageSize, 200);

  console.log("Request log pagination regression checks passed");
} finally {
  hooks.deregister();
  if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
  else delete globalThis.localStorage;
  delete globalThis.__requestLogCheckApi;
}
