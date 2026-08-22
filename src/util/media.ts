/**
 * Media-tag extraction + markdown stripping for QQ delivery (hermes parity:
 * MEDIA:<path> tags; strip_markdown when markdown_support is off).
 */

/** Extract MEDIA:<path> tags (own-line or inline); returns cleaned text + paths. */
export function extractMediaTags(text: string): { text: string; media: string[] } {
  const media: string[] = [];
  const cleaned = text.replace(/MEDIA:\s*(\S+)/g, (_m, path: string) => {
    media.push(path);
    return "";
  });
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), media };
}

/** Minimal markdown → plain text for non-markdown QQ mode. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.split("\n").slice(1, -1).join("\n").trim() || "[code]")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$2") // image → url
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)") // link → text (url)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^>+\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, "")
    .trim();
}
