import { memo, useMemo, useState } from "react";
import type { DisplayMessage } from "../../types";
import { Terminal, ChevronDown, ChevronRight, Code, FileText } from "lucide-react";
import { formatTime, stripAnsi } from "./utils";
import { MarkdownContent } from "./MarkdownContent";
import { useExpandAllControl } from "../common/ExpandAllContext";

interface Props {
  message: DisplayMessage;
  showTimestamp: boolean;
  layout?: "default" | "thread";
}

const COLLAPSE_THRESHOLD = 400;

/* ── 单个输出块 ──────────────────────────────────────── */

function OutputBlock({
  content,
  isError = false,
  compact = false,
}: {
  content: string;
  isError?: boolean;
  compact?: boolean;
}) {
  const isLong = content.length > COLLAPSE_THRESHOLD;
  const { expanded, setExpanded } = useExpandAllControl(!isLong);
  const [viewMode, setViewMode] = useState<"source" | "md">("source");
  const displayContent = useMemo(
    () => (content.length > 10000 ? content.slice(0, 10000) + "\n... (truncated)" : content),
    [content]
  );
  const markdownContent = useMemo(
    () => (content.length > 10000 ? content.slice(0, 10000) + "\n\n... (truncated)" : content),
    [content]
  );

  return (
    <div className={`mt-1 border rounded-md overflow-hidden ${
      isError ? "border-destructive/30" : "border-border"
    }`}>
      {/* 标题栏 */}
      <div className={`flex items-center gap-1 ${compact ? "px-1.5" : "px-2"} py-1 text-xs ${
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
            <div className={`max-h-80 overflow-y-auto ${compact ? "px-2 py-2" : ""}`}>
              <MarkdownContent content={markdownContent} />
            </div>
          ) : (
            <pre
              className={`${compact ? "px-2" : "px-3"} py-2 text-xs font-mono whitespace-pre-wrap break-all
                max-h-80 overflow-y-auto ${
                isError
                  ? "text-destructive bg-destructive/5"
                  : "text-muted-foreground"
              }`}
            >
              {displayContent}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ── ToolOutputMessage ───────────────────────────────── */

const MemoizedOutputBlock = memo(OutputBlock, (prevProps, nextProps) => (
  prevProps.content === nextProps.content &&
  prevProps.isError === nextProps.isError &&
  prevProps.compact === nextProps.compact
));

export const ToolOutputMessage = memo(function ToolOutputMessage({
  message,
  showTimestamp,
  layout = "default",
}: Props) {
  const isThreadLayout = layout === "thread";

  return (
    <div className={isThreadLayout ? "w-full" : "flex ml-10 gap-3"}>
      <div className="flex-1 min-w-0">
        {/* 标题行 */}
        <div className={`mb-1 flex items-center ${isThreadLayout ? "gap-1.5" : "gap-2"}`}>
          {!isThreadLayout && <Terminal className="w-3 h-3 text-muted-foreground" />}
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
            return <MemoizedOutputBlock key={i} content={output} compact={isThreadLayout} />;
          }
          if (block.type === "tool_result") {
            const cleaned = stripAnsi(block.content);
            return <MemoizedOutputBlock key={i} content={cleaned} isError={block.isError} compact={isThreadLayout} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}, (prevProps, nextProps) => (
  prevProps.message === nextProps.message &&
  prevProps.showTimestamp === nextProps.showTimestamp &&
  prevProps.layout === nextProps.layout
));
