import assert from "node:assert/strict";
import { parseCargoLock, validateExceptions, classifyFinding, queryRustPackages } from "./audit-dependencies.mjs";

const pkg = { name: "example", version: "1.2.3" };
const lock = 'version = 4\n\n[[package]]\nname = "example"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';
assert.deepEqual(parseCargoLock(lock), [pkg]);
assert.deepEqual(parseCargoLock(lock + lock.slice(lock.indexOf("[[package]]")).replace("[[package]]", " [[package]] # second").replace('"example"', '"second"')), [pkg, { ...pkg, name: "second" }]);
assert.throws(() => parseCargoLock(lock + 'name = "duplicate"\n'), /duplicate/);
assert.throws(() => parseCargoLock(lock.replace("registry+https://github.com/rust-lang/crates.io-index", "git+https://example.test/pkg")), /Unreviewed/);
assert.throws(() => parseCargoLock("version = 4\n"), /No registry/);
assert.throws(() => parseCargoLock(lock, [{ package: pkg.name, version: pkg.version }]), /does not use/);
const exception = { ...pkg, advisory: "RUSTSEC-2026-0001", reason: "Specific documented upstream blocker", expires: "2026-12-15" };
validateExceptions([exception], new Date("2026-11-15"));
assert.throws(() => validateExceptions([exception], new Date("2026-12-16")), /Expired/);
assert.throws(() => validateExceptions([{ ...exception, version: "*" }]), /Invalid/);
const advisory = { id: "GHSA-abcd-abcd-abcd", aliases: [exception.advisory] };
assert.equal(classifyFinding(pkg, advisory, [exception]).kind, "exception");
assert.equal(classifyFinding({ ...pkg, version: "1.2.4" }, advisory, [exception]).kind, "vulnerability");
const patch = { package: pkg.name, version: pkg.version, advisories: [exception.advisory] };
assert.equal(classifyFinding(pkg, advisory, [], [patch]).kind, "remediated");
assert.equal(classifyFinding(pkg, { id: "RUSTSEC-2026-9999" }, [], [patch]).kind, "vulnerability");
assert.equal(classifyFinding(pkg, { ...advisory, withdrawn: "2026-11-01" }, []).kind, "withdrawn");
assert.equal(classifyFinding(pkg, { ...advisory, database_specific: { informational: "unmaintained" } }, []).kind, "maintenance");
assert.equal(classifyFinding(pkg, { ...advisory, database_specific: { informational: "unsound" } }, []).kind, "vulnerability");
assert.equal(classifyFinding(pkg, { ...advisory, affected: [{ package: { name: pkg.name, ecosystem: "crates.io" }, database_specific: { informational: "unmaintained" } }] }, []).kind, "maintenance");
let batches = 0;
const results = await queryRustPackages([pkg], async (path, body) => {
  if (path === "querybatch") {
    batches++;
    if (batches === 1) return { results: [{ vulns: [{ id: advisory.id }], next_page_token: "more" }] };
    assert.equal(body.queries[0].page_token, "more");
    return { results: [{}] };
  }
  return advisory;
});
assert.equal(batches, 2);
assert.equal(results.length, 1);
await assert.rejects(queryRustPackages([pkg], async () => ({ results: [] })), /Incomplete/);
for (const result of ["upstream error", [], { error: "upstream error" }, { next_page_token: 1 }, { vulns: [null] }]) {
  await assert.rejects(queryRustPackages([pkg], async () => ({ results: [result] })), /Invalid|Missing/);
}
await assert.rejects(queryRustPackages([pkg], async () => { throw new Error("offline"); }), /offline/);
console.log("Dependency audit failure, pagination and exception checks passed");
