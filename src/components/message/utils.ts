import { format } from "date-fns";

export function formatTime(timestamp: string): string {
  try {
    return format(new Date(timestamp), "yyyy-MM-dd HH:mm:ss");
  } catch {
    return timestamp;
  }
}

export function stripControlChars(text: string): string {
  if (!text) return text ?? "";
  return (
    text
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
  );
}

/**
 * Strip XML-like tags injected by Claude Code runtime.
 * - Tags whose content should be fully removed (system metadata):
 *   <system-reminder>...</system-reminder>
 * - Tags that are stripped but inner content is kept (structural wrappers):
 *   <function_calls>, </function_calls>, <invoke>, </invoke>,
 *   <parameter>, </parameter>, <*>, etc.
 */
export function stripXmlTags(text: string): string {
  if (!text) return text ?? "";
  return (
    text
      // Remove entire <system-reminder>...</system-reminder> blocks (may span multiple lines)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      // Remove entire <local-command-caveat>...</local-command-caveat> blocks
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
      // Remove entire <command-name>...</command-name>, <command-message>, <command-args>, <local-command-stdout> blocks
      .replace(/<(?:command-name|command-message|command-args|local-command-stdout)>[\s\S]*?<\/(?:command-name|command-message|command-args|local-command-stdout)>/g, "")
      // Remove structural wrapper tags (keep inner text):
      // <function_calls>, <invoke>, <parameter>, <*>, <result>, <output>, <error>
      .replace(/<\/?(?:function_calls|antml:[\w-]+|invoke|parameter|result|output|error)(?:\s[^>]*)?\s*>/g, "")
      // Remove self-closing variants
      .replace(/<(?:function_calls|antml:[\w-]+|invoke|parameter)(?:\s[^>]*)?\s*\/>/g, "")
      // Collapse 3+ consecutive blank lines into 2
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function cleanMessageText(text: string): string {
  if (!text) return text ?? "";
  return stripXmlTags(stripControlChars(stripAnsi(text)));
}

/**
 * Detect lines that look like ASCII art/diagrams and wrap consecutive
 * ASCII-art lines in fenced code blocks so ReactMarkdown renders them
 * with monospace font and preserved whitespace.
 */
export function wrapAsciiArt(text: string): string {
  if (!text) return text ?? "";
  const lines = text.split("\n");
  const result: string[] = [];
  let inArt = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isAsciiArtLine(line)) {
      if (!inArt) {
        // Don't wrap if already inside a code fence
        if (!isInsideCodeFence(lines, i)) {
          result.push("```");
          inArt = true;
        }
      }
      result.push(line);
    } else {
      if (inArt) {
        result.push("```");
        inArt = false;
      }
      result.push(line);
    }
  }
  if (inArt) {
    result.push("```");
  }
  return result.join("\n");
}

function isAsciiArtLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Exclude markdown table separator rows: |---|---|, | --- | :---: | ---: |
  if (/^\|(\s*:?-+:?\s*\|)+$/.test(trimmed)) return false;
  // Box-drawing characters (Unicode)
  if (/[│┌┐└┘├┤┬┴┼─═║╔╗╚╝╠╣╦╩╬┊┈╌╎]/.test(trimmed)) return true;
  // Lines forming ASCII box/table patterns: |---+---|, +---+---+
  if (/^[|+][-=.]{3,}[|+]/.test(trimmed)) return true;
  // Lines with multiple pipes and dashes suggesting a diagram row
  if (/\|.*[-─]{3,}.*\|/.test(trimmed)) return true;
  // Lines that are mostly special chars (arrows, pipes, slashes forming diagrams)
  // At least 40% of non-space chars are special diagram chars
  const nonSpace = trimmed.replace(/\s/g, "");
  if (nonSpace.length >= 5) {
    const specialCount = (nonSpace.match(/[|+\-─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬←→↑↓↔⇐⇒\\/_\\[\]{}()]/g) || []).length;
    if (specialCount / nonSpace.length > 0.5) return true;
  }
  return false;
}

function isInsideCodeFence(lines: string[], index: number): boolean {
  let fenceCount = 0;
  for (let i = 0; i < index; i++) {
    if (/^```/.test(lines[i].trim())) fenceCount++;
  }
  return fenceCount % 2 === 1; // Odd count means inside a fence
}

/**
 * Remove ANSI escape codes from terminal output.
 * Covers color codes, cursor movement, erase sequences, etc.
 */
export function stripAnsi(text: string): string {
  if (!text) return text ?? "";
  return (
    text
      // OSC sequences: \x1b] ... \x07 or \x1b\  (e.g. window title)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // CSI sequences: covers standard + private mode (with ? # ; digits)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, "")
      // Remaining lone ESC + single char (e.g. \x1bM scroll up, \x1bc reset)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[A-Za-z]/g, "")
      // Standalone BEL characters that may remain
      // eslint-disable-next-line no-control-regex
      .replace(/\x07/g, "")
  );
}
