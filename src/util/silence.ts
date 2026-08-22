/**
 * Silence handling (hermes parity):
 * - isAutonomousSilenceResponse: [SILENT] / SILENT / NO_REPLY markers as the
 *   whole response, first line, or last line (case-insensitive; mid-sentence
 *   occurrences are protected).
 * - filterSilenceNarration: drops hallucinated silence tokens (*(silent)*,
 *   🔇, bare ".", "…") at the substrate level so they never reach the chat.
 */

const BRACKETED_RE = /^\s*\[(SILENT|NO_REPLY)\]\s*$/i;
const BRACKETED_FIRST_LINE = /^\s*\[(SILENT|NO_REPLY)\]\s*[\r\n]/i;
const BRACKETED_LAST_LINE = /[\r\n]\s*\[(SILENT|NO_REPLY)\]\s*$/i;
const BARE_RE = /^\s*(SILENT|NO_REPLY)\s*$/i;
const BARE_FIRST_LINE = /^\s*(SILENT|NO_REPLY)\s*[\r\n]/i;
const BARE_LAST_LINE = /[\r\n]\s*(SILENT|NO_REPLY)\s*$/i;

/** True when the whole response, its first line, or its last line is a silence marker. */
export function isAutonomousSilenceResponse(text: string): boolean {
  if (!text) return true; // empty output is effectively silent
  const trimmed = text.trim();
  if (BRACKETED_RE.test(trimmed) || BARE_RE.test(trimmed)) return true;
  if (BRACKETED_FIRST_LINE.test(text) || BRACKETED_LAST_LINE.test(text)) return true;
  if (BARE_FIRST_LINE.test(text) || BARE_LAST_LINE.test(text)) return true;
  return false;
}

/** Tokens models hallucinate as "silence" narration; dropped before delivery. */
const SILENCE_NARRATION =
  /(\*\(silent\)\*|\*\(Silent\)\*|🔇|🔕|\(silent\)|\[silent\])|(^|\n)\s*[.\u2026]+\s*($|\n)/g;

/** Remove silence-narration tokens; returns the cleaned text. */
export function filterSilenceNarration(text: string): string {
  const cleaned = text.replace(SILENCE_NARRATION, "");
  // Collapse the triple-newline artifacts produced by dropping whole lines.
  return cleaned.replace(/\n{3,}/g, "\n\n");
}
