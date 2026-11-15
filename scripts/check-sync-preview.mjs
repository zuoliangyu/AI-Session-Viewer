import assert from "node:assert/strict";
import { createSyncPreviewGuard } from "../src/services/syncPreview.ts";

// Node 24 原生擦除类型，使用真实预览守卫；请求与写入都只发生在内存中。
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function previewClient() {
  const guard = createSyncPreviewGuard();
  const state = { data: null, error: null, loading: false };
  const writes = [];
  return {
    guard, state, writes,
    async load(sourceId, targetId, response) {
      const version = guard.begin(sourceId, targetId);
      state.loading = true;
      state.error = null;
      try {
        const data = await response;
        if (guard.accept(version)) state.data = data;
      } catch (error) {
        if (guard.isCurrent(version)) state.error = error.message;
      } finally {
        if (guard.isCurrent(version)) state.loading = false;
      }
    },
    apply(sourceId, targetId) {
      if (!guard.tryStartSync(sourceId, targetId)) return false;
      writes.push({ targetId, config: state.data.config });
      return true;
    },
  };
}

// A -> B 慢请求不能覆盖 C -> B 的新预览，也不能借用 C 的身份写入 A 的配置。
const client = previewClient();
const oldSource = deferred();
const newSource = deferred();
const oldLoad = client.load("A", "B", oldSource.promise);
assert.equal(client.apply("A", "B"), false, "No writes before preview completes");
client.guard.invalidate();
const newLoad = client.load("C", "B", newSource.promise);
newSource.resolve({ config: { command: "from-C" } });
await newLoad;
oldSource.resolve({ config: { command: "from-A" } });
await oldLoad;
assert.deepEqual(client.state.data, { config: { command: "from-C" } });
assert.equal(client.apply("A", "B"), false, "A preview cannot reuse C's completed preview");
assert.equal(client.apply("C", "D"), false, "A different target requires its own preview");
assert.equal(client.apply("C", "B"), true);
assert.equal(client.apply("C", "B"), false, "Rapid repeated clicks cannot submit twice");
assert.deepEqual(client.writes, [{ targetId: "B", config: { command: "from-C" } }]);
assert.equal(client.guard.isSyncing(), true);
client.guard.finishSync();

// 同一节点对的刷新也必须有请求世代；旧错误不能停止新请求的 loading 或污染错误提示。
const oldRefresh = deferred();
const newRefresh = deferred();
const oldRefreshLoad = client.load("C", "B", oldRefresh.promise);
const newRefreshLoad = client.load("C", "B", newRefresh.promise);
oldRefresh.reject(new Error("stale connection failure"));
await oldRefreshLoad;
assert.equal(client.state.loading, true);
assert.equal(client.state.error, null);
assert.equal(client.apply("C", "B"), false);
newRefresh.resolve({ config: { command: "refreshed-C" } });
await newRefreshLoad;
assert.equal(client.state.loading, false);
assert.deepEqual(client.state.data, { config: { command: "refreshed-C" } });

// 节点切换或卸载立即撤销预览身份，早于下一次 effect 发起请求。
client.guard.invalidate();
assert.equal(client.apply("C", "B"), false);
const removedDialog = deferred();
const removedLoad = client.load("C", "D", removedDialog.promise);
client.guard.invalidate();
removedDialog.resolve({ config: { command: "unmounted" } });
await removedLoad;
assert.equal(client.apply("C", "D"), false);
assert.deepEqual(client.state.data, { config: { command: "refreshed-C" } });

// 写入完成后的刷新仍不能在本次写入释放锁之前允许第二次提交。
const finalVersion = client.guard.begin("C", "B");
assert.equal(client.guard.accept(finalVersion), true);
assert.equal(client.guard.tryStartSync("C", "B"), true);
const afterWrite = client.guard.begin("C", "B");
assert.equal(client.guard.accept(afterWrite), true);
assert.equal(client.guard.canSync("C", "B"), false);
client.guard.finishSync();
assert.equal(client.guard.canSync("C", "B"), true);

console.log("Sync preview regression checks passed");
