import { useState, useMemo } from "react";
import {
  FileText,
  Pencil,
  FilePlus,
  Terminal,
  Search,
  FolderSearch,
  Globe,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  AlertCircle,
  Code2,
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { DiffView } from "./DiffView";
import { MarkdownContent } from "../../message/MarkdownContent";

/* ── Types ─────────────────────────────────────────── */

interface ToolInput {
  [key: string]: unknown;
}

interface ToolViewerProps {
  name: string;
  input: string; // JSON string
  result?: { content: string; isError: boolean } | null;
}

/* ── Helpers ───────────────────────────────────────── */

function tryParseJson(s: string): ToolInput | null {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    rs: "rust", py: "python", go: "go", rb: "ruby",
    java: "java", kt: "kotlin", swift: "swift", c: "c", cpp: "cpp",
    h: "c", hpp: "cpp", cs: "csharp", php: "php",
    html: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
    sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
    md: "markdown", mdx: "markdown", vue: "markup", svelte: "markup",
    graphql: "graphql", gql: "graphql", dockerfile: "docker",
    r: "r", lua: "lua", dart: "dart", zig: "zig",
  };
  return map[ext] || "text";
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
      title="复制"
    >
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

/* ── Tool icon helper ─────────────────────────────── */

function toolIcon(name: string) {
  const cls = "w-3.5 h-3.5";
  switch (name) {
    case "Read": return <FileText className={cls} />;
    case "Edit": return <Pencil className={cls} />;
    case "Write": return <FilePlus className={cls} />;
    case "Bash": return <Terminal className={cls} />;
    case "Grep": return <Search className={cls} />;
    case "Glob": return <FolderSearch className={cls} />;
    case "WebFetch": case "WebSearch": return <Globe className={cls} />;
    default: return null;
  }
}

/* ── Tool summary helper ──────────────────────────── */

function toolSummary(name: string, parsed: ToolInput | null): string {
  if (!parsed) return "";
  switch (name) {
    case "Read": {
      const fp = String(parsed.file_path || "");
      const offset = parsed.offset ? ` L${parsed.offset}` : "";
      const limit = parsed.limit ? `-${Number(parsed.offset || 1) + Number(parsed.limit)}` : "";
      return fp ? `${getFileName(fp)}${offset}${limit}` : "";
    }
    case "Edit": {
      const fp = String(parsed.file_path || "");
      const old = String(parsed.old_string || "");
      const nw = String(parsed.new_string || "");
      const oldLines = old.split("\n").length;
      const newLines = nw.split("\n").length;
      return fp ? `${getFileName(fp)} ${oldLines} → ${newLines} 行` : "";
    }
    case "Write": {
      const fp = String(parsed.file_path || "");
      const content = String(parsed.content || "");
      const lines = content.split("\n").length;
      return fp ? `${getFileName(fp)} ${lines} 行` : "";
    }
    case "Bash": {
      return String(parsed.command || "");
    }
    case "Grep": {
      const pat = String(parsed.pattern || "");
      const path = parsed.path ? ` in ${getFileName(String(parsed.path))}` : "";
      return `"${pat}"${path}`;
    }
    case "Glob": {
      const pat = String(parsed.pattern || "");
      return pat;
    }
    default:
      return "";
  }
}

/* ── Main ToolViewer ──────────────────────────────── */

export function ToolViewer({ name, input, result }: ToolViewerProps) {
  const [expanded, setExpanded] = useState(true);
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const parsed = useMemo(() => tryParseJson(input), [input]);
  const summary = useMemo(() => toolSummary(name, parsed), [name, parsed]);
  const hasError = result?.isError ?? false;

  return (
    <div
      className={`mt-2 mb-2 border rounded-md overflow-hidden ${
        hasError ? "border-red-500/30" : "border-border"
      }`}
    >
      {/* Header */}
      <div
        className={`flex items-center text-xs transition-colors ${
          hasError
            ? "bg-red-500/5 hover:bg-red-500/10"
            : "bg-muted/50 hover:bg-muted"
        }`}
      >
        {/* 主点击区域：展开/折叠 */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 flex items-center gap-2 px-3 py-2 min-w-0"
        >
          {toolIcon(name) || <div className="w-3.5 h-3.5" />}
          <span className="font-mono font-medium">{name}</span>
          {summary && (
            <span className="text-muted-foreground truncate max-w-[20rem]">
              {summary}
            </span>
          )}
          {hasError && <AlertCircle className="w-3 h-3 text-red-400" />}
        </button>

        {/* Code/Preview 切换按钮 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!expanded) {
              setExpanded(true);
              setViewMode("code");
            } else {
              setViewMode(viewMode === "code" ? "preview" : "code");
            }
          }}
          className={`shrink-0 px-2 py-2 transition-colors ${
            viewMode === "code" && expanded
              ? "text-blue-400"
              : "text-muted-foreground hover:text-foreground"
          }`}
          title={!expanded ? "展开并显示原始 JSON" : viewMode === "code" ? "切换到预览模式" : "切换到原始 JSON"}
        >
          <Code2 className="w-3.5 h-3.5" />
        </button>

        {/* 折叠/展开箭头 */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 px-2 py-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border">
          {viewMode === "code" ? (
            <div className="relative group">
              <div className="absolute right-2 top-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                <CopyButton text={input} />
              </div>
              <SyntaxHighlighter
                style={oneDark}
                language="json"
                wrapLongLines={true}
                customStyle={{ margin: 0, borderRadius: 0, fontSize: "11px", maxHeight: "24rem" }}
              >
                {input.length > 15000
                  ? input.slice(0, 15000) + "\n... (truncated)"
                  : input}
              </SyntaxHighlighter>
            </div>
          ) : (
            <ToolContent name={name} parsed={parsed} rawInput={input} result={result} />
          )}
        </div>
      )}
    </div>
  );
}

/* ── Content dispatcher ───────────────────────────── */

function ToolContent({
  name,
  parsed,
  rawInput,
  result,
}: {
  name: string;
  parsed: ToolInput | null;
  rawInput: string;
  result?: { content: string; isError: boolean } | null;
}) {
  switch (name) {
    case "Read":
      return <ReadContent parsed={parsed} result={result} />;
    case "Edit":
      return <EditContent parsed={parsed} result={result} />;
    case "Write":
      return <WriteContent parsed={parsed} result={result} />;
    case "Bash":
      return <BashContent parsed={parsed} result={result} />;
    case "Grep":
    case "Glob":
      return <SearchContent name={name} parsed={parsed} result={result} />;
    default:
      return <DefaultContent parsed={parsed} rawInput={rawInput} result={result} />;
  }
}

/* ── Read ─────────────────────────────────────────── */

function ReadContent({
  parsed,
  result,
}: {
  parsed: ToolInput | null;
  result?: { content: string; isError: boolean } | null;
}) {
  const filePath = String(parsed?.file_path || "");
  const lang = getLanguageFromPath(filePath);
  const content = result?.content || "";

  if (result?.isError) {
    return <ErrorBlock content={content} />;
  }

  if (!content) {
    return <div className="p-3 text-xs text-muted-foreground">无内容</div>;
  }

  const display = content.length > 15000 ? content.slice(0, 15000) + "\n... (truncated)" : content;

  return (
    <div className="relative group">
      <div className="absolute right-2 top-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={content} />
      </div>
      {lang === "markdown" ? (
        <MarkdownContent content={display} />
      ) : (
        <SyntaxHighlighter
          style={oneDark}
          language={lang}
          showLineNumbers
          startingLineNumber={parsed?.offset ? Number(parsed.offset) : 1}
          customStyle={{ margin: 0, borderRadius: 0, fontSize: "11px", maxHeight: "24rem" }}
          lineNumberStyle={{ minWidth: "2.5em", opacity: 0.4 }}
        >
          {display}
        </SyntaxHighlighter>
      )}
    </div>
  );
}

/* ── Edit ─────────────────────────────────────────── */

function EditContent({
  parsed,
  result,
}: {
  parsed: ToolInput | null;
  result?: { content: string; isError: boolean } | null;
}) {
  const filePath = String(parsed?.file_path || "");
  const oldString = String(parsed?.old_string || "");
  const newString = String(parsed?.new_string || "");

  if (result?.isError) {
    return <ErrorBlock content={result.content} />;
  }

  if (!oldString && !newString) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {result?.content || "无变更内容"}
      </div>
    );
  }

  return (
    <div>
      <DiffView oldString={oldString} newString={newString} fileName={getFileName(filePath)} />
      {result?.content && !result.content.startsWith("The file") && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground border-t border-border bg-muted/20">
          {result.content.length > 200 ? result.content.slice(0, 200) + "..." : result.content}
        </div>
      )}
    </div>
  );
}

