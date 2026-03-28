import { useState, useRef, useEffect } from "react";
import { Send, Square, ChevronDown, Bot } from "lucide-react";
import { DEFAULT_CHAT_PANE_ID, useChatStore } from "../../stores/chatStore";
import { ModelSelector } from "./ModelSelector";

interface Props {
  paneId?: string;
  onSend: (prompt: string) => void;
  onCancel: () => void;
  isStreaming: boolean;
  disabled: boolean;
}

/** Derive a short display name from a full model ID. */
function shortModelName(id: string): string {
  return id
    .replace(/-\d{8}$/, "")
    .replace(/^claude-/, "");
}

export function ChatInput({
  paneId = DEFAULT_CHAT_PANE_ID,
  onSend,
  onCancel,
  isStreaming,
  disabled,
}: Props) {
  const [text, setText] = useState("");
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const model = useChatStore((state) => state.getPaneState(paneId).model);
  const setPaneModel = useChatStore((state) => state.setPaneModel);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  // Ctrl+K shortcut to open model selector
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

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    // Slash command: /model [id]
    if (trimmed.startsWith("/model")) {
      const arg = trimmed.slice(6).trim();
      if (arg) {
        setPaneModel(paneId, arg);
      } else {
        setModelSelectorOpen(true);
      }
      setText("");
      return;
    }

    if (disabled) return;
    onSend(trimmed);
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);

  const modelDisplay = model ? shortModelName(model) : "选择模型";

  return (
    <>
      <div className="border-t border-border bg-card px-4 py-3">
        {/* Model selector row */}
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setModelSelectorOpen(true)}
            disabled={isStreaming}
            className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border border-border bg-muted hover:bg-accent/50 transition-colors disabled:opacity-50"
            title={model || "选择模型 (Ctrl+K)"}
          >
            <Bot className="w-3 h-3 text-orange-500" />
            <span className="max-w-[12rem] truncate text-foreground">{modelDisplay}</span>
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          </button>
          <span className="text-[10px] text-muted-foreground">
            Ctrl+K 或 /model 切换
          </span>
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
                : disabled
                  ? "请先选择工作目录"
                  : "输入消息... (Enter 发送, Shift+Enter 换行)"
            }
            disabled={isStreaming || disabled}
            rows={1}
            className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
          {isStreaming ? (
            <button
              onClick={onCancel}
              className="shrink-0 p-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
              title="停止生成"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!text.trim() || disabled}
              className="shrink-0 p-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="发送消息"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Model Selector modal */}
      <ModelSelector
        paneId={paneId}
        open={modelSelectorOpen}
        onClose={() => setModelSelectorOpen(false)}
        onSelect={(m) => setPaneModel(paneId, m)}
      />
    </>
  );
}
