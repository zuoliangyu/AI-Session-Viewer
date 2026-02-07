import { format } from "date-fns";

export function formatTime(timestamp: string): string {
  try {
    return format(new Date(timestamp), "HH:mm:ss");
  } catch {
    return timestamp;
  }
}
