import { useEffect, useMemo, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useChatStore } from "../../stores/chatStore";
import { useAppStore } from "../../stores/appStore";
import { useChatStream } from "../../hooks/useChatStream";
import { ChatHeader } from "./ChatHeader";
import { ChatInput } from "./ChatInput";
import { StreamingMessage } from "./StreamingMessage";
import { FolderSelector } from "./FolderSelector";
import { MessageSquarePlus, AlertCircle, Bot } from "lucide-react";
import type { ChatMessage } from "../../types/chat";

/** Enable virtual scrolling when there are more turns than this */
const VIRTUAL_THRESHOLD = 30;

interface Turn {
  turnIndex: number;
  messages: ChatMessage[];
  tokens: number;
}

export function ChatPage() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const {
    isActive,
    sessionId,
    projectPath,
    model,
    messages,
    isStreaming,
    error,
    availableClis,
    detectCli,
    fetchCliConfig,
    fetchModelList,
    startNewChat,
    continueExistingChat,
    cancelChat,
    setProjectPath,
    setModel,
    setSource,
  } = useChatStore();

  const appSource = useAppStore((s) => s.source);
  const cliLabel = appSource === "codex" ? "Codex" : "Claude";

  // Sync source from appStore into chatStore
  useEffect(() => { setSource(appSource); }, [appSource, setSource]);

  // Detect CLI on mount + fetch config & model list
  useEffect(() => { detectCli(); }, [detectCli]);
  useEffect(() => { if (appSource === "claude") fetchCliConfig(); }, [appSource, fetchCliConfig]);
  // Re-fetch model list whenever source changes (setSource clears modelList first)
  useEffect(() => { fetchModelList(); }, [appSource, fetchModelList]);

  // Listen for stream events
  useChatStream();

  const handleSend = useCallback((prompt: string) => {
    if (!projectPath) return;
    if (sessionId || urlSessionId) {
      continueExistingChat(sessionId || urlSessionId!, projectPath, prompt, model);
    } else {
      startNewChat(projectPath, prompt, model);
    }
  }, [projectPath, sessionId, urlSessionId, model, continueExistingChat, startNewChat]);

  const cliAvailable = availableClis.some((c) => c.cliType === appSource);

  // Build tool linking maps
  const { toolResultMap, linkedToolUseIds } = useMemo(() => {
    const resultMap = new Map<string, { content: string; isError: boolean }>();
    const linkedIds = new Set<string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          resultMap.set(block.toolUseId, { content: block.content, isError: block.isError });
          linkedIds.add(block.toolUseId);
        }
      }
    }
    return { toolResultMap: resultMap, linkedToolUseIds: linkedIds };
  }, [messages]);

  // Build conversation turns
  const turns = useMemo(() => {
    const result: Turn[] = [];
    let current: ChatMessage[] = [];
    let turnIdx = 0;
    let tokens = 0;

    for (const msg of messages) {
      const isUserText = msg.role === "user" && msg.content.some((b) => b.type === "text");
      if (isUserText && current.length > 0) {
        result.push({ turnIndex: turnIdx, messages: current, tokens });
        turnIdx++;
        current = [];
        tokens = 0;
      }
      current.push(msg);
      if (msg.usage) tokens += msg.usage.inputTokens + msg.usage.outputTokens;
    }
    if (current.length > 0) {
      result.push({ turnIndex: turnIdx, messages: current, tokens });
    }
    return result;
  }, [messages]);

  const useVirtual = turns.length > VIRTUAL_THRESHOLD;

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Scroll to bottom
    el.scrollTop = el.scrollHeight;
  }, [messages.length, isStreaming]);

  return (
    <div className="flex flex-col h-full">
      <ChatHeader />

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {!isActive && messages.length === 0 ? (
          <EmptyState
            projectPath={projectPath}
            onProjectPathChange={setProjectPath}
            cliAvailable={cliAvailable}
            cliLabel={cliLabel}
          />
        ) : useVirtual ? (
          <VirtualizedTurns
            turns={turns}
            toolResultMap={toolResultMap}
            linkedToolUseIds={linkedToolUseIds}
            isStreaming={isStreaming}
            error={error}
            scrollContainer={scrollContainerRef}
          />
        ) : (
          <div className="max-w-4xl mx-auto px-4 py-4">
            {turns.map((turn) => (
              <TurnBlock
                key={turn.turnIndex}
                turn={turn}
                toolResultMap={toolResultMap}
                linkedToolUseIds={linkedToolUseIds}
              />
            ))}
            <StreamingAndError isStreaming={isStreaming} error={error} />
          </div>
        )}
      </div>

      <div className="max-w-4xl mx-auto w-full">
        <ChatInput
          onSend={handleSend}
          onCancel={cancelChat}
          isStreaming={isStreaming}
          disabled={!projectPath || !cliAvailable}
        />
      </div>
    </div>
  );
}

