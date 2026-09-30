import { useMemo } from "react";

interface DiffLine {
  type: "added" | "removed" | "context";
  text: string;
  oldNum?: number;
  newNum?: number;
}

/**
 * Compute a simple LCS-based diff between two strings.
 */
function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "context", text: oldLines[i - 1], oldNum: i, newNum: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "added", text: newLines[j - 1], newNum: j });
      j--;
    } else {
      result.push({ type: "removed", text: oldLines[i - 1], oldNum: i });
      i--;
    }
  }
  result.reverse();
  return result;
}

interface Props {
  oldString: string;
  newString: string;
  fileName?: string;
}

export function DiffView({ oldString, newString, fileName }: Props) {
  const lines = useMemo(() => computeDiff(oldString, newString), [oldString, newString]);

  const addedCount = lines.filter((l) => l.type === "added").length;
  const removedCount = lines.filter((l) => l.type === "removed").length;

  return (
    <div className="rounded-md border border-border overflow-hidden text-xs font-mono">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-b border-border">
        {fileName && (
          <span className="text-muted-foreground truncate">{fileName}</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {addedCount > 0 && (
            <span className="text-success">+{addedCount}</span>
          )}
          {removedCount > 0 && (
            <span className="text-destructive">-{removedCount}</span>
          )}
        </span>
      </div>

      {/* Diff lines */}
      <div className="overflow-x-auto max-h-80 overflow-y-auto">
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={`flex whitespace-pre ${
              line.type === "added"
                ? "bg-success/10 text-success"
                : line.type === "removed"
                  ? "bg-destructive/10 text-destructive"
                  : "text-muted-foreground"
            }`}
          >
            {/* Line numbers */}
            <span className="w-8 shrink-0 text-right pr-1 select-none opacity-50 border-r border-border">
              {line.oldNum ?? " "}
            </span>
            <span className="w-8 shrink-0 text-right pr-1 select-none opacity-50 border-r border-border">
              {line.newNum ?? " "}
            </span>
            {/* Prefix */}
            <span className="w-5 shrink-0 text-center select-none">
              {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
            </span>
            {/* Content */}
            <span className="flex-1 pr-2">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
