/** CLI command that resumes `sessionId` for a session source. Kept in one
 *  place so every "复制续聊命令" button stays in sync with the backend's
 *  `resume_command` (src-tauri/src/commands/terminal.rs). */
export function getResumeCommand(source: string, sessionId: string): string {
  switch (source) {
    case "codex":
      return `codex resume ${sessionId}`;
    case "grok":
      return `grok -r ${sessionId}`;
    case "omp":
      return `omp --resume ${sessionId}`;
    default:
      return `claude --resume ${sessionId}`;
  }
}