/* ── Write ────────────────────────────────────────── */

function WriteContent({
  parsed,
  result,
}: {
  parsed: ToolInput | null;
  result?: { content: string; isError: boolean } | null;
}) {
  const filePath = String(parsed?.file_path || "");
  const content = String(parsed?.content || "");
  const lang = getLanguageFromPath(filePath);

  if (result?.isError) {
    return <ErrorBlock content={result.content} />;
  }

  if (!content) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {result?.content || "无写入内容"}
      </div>
    );
  }

  const display = content.length > 15000 ? content.slice(0, 15000) + "\n... (truncated)" : content;

  return (
    <div className="relative group">
      <div className="absolute right-2 top-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={content} />
      </div>
      {lang === "markdown" ? (
        <MarkdownContent content={display} />
      ) : (
        <SyntaxHighlighter
          style={oneDark}
          language={lang}
          showLineNumbers
          customStyle={{ margin: 0, borderRadius: 0, fontSize: "11px", maxHeight: "24rem" }}
          lineNumberStyle={{ minWidth: "2.5em", opacity: 0.4 }}
        >
          {display}
        </SyntaxHighlighter>
      )}
    </div>
  );
}

/* ── Bash ─────────────────────────────────────────── */

function BashContent({
  parsed,
  result,
}: {
  parsed: ToolInput | null;
  result?: { content: string; isError: boolean } | null;
}) {
  const command = String(parsed?.command || "");
  const description = String(parsed?.description || "");
  const output = result?.content || "";

  return (
    <div>
      {/* Command */}
      {description && (
        <div className="px-3 py-1 text-xs text-muted-foreground bg-muted/30 border-b border-border">
          {description}
        </div>
      )}
      <div className="flex items-start gap-2 px-3 py-2 bg-[#1e1e1e] font-mono text-xs">
        <span className="text-green-400 select-none shrink-0">$</span>
        <pre className="whitespace-pre-wrap break-all text-[#d4d4d4]">{command}</pre>
      </div>

      {/* Output */}
      {output && (
        <div
          className={`relative group border-t border-border ${
            result?.isError ? "bg-red-500/5" : "bg-[#1e1e1e]"
          }`}
        >
          <div className="absolute right-2 top-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <CopyButton text={output} />
          </div>
          <pre
            className={`px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto ${
              result?.isError ? "text-red-400" : "text-muted-foreground"
            }`}
          >
            {output.length > 10000 ? output.slice(0, 10000) + "\n... (truncated)" : output}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ── Grep / Glob ──────────────────────────────────── */

function SearchContent({
  name,
  parsed,
  result,
}: {
  name: string;
  parsed: ToolInput | null;
  result?: { content: string; isError: boolean } | null;
}) {
  const output = result?.content || "";
  const pattern = String(parsed?.pattern || "");
  const path = String(parsed?.path || "");

  return (
    <div>
      {/* Search params */}
      <div className="px-3 py-1.5 bg-muted/30 border-b border-border text-xs font-mono">
        <span className="text-muted-foreground">{name === "Grep" ? "pattern" : "glob"}: </span>
        <span className="text-orange-400">{pattern}</span>
        {path && (
          <>
            <span className="text-muted-foreground ml-2">in </span>
            <span>{getFileName(path)}</span>
          </>
        )}
      </div>

      {/* Results */}
      {output && (
        <div className="relative group">
          <div className="absolute right-2 top-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <CopyButton text={output} />
          </div>
          <pre
            className={`px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto ${
              result?.isError ? "text-red-400" : "text-muted-foreground"
            }`}
          >
            {output.length > 10000 ? output.slice(0, 10000) + "\n... (truncated)" : output}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ── Default (generic tool) ───────────────────────── */

// Fields that carry no useful meaning for readers — always hidden
const HIDDEN_FIELDS = new Set([
  "timeout",
  "run_in_background",
  "dangerouslyDisableSandbox",
  "isolation",
]);

// Priority display order for well-known fields, with Chinese labels and code-block hint
const FIELD_META: Record<string, { label: string; code?: boolean }> = {
  command:     { label: "命令",   code: true  },
  file_path:   { label: "文件"               },
  description: { label: "描述"               },
  pattern:     { label: "模式",   code: true  },
  path:        { label: "路径"               },
  url:         { label: "地址"               },
  prompt:      { label: "提示词"             },
  query:       { label: "查询"               },
  content:     { label: "内容",   code: true  },
  text:        { label: "文本"               },
  code:        { label: "代码",   code: true  },
  element:     { label: "元素"               },
  skill:       { label: "技能"               },
  args:        { label: "参数"               },
  taskId:      { label: "任务ID"             },
  subject:     { label: "主题"               },
  status:      { label: "状态"               },
  questions:   { label: "问题"               },
  new_string:  { label: "新内容", code: true  },
  old_string:  { label: "旧内容", code: true  },
};

const PRIORITY_ORDER = [
  "command", "file_path", "description", "pattern", "path",
  "url", "prompt", "query", "content", "text", "code",
];

function FieldList({ parsed }: { parsed: ToolInput }) {
  const entries = Object.entries(parsed).filter(([k]) => !HIDDEN_FIELDS.has(k));

  // Known fields first (in priority order), then the rest alphabetically
  entries.sort(([a], [b]) => {
    const ai = PRIORITY_ORDER.indexOf(a);
    const bi = PRIORITY_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  if (entries.length === 0) return null;

  return (
    <div className="divide-y divide-border/50">
      {entries.map(([key, value]) => {
        const meta = FIELD_META[key];
        const label = meta?.label ?? key;
        const strVal =
          typeof value === "string" ? value : JSON.stringify(value, null, 2);
        const isCode = meta?.code ?? false;
        const isBlock = isCode || strVal.includes("\n") || strVal.length > 80;

        return (
          <div key={key} className="flex text-xs">
            {/* Fixed-width label column — right-aligned for clean grid feel */}
            <span className="shrink-0 w-[4.5rem] px-3 py-1.5 text-right text-muted-foreground bg-muted/30 font-sans select-none">
              {label}
            </span>
            {isBlock ? (
              <pre className="flex-1 px-3 py-1.5 font-mono text-[11px] whitespace-pre-wrap break-all bg-[#1e1e1e] text-foreground overflow-x-auto max-h-48 overflow-y-auto">
                {strVal.length > 5000 ? strVal.slice(0, 5000) + "…" : strVal}
              </pre>
            ) : (
              <span className="flex-1 px-3 py-1.5 break-all">{strVal}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DefaultContent({
  parsed,
  rawInput,
  result,
}: {
  parsed: ToolInput | null;
  rawInput: string;
  result?: { content: string; isError: boolean } | null;
}) {
  const output = result?.content || "";

  return (
    <div>
      {/* Input: structured fields or raw fallback */}
      {parsed ? (
        <FieldList parsed={parsed} />
      ) : (
        <div className="p-3 text-xs font-mono bg-muted/20 overflow-x-auto max-h-40 overflow-y-auto border-b border-border">
          <pre className="whitespace-pre-wrap break-all">
            {rawInput.length > 5000 ? rawInput.slice(0, 5000) + "\n…" : rawInput}
          </pre>
        </div>
      )}

      {/* Output */}
      {output && (
        <pre
          className={`p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto border-t border-border ${
            result?.isError ? "text-red-400 bg-red-500/5" : "text-muted-foreground"
          }`}
        >
          {output.length > 10000 ? output.slice(0, 10000) + "\n…" : output}
        </pre>
      )}
    </div>
  );
}

/* ── Shared error block ───────────────────────────── */

function ErrorBlock({ content }: { content: string }) {
  return (
    <div className="p-3 text-xs font-mono text-red-400 bg-red-500/5 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
      {content.length > 5000 ? content.slice(0, 5000) + "\n... (truncated)" : content}
    </div>
  );
}
