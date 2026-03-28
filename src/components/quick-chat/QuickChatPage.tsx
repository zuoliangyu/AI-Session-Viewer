import { useEffect, useRef, useState, useMemo } from "react";
import { useQuickChatStore } from "../../stores/quickChatStore";
import { useChatStore } from "../../stores/chatStore";
import {
  Send,
  Square,
  Bot,
  Trash2,
  ChevronDown,
  Zap,
  User,
  Loader2,
  AlertCircle,
  Search,
  Check,
  X,
  RefreshCw,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { ModelInfo, QuickChatMessage } from "../../types/chat";
import { ScrollArea } from "../ScrollArea";


export function QuickChatPage() {
  const {
    model,
    messages,
    isStreaming,
    error,
    modelList,
    modelListLoading,
    sendMessage,
    clearMessages,
    setModel,
    fetchModelList,
    cancelStream,
  } = useQuickChatStore();

  const { cliConfig, fetchCliConfig } = useChatStore();

  const [text, setText] = useState("");
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initialize
  useEffect(() => {
    if (!initialized) {
      fetchCliConfig();
      fetchModelList();
      setInitialized(true);
    }
  }, [initialized, fetchCliConfig, fetchModelList]);

  // Model auto-selection is handled by quickChatStore.fetchModelList()

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);

  // Focus on input after streaming ends
  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus();
  }, [isStreaming]);

  // Ctrl+K to open model selector
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setModelSelectorOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    // Slash command: /model [id]
    if (trimmed.startsWith("/model")) {
      const arg = trimmed.slice(6).trim();
      if (arg) {
        setModel(arg);
      } else {
        setModelSelectorOpen(true);
      }
      setText("");
      return;
    }

    sendMessage(trimmed);
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  function shortModelName(id: string): string {
    return id
      .replace(/-\d{8}$/, "")
      .replace(/^claude-/, "");
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card">
        <Zap className="w-4 h-4 text-primary" />
        <h1 className="text-sm font-semibold text-foreground">快速问答</h1>
        <div className="flex-1" />
        {messages.length > 0 && (
          <button
            onClick={clearMessages}
            disabled={isStreaming}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" />
            清空
          </button>
        )}
      </div>

      {/* Messages area */}
      <ScrollArea className="flex-1 min-h-0" viewportClassName="h-full">
        {messages.length === 0 ? (
          <QuickChatEmpty cliConfig={cliConfig} />
        ) : (
          <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">
            {messages.map((msg, i) => (
              <QuickMessage key={i} message={msg} isLast={i === messages.length - 1} isStreaming={isStreaming} />
            ))}
            {error && (
              <div className="flex items-center gap-2 py-2 text-sm text-red-400">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </ScrollArea>

      {/* Input area */}
      <div className="max-w-3xl mx-auto w-full">
        <div className="border-t border-border bg-card px-4 py-3">
          {/* Model row */}
          <div className="flex items-center gap-2 mb-2">
            {/* Model button */}
            <button
              onClick={() => setModelSelectorOpen(true)}
              disabled={isStreaming}
              className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border border-border bg-muted hover:bg-accent/50 transition-colors disabled:opacity-50"
              title={model || "选择模型 (Ctrl+K)"}
            >
              <Bot className="w-3 h-3 text-orange-500" />
              <span className="max-w-[12rem] truncate text-foreground">
                {model ? shortModelName(model) : "选择模型"}
              </span>
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            </button>
            <span className="text-[10px] text-muted-foreground">Ctrl+K 或 /model</span>
          </div>

          {/* Input row */}
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isStreaming
                  ? "等待响应中..."
                  : "输入消息... (Enter 发送, Shift+Enter 换行)"
              }
              disabled={isStreaming}
              rows={1}
              className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            />
            {isStreaming ? (
              <button
                onClick={cancelStream}
                className="shrink-0 p-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
                title="停止生成"
              >
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!text.trim() || !model}
                className="shrink-0 p-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="发送消息"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Model Selector */}
      <QuickModelSelector
        open={modelSelectorOpen}
        onClose={() => setModelSelectorOpen(false)}
        currentModel={model}
        modelList={modelList}
        modelListLoading={modelListLoading}
        onSelect={(m) => setModel(m)}
        onRefresh={fetchModelList}
      />
    </div>
  );
}

// ── Empty state ──

function QuickChatEmpty({
  cliConfig,
}: {
  cliConfig: import("../../types/chat").CliConfig | null;
}) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="max-w-sm w-full px-6 space-y-6">
        <div className="text-center space-y-2">
          <Zap className="w-10 h-10 mx-auto text-muted-foreground" />
          <h2 className="text-lg font-semibold">快速问答</h2>
          <p className="text-sm text-muted-foreground">
            直接调用 Claude API 进行纯文本对话，无需工作目录
          </p>
        </div>

        {/* CLI config status */}
        {cliConfig && (
          <div className="rounded-lg border border-border bg-muted/50 p-3 space-y-1.5 text-xs">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${cliConfig.hasApiKey ? "bg-green-500" : "bg-red-500"}`} />
              <span className="text-muted-foreground">API Key:</span>
              <span className="text-foreground font-mono">
                {cliConfig.hasApiKey ? cliConfig.apiKeyMasked : "未配置"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground ml-3.5">Base URL:</span>
              <span className="text-foreground font-mono truncate">{cliConfig.baseUrl}</span>
            </div>
            {cliConfig.defaultModel && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground ml-3.5">默认模型:</span>
                <span className="text-foreground font-mono">{cliConfig.defaultModel}</span>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-center text-muted-foreground">
          选择模型后，在下方输入框输入问题开始对话
        </p>
      </div>
    </div>
  );
}

// ── Message component ──

function QuickMessage({
  message,
  isLast,
  isStreaming,
}: {
  message: QuickChatMessage;
  isLast: boolean;
  isStreaming: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-primary/10 rounded-lg px-3 py-2 text-sm text-foreground">
          <div className="flex items-center gap-1.5 mb-1">
            <User className="w-3 h-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">你</span>
          </div>
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  const showCursor = isLast && isStreaming;

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm text-foreground">
        <div className="flex items-center gap-1.5 mb-1">
          <Bot className="w-3 h-3 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Claude</span>
          {showCursor && !message.content && (
            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
          )}
        </div>
        {message.content ? (
          <div className="prose prose-sm dark:prose-invert max-w-none break-words">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || "");
                  const inline = !match;
                  if (inline) {
                    return (
                      <code className="px-1 py-0.5 rounded bg-muted text-xs font-mono" {...props}>
                        {children}
                      </code>
                    );
                  }
                  return (
                    <SyntaxHighlighter
                      style={oneDark}
                      language={match[1]}
                      PreTag="div"
                      customStyle={{ borderRadius: "0.375rem", fontSize: "0.75rem" }}
                    >
                      {String(children).replace(/\n$/, "")}
                    </SyntaxHighlighter>
                  );
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
            {showCursor && (
              <span className="inline-block w-1.5 h-4 bg-foreground/60 animate-pulse ml-0.5" />
            )}
          </div>
        ) : showCursor ? (
          <div className="flex gap-1 py-1">
            <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.3s]" />
            <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.15s]" />
            <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Simple model selector for quick chat ──

function QuickModelSelector({
  open,
  onClose,
  currentModel,
  modelList,
  modelListLoading,
  onSelect,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  currentModel: string;
  modelList: ModelInfo[];
  modelListLoading: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      setHighlightIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return modelList;
    const q = search.toLowerCase();
    return modelList.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );
  }, [modelList, search]);

  const canUseAsCustom = search.trim().length > 0 && filtered.length === 0;

  const grouped = useMemo(() => {
    const groups: Record<string, ModelInfo[]> = {};
    for (const m of filtered) {
      if (!groups[m.group]) groups[m.group] = [];
      groups[m.group].push(m);
    }
    return groups;
  }, [filtered]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [search]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${highlightIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  const handleUseCustom = () => {
    const id = search.trim();
    if (id) {
      onSelect(id);
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (canUseAsCustom) {
          handleUseCustom();
        } else if (filtered[highlightIndex]) {
          onSelect(filtered[highlightIndex].id);
          onClose();
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  if (!open) return null;

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-[28rem] max-w-[90vw] max-h-[60vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索或输入模型 ID (如 opus, claude-sonnet-4-6)"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <button
            onClick={onClose}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/50">
          <button
            onClick={onRefresh}
            disabled={modelListLoading}
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${modelListLoading ? "animate-spin" : ""}`} />
            刷新
          </button>
          <span className="flex-1" />
          <span className="text-[10px] text-muted-foreground">{modelList.length} 个模型</span>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {modelListLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              加载模型列表...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-6">
              {canUseAsCustom ? (
                <button
                  onClick={handleUseCustom}
                  className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-primary/50 bg-primary/10 text-foreground hover:bg-primary/20 transition-colors"
                >
                  <span>使用</span>
                  <code className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">{search.trim()}</code>
                  <span>作为模型 ID</span>
                </button>
              ) : (
                <span className="text-sm text-muted-foreground">无可用模型</span>
              )}
              <span className="text-xs text-muted-foreground">
                也可在输入框输入 /model &lt;id&gt; 切换
              </span>
            </div>
          ) : (
            Object.entries(grouped).map(([group, models]) => (
              <div key={group}>
                <div className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {group}
                </div>
                {models.map((m) => {
                  flatIndex++;
                  const idx = flatIndex;
                  const isSelected = m.id === currentModel;
                  const isHighlighted = idx === highlightIndex;
                  return (
                    <div
                      key={m.id}
                      data-index={idx}
                      className={`flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                        isHighlighted
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/50"
                      }`}
                      onMouseEnter={() => setHighlightIndex(idx)}
                      onClick={() => {
                        onSelect(m.id);
                        onClose();
                      }}
                    >
                      <span className="truncate flex-1">{m.name}</span>
                      {m.id !== m.name && (
                        <span className="text-xs text-muted-foreground truncate max-w-[10rem]">
                          {m.id}
                        </span>
                      )}
                      {isSelected && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border text-xs text-muted-foreground flex items-center gap-3">
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">↑↓</kbd> 导航</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">Enter</kbd> 选择</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">Esc</kbd> 关闭</span>
          <span className="flex-1" />
          <span>输入任意 ID 可直接使用</span>
        </div>
      </div>
    </div>
  );
}