/* ── Virtualized turn list ─────────────────────────── */

function VirtualizedTurns({
  turns,
  toolResultMap,
  linkedToolUseIds,
  isStreaming,
  error,
  scrollContainer,
}: {
  turns: Turn[];
  toolResultMap: Map<string, { content: string; isError: boolean }>;
  linkedToolUseIds: Set<string>;
  isStreaming: boolean;
  error: string | null;
  scrollContainer: React.RefObject<HTMLDivElement | null>;
}) {
  // +1 for the streaming/error footer row
  const count = turns.length + 1;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollContainer.current,
    estimateSize: () => 120,
    overscan: 5,
  });

  return (
    <div className="max-w-4xl mx-auto px-4 py-4">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          if (item.index === turns.length) {
            // Footer: streaming indicator + error
            return (
              <div
                key="footer"
                ref={virtualizer.measureElement}
                data-index={item.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <StreamingAndError isStreaming={isStreaming} error={error} />
              </div>
            );
          }

          const turn = turns[item.index];
          return (
            <div
              key={turn.turnIndex}
              ref={virtualizer.measureElement}
              data-index={item.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              <TurnBlock
                turn={turn}
                toolResultMap={toolResultMap}
                linkedToolUseIds={linkedToolUseIds}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Single turn ───────────────────────────────────── */

function TurnBlock({
  turn,
  toolResultMap,
  linkedToolUseIds,
}: {
  turn: Turn;
  toolResultMap: Map<string, { content: string; isError: boolean }>;
  linkedToolUseIds: Set<string>;
}) {
  return (
    <div>
      {turn.turnIndex > 0 && (
        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 border-t border-border/50" />
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
            Turn {turn.turnIndex + 1}
            {turn.tokens > 0 && ` · ${turn.tokens.toLocaleString()} tokens`}
          </span>
          <div className="flex-1 border-t border-border/50" />
        </div>
      )}
      <div className="space-y-1">
        {turn.messages.map((msg) => (
          <StreamingMessage
            key={msg.id}
            message={msg}
            toolResultMap={toolResultMap}
            linkedToolUseIds={linkedToolUseIds}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Streaming / error footer ──────────────────────── */

function StreamingAndError({
  isStreaming,
  error,
}: {
  isStreaming: boolean;
  error: string | null;
}) {
  return (
    <>
      {isStreaming && (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <div className="flex gap-1">
            <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.3s]" />
            <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.15s]" />
            <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" />
          </div>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 py-2 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}
    </>
  );
}

/* ── Empty state ───────────────────────────────────── */

function EmptyState({
  projectPath,
  onProjectPathChange,
  cliAvailable,
  cliLabel,
}: {
  projectPath: string;
  onProjectPathChange: (p: string) => void;
  cliAvailable: boolean;
  cliLabel: string;
}) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="max-w-md w-full px-6 space-y-6">
        <div className="text-center space-y-2">
          <MessageSquarePlus className="w-10 h-10 mx-auto text-muted-foreground" />
          <h2 className="text-lg font-semibold">新建对话</h2>
          <p className="text-sm text-muted-foreground">
            选择工作目录，开始与 {cliLabel} 对话
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            {cliLabel} CLI
          </label>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted border border-border">
            <Bot className="w-4 h-4 text-orange-500" />
            <span className="text-sm font-medium">{cliLabel}</span>
            <span className={`ml-auto text-xs ${cliAvailable ? "text-green-500" : "text-red-400"}`}>
              {cliAvailable ? "已安装" : "未检测到"}
            </span>
          </div>
          {!cliAvailable && (
            <p className="mt-1.5 text-xs text-red-400">
              未检测到 {cliLabel} CLI。请先安装后再试。
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            工作目录
          </label>
          <FolderSelector value={projectPath} onChange={onProjectPathChange} />
        </div>

        <p className="text-xs text-center text-muted-foreground">
          选择工作目录后，在下方输入框输入提示词开始对话
        </p>
      </div>
    </div>
  );
}
