import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

async function readSource(relativePath) {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

const [chatCli, webChat, desktopChat, cli, ompProvider, messagesPage] = await Promise.all([
  readSource("crates/session-core/src/chat_cli.rs"),
  readSource("crates/session-web/src/chat_ws.rs"),
  readSource("src-tauri/src/commands/chat.rs"),
  readSource("crates/session-core/src/cli.rs"),
  readSource("crates/session-core/src/provider/omp.rs"),
  readSource("src/components/message/MessagesPage.tsx"),
]);

// Claude print-mode arguments live in one place and end option parsing
// before the prompt, so a prompt starting with `-` is never read as a flag.
assert.match(
  chatCli,
  /args\.push\("--"\.to_string\(\)\);\s*args\.push\(prompt\.to_string\(\)\);/,
  "Claude chat must pass `--` before the prompt",
);
for (const [name, source] of [["Web", webChat], ["Desktop", desktopChat]]) {
  assert.match(source, /chat_cli::claude_print_args\(/, `${name} chat must build Claude args via chat_cli`);
  assert.match(source, /chat_cli::apply_cli_env\(/, `${name} chat must use the shared CLI environment`);
}
assert.match(chatCli, /cmd\.env_clear\(\);/, "Chat CLIs must start from a cleared, whitelisted environment");

// In-app chat only drives the local Claude / Codex CLIs.
assert.match(
  cli,
  /pub fn normalize_chat_source[\s\S]*?"claude" \| "codex"/,
  "In-app chat must be limited to Claude and Codex",
);
for (const [name, source] of [["Web", webChat], ["Desktop", desktopChat]]) {
  assert.match(source, /normalize_chat_source\(/, `${name} chat must reject non Claude/Codex sources`);
}

assert.match(
  ompProvider,
  /XDG_DATA_HOME/,
  "OMP session discovery must support XDG data migration",
);

assert.doesNotMatch(
  messagesPage,
  /const cliAvailable = source === "omp" \|\|/,
  "CLI availability must come from CLI detection",
);
