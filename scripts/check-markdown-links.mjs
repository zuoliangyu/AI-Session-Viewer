import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { safeMarkdownHref, openMarkdownExternalLink } from "../src/services/markdownLinks.ts";

const opened = [];
const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const shellScope = new RegExp(`^(?:${config.plugins.shell.open})$`);
globalThis.__asvOpenMarkdownLink = async (href) => {
  assert(shellScope.test(href), `URL rejected by shell scope: ${href}`);
  opened.push(href);
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@tauri-apps/plugin-shell") return { url: "asv-link:shell", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "asv-link:shell") return { format: "module", source: "export const open = globalThis.__asvOpenMarkdownLink;", shortCircuit: true };
    return nextLoad(url, context);
  },
});
try {
  for (const href of [undefined, "", "javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "tauri://localhost/", "/settings", "../private", "https://user:secret@example.com", "https://example.com\n", "https:\\example.com"]) {
    assert.equal(safeMarkdownHref(href), null, String(href));
  }
  assert.equal(safeMarkdownHref("#user-content-details"), "#user-content-details");
  assert.equal(safeMarkdownHref("//example.com/docs"), "https://example.com/docs");
  assert.equal(safeMarkdownHref("https://example.com/?q=%E4%B8%AD%E6%96%87"), "https://example.com/?q=%E4%B8%AD%E6%96%87");
  await openMarkdownExternalLink("https://example.com/docs");
  await openMarkdownExternalLink("mailto:reader@example.com");
  await openMarkdownExternalLink("http://[::1]:3000/docs");
  await openMarkdownExternalLink("mailto:?subject=Report");
  await openMarkdownExternalLink("mailto:+tag@example.com");
  await openMarkdownExternalLink("javascript:alert(1)");
  await openMarkdownExternalLink("#details");
  assert.deepEqual(opened, ["https://example.com/docs", "mailto:reader@example.com", "http://[::1]:3000/docs", "mailto:?subject=Report", "mailto:+tag@example.com"]);
  for (const href of ["file:///tmp/file", "javascript:alert(1)", "--enable-debugging", "https://example.com\n"]) assert(!shellScope.test(href), href);
  console.log("Markdown link safety checks passed");
} finally {
  hooks.deregister();
  delete globalThis.__asvOpenMarkdownLink;
}
