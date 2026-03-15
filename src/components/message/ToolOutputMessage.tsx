import { useState } from "react";
import type { DisplayMessage } from "../../types";
import { Terminal, ChevronDown, ChevronRight, Code, FileText } from "lucide-react";
import { formatTime, stripAnsi } from "./utils";
import { MarkdownContent } from "./MarkdownContent";

interface Props {
  message: DisplayMessage;
  showTimestamp: boolean;
}

const COLLAPSE_THRESHOLD = 400;

/* ── 单个输出块 ──────────────────────────────────────── */

function OutputBlock({
  content,
  isError = false,
}: {
  content: string;
  isError?: boolean;
}) {
  const isLong = content.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);
  const [viewMode, setViewMode] = useState<"source" | "md">("source");

  return (
    <div className={`mt-1 border rounded-md overflow-hidden ${
      isError ? "border-destructive/30" : "border-border"
    }`}>
      {/* 标题栏 */}
      <div className={`flex items-center gap-1 px-2 py-1 text-xs ${
        isError ? "bg-destructive/5" : "bg-muted/30"
      }`}>
        {/* 折叠/展开主区域 */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />
          )}
          {!expanded && (
            <span className="text-muted-foreground truncate">
              {content.length} 字符
            </span>
          )}
        </button>

        {/* </> / MD 切换 */}
        <div className="flex shrink-0 rounded overflow-hidden border border-border/50">
          <button
            onClick={() => setViewMode("source")}
            className={`flex items-center gap-1 px-1.5 py-0.5 transition-colors ${
              viewMode === "source"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="源码"
          >
            <Code className="w-3 h-3" />
            <span className="text-[10px]">&lt;/&gt;</span>
          </button>
          <button
            onClick={() => setViewMode("md")}
            className={`flex items-center gap-1 px-1.5 py-0.5 transition-colors ${
              viewMode === "md"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Markdown 渲染"
          >
            <FileText className="w-3 h-3" />
            <span className="text-[10px]">MD</span>
          </button>
        </div>
      </div>

      {/* 内容区 */}
      {expanded && (
        <div className="border-t border-border">
          {viewMode === "md" ? (
            <MarkdownContent content={content} />
          ) : (
            <pre
              className={`px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all
                max-h-80 overflow-y-auto ${
                isError
                  ? "text-destructive bg-destructive/5"
                  : "text-muted-foreground"
              }`}
            >
              {content.length > 10000
                ? content.slice(0, 10000) + "\n... (truncated)"
                : content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ── ToolOutputMessage ───────────────────────────────── */

export function ToolOutputMessage({ message, showTimestamp }: Props) {
  return (
    <div className="flex gap-3 ml-10">
      <div className="flex-1 min-w-0">
        {/* 标题行 */}
        <div className="flex items-center gap-2 mb-1">
          <Terminal className="w-3 h-3 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Tool Output</span>
          {showTimestamp && message.timestamp && (
            <span className="text-xs text-muted-foreground">
              {formatTime(message.timestamp)}
            </span>
          )}
        </div>

        {/* 输出块 */}
        {message.content.map((block, i) => {
          if (block.type === "function_call_output") {
            const output = stripAnsi(block.output);
            return <OutputBlock key={i} content={output} />;
          }
          if (block.type === "tool_result") {
            const cleaned = stripAnsi(block.content);
            return <OutputBlock key={i} content={cleaned} isError={block.isError} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
