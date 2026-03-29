import { memo, useMemo, useState } from "react";
import type { DisplayMessage } from "../../types";
import { Bot, ChevronDown, ChevronRight, Wrench, Brain, Copy, Check } from "lucide-react";
import { formatTime, cleanMessageText, stripAnsi } from "./utils";
import { ToolViewer } from "../chat/tool-viewers/ToolViewers";
import { MarkdownContent } from "./MarkdownContent";
import { useExpandAllControl } from "../common/ExpandAllContext";

interface Props {
  message: DisplayMessage;
  source: string;
  showTimestamp: boolean;
  showModel: boolean;
  threadAnchor?: string | null;
  threadHint?: string | null;
}

const MARKDOWN_CLASS_NAME = "prose prose-sm max-w-none p-0 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";

export const AssistantMessage = memo(function AssistantMessage({
  message,
  source,
  showTimestamp,
  showModel,
  threadAnchor,
  threadHint,
}: Props) {
  const assistantName = source === "codex" ? "Codex" : "Claude";
  const iconColor = source === "codex" ? "text-green-500" : "text-orange-500";
  const iconBg = source === "codex" ? "bg-green-500/10" : "bg-orange-500/10";
  const [copied, setCopied] = useState(false);
  const textContent = useMemo(
    () => message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => cleanMessageText(block.text))
      .filter(Boolean),
    [message.content]
  );
  const hasTextContent = textContent.length > 0;
  const copyText = useMemo(
    () => textContent.join("\n\n").trim(),
    [textContent]
  );

  const handleCopy = () => {
    if (!copyText) return;
    navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex gap-3 group/assistant">
      <div className={`shrink-0 w-7 h-7 rounded-full ${iconBg} flex items-center justify-center mt-0.5`}>
        <Bot className={`w-3.5 h-3.5 ${iconColor}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-sm font-medium">{assistantName}</span>
          {threadAnchor && (
            <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {threadAnchor}
            </span>
          )}
          {showModel && message.model && (
            <span className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
              {message.model}
            </span>
          )}
          {showTimestamp && message.timestamp && (
            <span className="text-xs text-muted-foreground">
              {formatTime(message.timestamp)}
            </span>
          )}
          {hasTextContent && (
            <button
              onClick={handleCopy}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="复制消息"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-green-500" />
                  已复制
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  复制文本
                </>
              )}
            </button>
          )}
        </div>
        {threadHint && (
          <div className="mb-2 text-[11px] text-muted-foreground">
            {threadHint}
          </div>
        )}
        {message.content.map((block, i) => {
          if (block.type === "text") {
            const cleaned = cleanMessageText(block.text);
            if (!cleaned) return null;
            return (
              <MarkdownContent
                key={i}
                content={cleaned}
                className={MARKDOWN_CLASS_NAME}
              />
            );
          }
          if (block.type === "thinking") {
            return <ThinkingBlock key={i} thinking={block.thinking} />;
          }
          if (block.type === "reasoning") {
            return <ReasoningBlock key={i} text={block.text} />;
          }
          if (block.type === "tool_use") {
            return (
              <ToolViewer
                key={i}
                name={block.name}
                input={block.input}
              />
            );
          }
          if (block.type === "function_call") {
            return (
              <FunctionCallBlock
                key={i}
                name={block.name}
                arguments={block.arguments}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}, (prevProps, nextProps) => (
  prevProps.message === nextProps.message &&
  prevProps.source === nextProps.source &&
  prevProps.showTimestamp === nextProps.showTimestamp &&
  prevProps.showModel === nextProps.showModel &&
  prevProps.threadAnchor === nextProps.threadAnchor &&
  prevProps.threadHint === nextProps.threadHint
));

function ThinkingBlock({ thinking }: { thinking: string }) {
  const { expanded, setExpanded } = useExpandAllControl(true);

  return (
    <div className="mt-2 mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain className="w-3.5 h-3.5 shrink-0" />
        思考过程
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
      </button>
      {expanded && (
        <div className="mt-1 pl-5 text-xs text-muted-foreground whitespace-pre-wrap border-l-2 border-muted">
          {thinking}
        </div>
      )}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  const { expanded, setExpanded } = useExpandAllControl(true);

  return (
    <div className="mt-2 mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain className="w-3.5 h-3.5 shrink-0" />
        推理过程
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
      </button>
      {expanded && (
        <div className="mt-1 pl-5 text-xs text-muted-foreground whitespace-pre-wrap border-l-2 border-muted">
          {text}
        </div>
      )}
    </div>
  );
}

function FunctionCallBlock({ name, arguments: args }: { name: string; arguments: string }) {
  const { expanded, setExpanded } = useExpandAllControl(true);
  const cleanedArgs = useMemo(() => {
    const cleaned = stripAnsi(args);
    return cleaned.length > 5000
      ? cleaned.slice(0, 5000) + "\n... (truncated)"
      : cleaned;
  }, [args]);

  return (
    <div className="mt-2 mb-2 border border-border rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs bg-muted/50 hover:bg-muted transition-colors"
      >
        <Wrench className="w-3.5 h-3.5 text-green-500" />
        <span className="font-mono font-medium">{name}</span>
        {expanded ? (
          <ChevronDown className="w-3 h-3 ml-auto" />
        ) : (
          <ChevronRight className="w-3 h-3 ml-auto" />
        )}
      </button>
      {expanded && (
        <div className="p-3 text-xs font-mono bg-muted/20 overflow-x-auto">
          <pre className="whitespace-pre-wrap break-all">{cleanedArgs}</pre>
        </div>
      )}
    </div>
  );
}
