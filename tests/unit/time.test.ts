import { describe, expect, test } from "bun:test";
import { formatIso, nowIso, parseRelativeOrIso } from "../../src/util/time.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("nowIso", () => {
  test("returns a UTC ISO-8601 timestamp close to the current time", () => {
    const iso = nowIso();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(new Date(iso).getTime() - Date.now())).toBeLessThan(5_000);
  });
});

describe("parseRelativeOrIso", () => {
  test("+30m is about 30 minutes in the future", () => {
    const d = parseRelativeOrIso("+30m");
    expect(d).not.toBeNull();
    const delta = d!.getTime() - Date.now();
    expect(delta).toBeGreaterThan(29 * MINUTE);
    expect(delta).toBeLessThan(31 * MINUTE);
  });

  test("unsigned relative durations mean future", () => {
    const cases: Array<[string, number]> = [
      ["5m", 5 * MINUTE],
      ["1h", HOUR],
      ["2d", 2 * DAY],
      ["30s", 30_000],
    ];
    for (const [input, expectedMs] of cases) {
      const d = parseRelativeOrIso(input);
      expect(d, input).not.toBeNull();
      const delta = d!.getTime() - Date.now();
      expect(delta, input).toBeGreaterThan(expectedMs - 60_000);
      expect(delta, input).toBeLessThan(expectedMs + 2_000);
    }
  });

  test("leading - means past", () => {
    const d = parseRelativeOrIso("-1h");
    expect(d).not.toBeNull();
    const delta = d!.getTime() - Date.now();
    expect(delta).toBeLessThan(-59 * MINUTE);
    expect(delta).toBeGreaterThan(-61 * MINUTE);
  });

  test("ISO timestamp with Z is parsed as UTC", () => {
    const d = parseRelativeOrIso("2026-08-20T10:30:00Z");
    expect(d?.getTime()).toBe(Date.UTC(2026, 7, 20, 10, 30, 0));
  });

  test("ISO timestamp with milliseconds and offset is parsed exactly", () => {
    const d = parseRelativeOrIso("2026-08-20T10:30:00.500+08:00");
    expect(d?.getTime()).toBe(Date.UTC(2026, 7, 20, 2, 30, 0, 500));
  });

  test("date-only ISO is parsed as UTC midnight", () => {
    const d = parseRelativeOrIso("2026-08-20");
    expect(d?.getTime()).toBe(Date.UTC(2026, 7, 20));
  });

  test("round-trips through formatIso", () => {
    const d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(parseRelativeOrIso(formatIso(d))?.getTime()).toBe(d.getTime());
  });

  test("returns null for unparsable input", () => {
    for (const bad of ["", "  ", "abc", "tomorrow", "1y", "10m30s", "m", "+", "5", "2026-13-45"]) {
      expect(parseRelativeOrIso(bad), bad).toBeNull();
    }
  });
});

describe("formatIso", () => {
  test("formats a Date as UTC ISO-8601", () => {
    const d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(formatIso(d)).toBe("2026-01-02T03:04:05.000Z");
  });
});
