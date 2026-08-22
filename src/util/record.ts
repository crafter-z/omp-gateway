/**
 * Canonical runtime record guard for the whole repo (project rule:
 * ts-no-local-is-record — never redefine this at call sites).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
