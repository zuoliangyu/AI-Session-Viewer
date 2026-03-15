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
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[mGKHFABCDJKST]/g, "")
             // eslint-disable-next-line no-control-regex
             .replace(/\x1b[()][AB012]/g, "");
}
