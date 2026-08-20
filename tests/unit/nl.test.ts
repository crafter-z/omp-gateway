import { describe, expect, test } from "bun:test";
import { parseSchedule } from "../../src/scheduler/nl.ts";
import type { ParsedSchedule } from "../../src/scheduler/nl.ts";

/** 表驱动用例（≥15 条）：中英文 NL → cron/interval/once */
const cases: Array<[string, ParsedSchedule]> = [
  // --- 中文 interval ---
  ["每 5 分钟", { kind: "interval", expr: "5m" }],
  ["每2小时", { kind: "interval", expr: "2h" }],
  ["每小时", { kind: "interval", expr: "1h" }],
  ["每 30 分钟", { kind: "interval", expr: "30m" }],
  ["每十分钟", { kind: "interval", expr: "10m" }],
  ["每两小时", { kind: "interval", expr: "2h" }],
  ["每半小时", { kind: "interval", expr: "30m" }],
  ["每天", { kind: "interval", expr: "1d" }],
  // --- 中文 cron ---
  ["每天 9 点", { kind: "cron", expr: "0 0 9 * * *" }],
  ["每天9点半", { kind: "cron", expr: "0 30 9 * * *" }],
  ["每天中午", { kind: "cron", expr: "0 0 12 * * *" }],
  ["每天午夜", { kind: "cron", expr: "0 0 0 * * *" }],
  ["每周一 9点", { kind: "cron", expr: "0 0 9 * * 1" }],
  ["每周日9点", { kind: "cron", expr: "0 0 9 * * 0" }],
  ["每周一", { kind: "cron", expr: "0 0 0 * * 1" }],
  // --- 英文 interval ---
  ["every 5 minutes", { kind: "interval", expr: "5m" }],
  ["every hour", { kind: "interval", expr: "1h" }],
  ["every 2 hours", { kind: "interval", expr: "2h" }],
  ["every day", { kind: "interval", expr: "1d" }],
  ["hourly", { kind: "interval", expr: "1h" }],
  // --- 英文 cron ---
  ["daily at 9am", { kind: "cron", expr: "0 0 9 * * *" }],
  ["every sunday 9am", { kind: "cron", expr: "0 0 9 * * 0" }],
  ["every monday at 9:30pm", { kind: "cron", expr: "0 30 21 * * 1" }],
  ["daily at midnight", { kind: "cron", expr: "0 0 0 * * *" }],
  ["daily at noon", { kind: "cron", expr: "0 0 12 * * *" }],
  ["every day at 8am", { kind: "cron", expr: "0 0 8 * * *" }],
  // --- 英文 once ---
  ["in 30 minutes", { kind: "once", expr: "+30m" }],
  ["in 1 hour", { kind: "once", expr: "+1h" }],
  ["in an hour", { kind: "once", expr: "+1h" }],
  // --- 纯数字/单位与 ISO/相对 ---
  ["5m", { kind: "interval", expr: "5m" }],
  ["30s", { kind: "interval", expr: "30s" }],
  ["2h", { kind: "interval", expr: "2h" }],
  ["1d", { kind: "interval", expr: "1d" }],
  ["+30m", { kind: "once", expr: "+30m" }],
  ["2026-08-20T10:00:00Z", { kind: "once", expr: "2026-08-20T10:00:00Z" }],
];

describe("parseSchedule — 支持用例（表驱动）", () => {
  test.each(cases)("parseSchedule(%p) → %o", (input, expected) => {
    expect(parseSchedule(input)).toEqual(expected);
  });
});

describe("parseSchedule — 容错", () => {
  test("英文大小写不敏感", () => {
    expect(parseSchedule("Every Sunday 9AM")).toEqual({ kind: "cron", expr: "0 0 9 * * 0" });
    expect(parseSchedule("DAILY AT 10:30AM")).toEqual({ kind: "cron", expr: "0 30 10 * * *" });
  });

  test("前后空白修剪", () => {
    expect(parseSchedule("  5m  ")).toEqual({ kind: "interval", expr: "5m" });
    expect(parseSchedule("  每 5 分钟  ")).toEqual({ kind: "interval", expr: "5m" });
  });
});

describe("parseSchedule — 失败用例返回 null", () => {
  test.each([
    "",
    "   ",
    "hello world",
    "every 5",
    "每",
    "每天99点",
    "每天 25 点",
    "每周八",
    "weekly at 9am",
    "in 30",
    "5",
    "+",
    "2026/08/20",
  ])("parseSchedule(%p) → null", (input) => {
    expect(parseSchedule(input)).toBeNull();
  });
});
