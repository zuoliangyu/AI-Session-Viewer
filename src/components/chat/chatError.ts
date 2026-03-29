export function isActualChatError(line: string): boolean {
  const lower = line.toLowerCase().trim();
  if (!lower) return false;
  if (lower.startsWith("[request interrupted")) return false;
  if (lower.startsWith("warning:")) return false;
  if (lower.startsWith("info:")) return false;
  if (lower.startsWith("debug:")) return false;
  if (lower.includes("error") || lower.includes("fatal") || lower.includes("panic")) return true;
  return true;
}
