import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { cleanMessageText, wrapAsciiArt } from "./utils";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={className ?? "p-3 prose prose-sm max-w-none text-xs leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children }) {
            const match = /language-(\w+)/.exec(className || "");
            const codeStr = String(children).replace(/\n$/, "");
            if (match) {
              return (
                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                  className="rounded text-[11px] !mt-1.5 !mb-1.5"
                >
                  {codeStr}
                </SyntaxHighlighter>
              );
            }
            return (
              <code className="bg-muted px-1 py-0.5 rounded text-[11px] font-mono">
                {children}
              </code>
            );
          },
          pre({ children }) {
            return (
              <div className="not-prose my-1.5">
                <pre className="rounded-md bg-muted border border-border p-3 text-xs font-mono overflow-x-auto [&>code]:bg-transparent [&>code]:p-0 [&>code]:rounded-none">
                  {children}
                </pre>
              </div>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="min-w-full text-xs border-collapse border border-border rounded">
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="bg-muted/50 px-3 py-1.5 text-left text-xs font-medium border border-border">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="px-3 py-1.5 text-xs border border-border">
                {children}
              </td>
            );
          },
        }}
      >
        {wrapAsciiArt(cleanMessageText(content))}
      </ReactMarkdown>
    </div>
  );
}
