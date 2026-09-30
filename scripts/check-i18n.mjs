import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { formatDistanceStrict } from "date-fns";

const sourceRoot = new URL("../src/", import.meta.url);
const instanceUrl = new URL("../src/i18n/index.js", import.meta.url);
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const zh = await readJson(new URL("i18n/locales/zh-CN.json", sourceRoot));
const en = await readJson(new URL("i18n/locales/en.json", sourceRoot));
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "Both languages need the same keys");
const placeholders = (value) => [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1]).sort();
for (const [key, value] of Object.entries(zh)) {
  assert.equal(typeof en[key], "string", key);
  assert.ok(en[key].trim(), `Empty English translation: ${key}`);
  assert.deepEqual(placeholders(value), placeholders(en[key]), `Placeholder mismatch: ${key}`);
}

// Exercise initialization separately for fresh, saved, invalid, and blocked storage.
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const store = new Map();
const mockStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, value),
};
let instanceId = 0;
const loadFresh = () => import(`${instanceUrl.href}?check=${instanceId++}`);
try {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: mockStorage });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { lang: "" } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US", languages: ["en-US"] } });
  const app = await loadFresh();
  assert.equal(app.i18n.isInitialized, true, "Bundled translations must be ready before rendering");
  assert.equal(app.getLanguage(), "zh-CN", "First launch stays Chinese even on an English system");
  assert.equal(app.t("设置"), "设置");
  assert.equal(document.documentElement.lang, "zh-CN");
  await app.setLanguage("en");
  assert.equal(app.t("设置"), "Settings");
  assert.equal(document.documentElement.lang, "en");
  assert.equal(store.get(app.LANGUAGE_STORAGE_KEY), "en");
  assert.equal(app.t("跟随系统（{{zone}}）", { zone: "Europe/London" }), "System (Europe/London)");
  assert.equal(app.t("未检测到 {{agent}} CLI。请先安装后再试。", { agent: "Example <agent>" }), "Example <agent> CLI was not detected. Install it first, then try again.");
  assert.equal(formatDistanceStrict(0, 86_400_000, { locale: app.getDateLocale(), unit: "day" }), "1 day");
  // Every application key resolves, including punctuation and multiline keys.
  for (const key of Object.keys(en)) {
    const variables = Object.fromEntries(placeholders(en[key]).map((name) => [name, "VALUE"]));
    assert.equal(app.t(key, variables), en[key].replace(/{{\s*([^{}]+?)\s*}}/g, "VALUE"), key);
  }
  assert.equal((await loadFresh()).getLanguage(), "en", "Language must survive a reload");
  await app.setLanguage("zh-CN");
  assert.equal(app.t("设置"), "设置");
  assert.equal(formatDistanceStrict(0, 86_400_000, { locale: app.getDateLocale(), unit: "day" }), "1 天");
  assert.equal((await loadFresh()).getLanguage(), "zh-CN");
  store.set(app.LANGUAGE_STORAGE_KEY, "invalid-language");
  assert.equal((await loadFresh()).getLanguage(), "zh-CN");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
  const blocked = await loadFresh();
  assert.equal(blocked.getLanguage(), "zh-CN");
  await blocked.setLanguage("en");
  assert.equal(blocked.t("设置"), "Settings", "Blocked storage must not prevent in-memory switching");
} finally {
  for (const [key, descriptor] of [["localStorage", savedStorage], ["document", savedDocument], ["navigator", savedNavigator]]) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

const han = /\p{Script=Han}/u;
const failures = [];
let checkedFiles = 0;
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) { await checkDirectory(url); continue; }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const name = fileURLToPath(url);
    const source = await readFile(url, "utf8");
    const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    checkedFiles++;
    for (const diagnostic of parsed.parseDiagnostics) {
      failures.push(`${name}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    }
    function visit(node) {
      if (ts.isCallExpression(node) && /^(memo|React\.memo)$/.test(node.expression.getText(parsed)) && node.arguments[1]) {
        function checkComparator(child) {
          if (ts.isCallExpression(child) && /^use[A-Z]/.test(child.expression.getText(parsed))) {
            failures.push(`${name}: React.memo comparison functions must not call hooks`);
          }
          ts.forEachChild(child, checkComparator);
        }
        checkComparator(node.arguments[1]);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t"
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text;
        if (!(key in zh)) failures.push(`${name}: Missing translation: ${key}`);
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) && han.test(node.text)) {
        const inTranslation = ts.isCallExpression(node.parent) && node.parent.expression.getText(parsed) === "t";
        // Language autonyms and diagnostic logs are intentionally not localized.
        const autonym = node.text.trim() === "简体中文";
        const diagnosticLog = ts.isCallExpression(node.parent) && /^console\./.test(node.parent.expression.getText(parsed));
        if (!inTranslation && !autonym && !diagnosticLog) {
          const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
          failures.push(`${name}:${line}: Untranslated UI text: ${node.text.trim()}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
}
await checkDirectory(sourceRoot);
assert.deepEqual(failures, [], failures.join("\n"));
console.log(`i18n checks passed: ${Object.keys(zh).length} keys, ${checkedFiles} source files parsed (no type check/build).`);
