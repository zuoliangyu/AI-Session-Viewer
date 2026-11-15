/** Conversation text must not navigate the privileged desktop WebView. */
export function safeMarkdownHref(href: string | undefined): string | null {
  if (!href || /[\u0000-\u0020\u007f\\]/.test(href)) return null;
  if (href.startsWith("#")) return href;
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function openMarkdownExternalLink(href: string): Promise<void> {
  const safeHref = safeMarkdownHref(href);
  if (!safeHref || safeHref.startsWith("#")) return;
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(safeHref);
}
