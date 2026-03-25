import { useMemo } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useAppStore } from "../../stores/appStore";
import {
  FolderOpen,
  Bot,
  CircleDot,
  Shield,
  ShieldOff,
  Cpu,
} from "lucide-react";

export function ChatHeader() {
  const {
    projectPath,
    messages,
    isStreaming,
    availableClis,
    skipPermissions,
    setSkipPermissions,
  } = useChatStore();

  const appSource = useAppStore((s) => s.source);
  const cliLabel = appSource === "codex" ? "Codex" : "Claude";
  const cliInfo = availableClis.find((c) => c.cliType === appSource);

  // Aggregate token stats
  const tokenStats = useMemo(() => {
    let input = 0;
    let output = 0;
    let cacheWrite = 0;
    let cacheRead = 0;
    for (const msg of messages) {
      if (msg.usage) {
        input += msg.usage.inputTokens;
        output += msg.usage.outputTokens;
        cacheWrite += msg.usage.cacheCreationInputTokens;
        cacheRead += msg.usage.cacheReadInputTokens;
      }
    }
    return { input, output, cacheWrite, cacheRead, total: input + output };
  }, [messages]);

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card">
      {/* Source indicator */}
      <div className="flex items-center gap-1.5">
        <Bot className="w-4 h-4 text-orange-500" />
        <span className="text-sm font-medium">{cliLabel}</span>
      </div>

      {/* CLI status */}
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <CircleDot
          className={`w-3 h-3 ${cliInfo ? "text-green-500" : "text-red-500"}`}
        />
        <span>
          {cliInfo
            ? cliInfo.version
              ? `v${cliInfo.version}`
              : "已安装"
            : "未检测到"}
        </span>
      </div>

      {/* Project path */}
      {projectPath && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground max-w-[200px]">
          <FolderOpen className="w-3 h-3 shrink-0" />
          <span className="truncate" title={projectPath}>
            {projectPath.split(/[\\/]/).pop()}
          </span>
        </div>
      )}

      {/* Token stats */}
      {tokenStats.total > 0 && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground tabular-nums">
          <Cpu className="w-3 h-3 shrink-0" />
          <span title="输入 tokens">入 {tokenStats.input.toLocaleString()}</span>
          <span className="opacity-30">|</span>
          <span title="输出 tokens">出 {tokenStats.output.toLocaleString()}</span>
          {tokenStats.cacheWrite > 0 && (
            <>
              <span className="opacity-30">|</span>
              <span title="写入缓存 tokens">写缓存 {tokenStats.cacheWrite.toLocaleString()}</span>
            </>
          )}
          {tokenStats.cacheRead > 0 && (
            <>
              <span className="opacity-30">|</span>
              <span title="读取缓存 tokens">读缓存 {tokenStats.cacheRead.toLocaleString()}</span>
            </>
          )}
        </div>
      )}

      <div className="flex-1" />

      {/* Skip permissions toggle */}
      <button
        onClick={() => setSkipPermissions(!skipPermissions)}
        disabled={isStreaming}
        className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
          skipPermissions
            ? "border-yellow-500/50 bg-yellow-500/10 text-yellow-500"
            : "border-border bg-muted text-muted-foreground hover:text-foreground"
        } disabled:opacity-50`}
        title={
          skipPermissions
            ? "已跳过权限确认（危险模式）"
            : "正常权限模式"
        }
      >
        {skipPermissions ? (
          <ShieldOff className="w-3 h-3" />
        ) : (
          <Shield className="w-3 h-3" />
        )}
        <span className="hidden sm:inline">
          {skipPermissions ? "跳过权限" : "正常权限"}
        </span>
      </button>

      {/* Streaming indicator */}
      {isStreaming && (
        <div className="flex items-center gap-1.5 text-xs text-blue-400">
          <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
          对话中...
        </div>
      )}
    </div>
  );
}
