/**
 * Time helpers: UTC ISO timestamps, ISO/relative duration parsing, formatting.
 */

const RELATIVE_RE = /^([+-])?(\d+)\s*([smhd])$/i;

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** ISO-like: date-only, or date + time (T/space) with optional seconds/fraction and optional zone. */
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Current time as a UTC ISO-8601 string (e.g. `2026-08-20T10:30:00.123Z`).
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parse either an ISO-8601 timestamp or a relative duration (`+30m`, `5m`,
 * `1h`, `2d`; seconds `s` also accepted). A leading `-` means past, anything
 * else means future. Returns null when the input cannot be parsed.
 */
export function parseRelativeOrIso(s: string): Date | null {
  const input = s.trim();
  if (input.length === 0) return null;

  const rel = RELATIVE_RE.exec(input);
  if (rel !== null) {
    const sign = rel[1] === "-" ? -1 : 1;
    const amount = Number(rel[2]);
    const unit = UNIT_MS[rel[3].toLowerCase()];
    return new Date(Date.now() + sign * amount * unit);
  }

  if (!ISO_RE.test(input)) return null;
  const t = Date.parse(input);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Format a Date as a UTC ISO-8601 string.
 */
export function formatIso(d: Date): string {
  return d.toISOString();
}
