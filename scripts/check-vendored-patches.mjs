import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyVendoredPatch } from "./verify-vendored-patches.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const directory = await mkdtemp(join(tmpdir(), "asv-vendor-check-"));
const vendor = join(directory, "example");
await mkdir(vendor);
const cargo = '[package]\nname = "example"\nversion = "1.0.0"\n';
const workspace = '[patch.crates-io]\nexample = { path = "example" }\n';
const manifest = {
  schemaVersion: 1, package: "example", version: "1.0.0", path: "example",
  advisories: ["RUSTSEC-2026-0001"],
  patch: { path: "fix.patch", sha256: hash("fix"), changedFiles: ["lib.rs"] },
  files: {
    "Cargo.toml": { upstreamSha256: hash(cargo), sha256: hash(cargo) },
    "lib.rs": { upstreamSha256: hash("old"), sha256: hash("fixed") },
  },
};
try {
  await writeFile(join(directory, "Cargo.toml"), workspace);
  await writeFile(join(directory, "fix.patch"), "fix");
  await writeFile(join(vendor, "Cargo.toml"), cargo);
  await writeFile(join(vendor, "lib.rs"), "fixed");
  await verifyVendoredPatch(manifest, directory);
  await writeFile(join(vendor, "lib.rs"), "tampered");
  await assert.rejects(verifyVendoredPatch(manifest, directory), /digest mismatch/);
  await writeFile(join(vendor, "lib.rs"), "fixed");
  await writeFile(join(vendor, "unexpected.rs"), "extra");
  await assert.rejects(verifyVendoredPatch(manifest, directory), /file set/);
  await rm(join(vendor, "unexpected.rs"));
  await writeFile(join(directory, "fix.patch"), "tampered");
  await assert.rejects(verifyVendoredPatch(manifest, directory), /patch digest/);
  await writeFile(join(directory, "fix.patch"), "fix");
  await writeFile(join(directory, "Cargo.toml"), "[workspace]\n");
  await assert.rejects(verifyVendoredPatch(manifest, directory), /not active/);
  await writeFile(join(directory, "Cargo.toml"), '[patch.crates-io]\n [workspace.metadata.not_a_patch]\nexample = { path = "example" }\n');
  await assert.rejects(verifyVendoredPatch(manifest, directory), /not active/);
  await writeFile(join(directory, "Cargo.toml"), '[workspace.metadata]\nfake = \'\'\'\n[patch.crates-io]\nexample = { path = "example" }\n\'\'\'');
  await assert.rejects(verifyVendoredPatch(manifest, directory), /Unsupported multiline/);
  await assert.rejects(verifyVendoredPatch({ ...manifest, path: "../escape" }, directory), /Unsafe vendor path/);
  console.log("Vendor integrity, extra-file, patch and configuration checks passed");
} finally {
  for (const file of ["Cargo.toml", "lib.rs", "unexpected.rs"]) await rm(join(vendor, file), { force: true });
  await rmdir(vendor);
  for (const file of ["Cargo.toml", "fix.patch"]) await rm(join(directory, file), { force: true });
  await rmdir(directory);
}
