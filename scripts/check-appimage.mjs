import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
const pkg = await readJson("../package.json");
const lock = await readJson("../package-lock.json");
const version = pkg.devDependencies["@tauri-apps/cli"];
assert.match(version, /^\d+\.\d+\.\d+$/, "Pin the CLI so CI/local AppImage packaging uses the same bundler");
assert.equal(lock.packages[""].devDependencies["@tauri-apps/cli"], version);
assert.equal(lock.packages["node_modules/@tauri-apps/cli"].version, version);
const [major, minor, patch] = version.split(".").map(Number);
assert.ok(major === 2 && (minor > 11 || (minor === 11 && patch >= 4)), "Tauri CLI >= 2.11.4 is needed for relative .DirIcon and .desktop links (tauri#15596)");
for (const [name, entry] of Object.entries(lock.packages)) {
  if (name.startsWith("node_modules/@tauri-apps/cli-linux-")) {
    assert.equal(entry.version, version, `Linux bundler does not match the CLI pin: ${name}`);
  }
}
console.log(`AppImage packaging dependency check passed: Tauri CLI ${version}. Linux artifact validation remains manual.`);
