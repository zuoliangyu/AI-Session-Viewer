import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { loadVerifiedPatches } from "./verify-vendored-patches.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const localCrates = new Set(["ai-session-viewer", "session-core", "session-web"]);

// Cargo generates these fields as plain quoted strings. Reject unknown sources
// instead of silently skipping git/private dependencies.
export function parseCargoLock(text, vendored = []) {
  if (!/^version = [34]\s*$/m.test(text)) throw new Error("Unsupported Cargo.lock format");
  const packages = [];
  let pkg;
  const finish = () => {
    if (!pkg) return;
    if (!pkg.name || !pkg.version) throw new Error("Incomplete Cargo.lock package");
    if (!pkg.source && localCrates.has(pkg.name)) return;
    const patch = vendored.find((item) => item.package === pkg.name && item.version === pkg.version);
    if (patch && pkg.source) throw new Error(`Cargo.lock does not use the verified patch for ${pkg.name}`);
    if (!pkg.source && patch) {
      packages.push({ name: pkg.name, version: pkg.version });
      return;
    }
    if (pkg.source !== "registry+https://github.com/rust-lang/crates.io-index") {
      throw new Error(`Unreviewed Cargo source: ${pkg.name}@${pkg.version}`);
    }
    packages.push({ name: pkg.name, version: pkg.version });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[\[package\]\]\s*(?:#.*)?$/.test(line)) { finish(); pkg = {}; continue; }
    if (line.startsWith("[")) throw new Error("Unsupported Cargo.lock table");
    const match = /^(name|version|source)\s*=\s*("[^"\\]*")\s*(?:#.*)?$/.exec(line);
    if (pkg && /^(name|version|source)\s*=/.test(line)) {
      if (!match || Object.hasOwn(pkg, match[1])) throw new Error("Invalid or duplicate Cargo.lock field");
      pkg[match[1]] = JSON.parse(match[2]);
    }
  }
  finish();
  if (!packages.length) throw new Error("No registry packages found in Cargo.lock");
  for (const patch of vendored) {
    if (packages.filter((pkg) => pkg.name === patch.package && pkg.version === patch.version).length !== 1) {
      throw new Error(`Verified patch missing or duplicated in Cargo.lock: ${patch.package}`);
    }
  }
  return packages;
}

export function validateExceptions(exceptions, now = new Date()) {
  if (!Array.isArray(exceptions)) throw new Error("Audit exceptions must be an array");
  const keys = new Set();
  for (const entry of exceptions) {
    const { name, version, advisory, reason, expires } = entry;
    if (![name, version, advisory, reason, expires].every((value) => typeof value === "string" && value.trim())) {
      throw new Error("Audit exception requires name, exact version, advisory, reason and expiry");
    }
    if (!/^[A-Za-z0-9_.+-]+$/.test(version) || !/^(RUSTSEC-|GHSA-)/.test(advisory)
      || !/^\d{4}-\d{2}-\d{2}$/.test(expires) || !Number.isFinite(Date.parse(expires))) {
      throw new Error(`Invalid audit exception: ${name}@${version} ${advisory}`);
    }
    if (new Date(`${expires}T23:59:59.999Z`) < now) throw new Error(`Expired audit exception: ${name} ${advisory}`);
    const key = `${name}@${version}:${advisory}`;
    if (keys.has(key)) throw new Error(`Duplicate audit exception: ${key}`);
    keys.add(key);
  }
}

export function classifyFinding(pkg, advisory, exceptions, verifiedPatches = []) {
  if (advisory.withdrawn) return { kind: "withdrawn" };
  const ids = [advisory.id, ...(advisory.aliases ?? [])];
  if (verifiedPatches.some((patch) => patch.package === pkg.name && patch.version === pkg.version
    && ids.some((id) => patch.advisories.includes(id)))) return { kind: "remediated" };
  const exception = exceptions.find((entry) => entry.name === pkg.name
    && entry.version === pkg.version && ids.includes(entry.advisory));
  if (exception) return { kind: "exception", exception };
  const affected = advisory.affected?.filter((item) => item.package?.name === pkg.name
    && item.package?.ecosystem === "crates.io") ?? [];
  if (advisory.database_specific?.informational === "unmaintained"
    || (affected.length > 0 && affected.every((item) => item.database_specific?.informational === "unmaintained"))) {
    return { kind: "maintenance" };
  }
  return { kind: "vulnerability" };
}

async function requestJson(path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`https://api.osv.dev/v1/${path}`, {
        method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`OSV HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

export async function queryRustPackages(packages, request = requestJson) {
  const findings = packages.map((pkg) => ({ pkg, ids: new Set() }));
  for (let start = 0; start < packages.length; start += 100) {
    let pending = packages.slice(start, start + 100).map((pkg, index) => ({
      index: start + index,
      query: { package: { name: pkg.name, ecosystem: "crates.io" }, version: pkg.version },
    }));
    for (let page = 0; pending.length; page++) {
      if (page >= 20) throw new Error("OSV pagination exceeded safety limit");
      const response = await request("querybatch", { queries: pending.map((item) => item.query) });
      if (!Array.isArray(response.results) || response.results.length !== pending.length) throw new Error("Incomplete OSV batch response");
      const next = [];
      response.results.forEach((result, index) => {
        if (!result || typeof result !== "object" || Array.isArray(result) || Object.hasOwn(result, "error")
          || (result.vulns !== undefined && !Array.isArray(result.vulns))
          || (result.next_page_token !== undefined && typeof result.next_page_token !== "string")) throw new Error("Invalid OSV result");
        for (const vuln of result.vulns ?? []) {
          if (!vuln || typeof vuln.id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(vuln.id)) throw new Error("Missing OSV advisory ID");
          findings[pending[index].index].ids.add(vuln.id);
        }
        if (result.next_page_token) next.push({ ...pending[index], query: { ...pending[index].query, page_token: result.next_page_token } });
      });
      pending = next;
    }
  }
  const ids = [...new Set(findings.flatMap((finding) => [...finding.ids]))];
  const details = new Map();
  for (let start = 0; start < ids.length; start += 8) {
    await Promise.all(ids.slice(start, start + 8).map(async (id) => {
      const advisory = await request(`vulns/${encodeURIComponent(id)}`);
      if (advisory.id !== id) throw new Error(`Mismatched OSV advisory: ${id}`);
      details.set(id, advisory);
    }));
  }
  return findings.flatMap(({ pkg, ids }) => [...ids].map((id) => ({ pkg, advisory: details.get(id) })));
}

function auditNpm() {
  // Invoke npm's JS entry point directly; never pass arguments through cmd/sh.
  const nodeDir = dirname(process.execPath);
  const npmCli = [process.env.npm_execpath,
    resolve(nodeDir, "node_modules/npm/bin/npm-cli.js"),
    resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"), resolve(nodeDir, "npm"),
  ].filter((path) => path && existsSync(path)).map((path) => realpathSync(path))
    .find((path) => basename(path) === "npm-cli.js");
  if (!npmCli) throw new Error("Cannot locate npm-cli.js; run with an official Node.js/npm installation");
  const result = spawnSync(process.execPath, [npmCli, "audit", "--json", "--package-lock-only", "--ignore-scripts", "--no-update-notifier"], {
    cwd: root, encoding: "utf8", windowsHide: true,
    timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout);
  if (report.error || !report.metadata?.vulnerabilities || ![0, 1].includes(result.status)) {
    throw new Error(`npm audit unavailable: ${report.error?.summary ?? result.stderr ?? result.status}`);
  }
  const total = report.metadata.vulnerabilities.total;
  if (!Number.isInteger(total) || total < 0 || !report.vulnerabilities
    || typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities)
    || Object.keys(report.vulnerabilities).length !== total || (total === 0 && result.status !== 0)) {
    throw new Error("Invalid or inconsistent npm audit result");
  }
  console.log(`[npm] ${total} affected package entries`);
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) console.error(`  ${name}: ${entry.severity} (${entry.range})`);
  return total;
}

export async function main() {
  const exceptions = JSON.parse(await readFile(new URL("./security-exceptions.json", import.meta.url), "utf8"));
  validateExceptions(exceptions);
  const verifiedPatches = await loadVerifiedPatches();
  const packages = parseCargoLock(await readFile(new URL("../Cargo.lock", import.meta.url), "utf8"), verifiedPatches);
  const npmCount = auditNpm();
  const findings = await queryRustPackages(packages);
  let blockers = 0;
  let warnings = 0;
  let remediated = 0;
  const usedExceptions = new Set();
  const seen = new Set();
  for (const { pkg, advisory } of findings) {
    const ids = [advisory.id, ...(advisory.aliases ?? [])];
    const canonical = ids.find((id) => id.startsWith("RUSTSEC-")) ?? advisory.id;
    const key = `${pkg.name}@${pkg.version}:${canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // GHSA aliases may omit RustSec's informational status.
    const rustsec = findings.find((item) => item.pkg === pkg && item.advisory.id === canonical)?.advisory ?? advisory;
    const status = classifyFinding(pkg, rustsec, exceptions, verifiedPatches);
    if (status.kind === "withdrawn") continue;
    if (status.kind === "vulnerability") blockers++;
    else if (status.kind === "remediated") remediated++;
    else warnings++;
    console.log(`[${status.kind}] ${key} — ${rustsec.summary ?? ""}`);
    if (status.exception) {
      usedExceptions.add(status.exception);
      console.log(`  Until ${status.exception.expires}: ${status.exception.reason}`);
    }
    console.log(`  https://osv.dev/vulnerability/${encodeURIComponent(canonical)}`);
  }
  for (const exception of exceptions) {
    if (!usedExceptions.has(exception)) throw new Error(`Remove stale audit exception: ${exception.name} ${exception.advisory}`);
  }
  console.log(`[Rust] ${packages.length} packages; ${blockers} blocking advisories; ${remediated} verified backports; ${warnings} maintenance warnings / reviewed exceptions`);
  if (blockers || npmCount) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[audit] FAILED: ${error.message}`); process.exitCode = 1; });
}
