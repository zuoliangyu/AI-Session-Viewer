import { format } from "date-fns";

export function formatTime(timestamp: string): string {
  try {
    return format(new Date(timestamp), "HH:mm:ss");
  } catch {
    return timestamp;
  }
}

/**
 * Remove ANSI escape codes from terminal output.
 * Covers color codes, cursor movement, erase sequences, etc.
 */
export function stripAnsi(text: string): string {
  if (!text) return text ?? "";
  return (
    text
      // OSC sequences: \x1b] ... \x07 or \x1b\  (e.g. window title)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // CSI sequences: covers standard + private mode (with ? # ; digits)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, "")
      // Remaining lone ESC + single char (e.g. \x1bM scroll up, \x1bc reset)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[A-Za-z]/g, "")
      // Standalone BEL characters that may remain
      // eslint-disable-next-line no-control-regex
      .replace(/\x07/g, "")
  );
}
