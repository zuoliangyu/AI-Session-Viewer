import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (content) => createHash("sha256").update(content).digest("hex");

// Only the canonical Cargo table syntax is needed here. Reject multiline
// strings rather than interpreting a table-looking string as configuration.
function tableLines(text, table) {
  if (text.includes('"""') || text.includes("'''")) throw new Error("Unsupported multiline Cargo configuration");
  let active = false;
  let found = false;
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      const header = /^\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);
      active = header?.[1].trim() === table;
      if (active && found) throw new Error(`Duplicate Cargo table: ${table}`);
      if (active) found = true;
    } else if (active && !line.startsWith("#")) lines.push(line);
  }
  return lines;
}

function inside(base, path) {
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (isAbsolute(path) || !rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Unsafe vendor path: ${path}`);
  return target;
}

async function listFiles(path, prefix = "") {
  const files = [];
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new Error(`Invalid vendor directory: ${path}`);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Vendor symlink is not allowed: ${name}`);
    if (entry.isDirectory()) files.push(...await listFiles(resolve(path, entry.name), `${name}/`));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Invalid vendor entry: ${name}`);
  }
  return files.sort();
}

export async function verifyVendoredPatch(manifest, base = root) {
  if (manifest.schemaVersion !== 1 || !manifest.package || !manifest.version || !manifest.files
    || !Array.isArray(manifest.advisories) || !manifest.advisories.length) throw new Error("Invalid vendor manifest");
  const directory = inside(base, manifest.path);
  const actual = await listFiles(directory);
  const expected = Object.keys(manifest.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Vendor file set changed");
  const modified = [];
  for (const name of expected) {
    const entry = manifest.files[name];
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[a-f0-9]{64}$/.test(entry.upstreamSha256)) throw new Error(`Invalid vendor digest: ${name}`);
    if (digest(await readFile(inside(directory, name))) !== entry.sha256) throw new Error(`Vendor digest mismatch: ${name}`);
    if (entry.sha256 !== entry.upstreamSha256) modified.push(name);
  }
  if (JSON.stringify(modified.sort()) !== JSON.stringify([...manifest.patch.changedFiles].sort())) throw new Error("Unexpected vendor source modifications");
  const patch = inside(base, manifest.patch.path);
  if ((await lstat(patch)).isSymbolicLink() || digest(await readFile(patch)) !== manifest.patch.sha256) throw new Error("Vendor patch digest mismatch");
  const cargo = await readFile(inside(directory, "Cargo.toml"), "utf8");
  const packageSection = tableLines(cargo, "package");
  if (!packageSection.includes(`name = "${manifest.package}"`) || !packageSection.includes(`version = "${manifest.version}"`)) throw new Error("Vendor package identity mismatch");
  // Ensure Cargo actually uses the audited copy, rather than merely keeping it
  // beside a registry dependency. Match only the explicit patch table.
  const workspace = await readFile(inside(base, "Cargo.toml"), "utf8");
  const patchSection = tableLines(workspace, "patch.crates-io");
  if (!patchSection.includes(`${manifest.package} = { path = "${manifest.path}" }`)) throw new Error("Audited vendor patch is not active in Cargo.toml");
  console.log(`[vendor] ${manifest.package}@${manifest.version}: ${expected.length} file hashes and upstream patch verified`);
  return manifest;
}

export async function loadVerifiedPatches() {
  const manifest = JSON.parse(await readFile(new URL("../vendor/glib-0.18.5.patch.json", import.meta.url), "utf8"));
  return [await verifyVendoredPatch(manifest)];
}
