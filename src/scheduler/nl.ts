/**
 * 自然语言 → 调度表达式（docs/02-contracts.md §3.1，P5）。
 * 中英文关键词映射 → cron（6 字段含秒，秒位 0）/ interval / once；解析失败返回 null，
 * 由调用方报错并列出支持格式。时区无关（cron 输出为分钟级 6 字段）。
 */

export interface ParsedSchedule {
  kind: "cron" | "interval" | "once";
  expr: string;
}

/** ISO 时间戳（日期，或日期+时间，可选秒/时区） */
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** 中文数字（一~十）基本映射 */
const CN_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const CN_UNIT: Record<string, string> = {
  秒: "s",
  分钟: "m",
  小时: "h",
  钟头: "h",
  天: "d",
  日: "d",
};

/** 中文星期：日/天 → 0（cron 周日） */
const CN_WEEKDAY: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
};

const EN_UNIT: Record<string, string> = {
  second: "s",
  minute: "m",
  hour: "h",
  day: "d",
};

const EN_WEEKDAY: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** 中文时间片段：9点 / 9点半 / 9点30分 / 中午 / 午夜 / 凌晨 */
const CN_TIME =
  "[0-9一二两三四五六七八九十]+[点时](?:半|[0-9一二两三四五六七八九十]+分)?|中午|午夜|凌晨";

/** interval 单位上限（对齐 scheduler/expr.ts 的 croner 步长限制） */
const INTERVAL_MAX: Record<string, number> = { s: 59, m: 59, h: 23, d: 31 };

export function parseSchedule(input: string): ParsedSchedule | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw.length === 0) return null;

  // 1) 纯 interval："5m" / "30s" / "2h" / "1d"
  const bareInterval = /^(\d+)\s*([smhd])$/i.exec(raw);
  if (bareInterval) {
    const n = parseInt(bareInterval[1], 10);
    if (n <= 0 || n > INTERVAL_MAX[bareInterval[2].toLowerCase()]) return null;
    return { kind: "interval", expr: `${n}${bareInterval[2].toLowerCase()}` };
  }

  // 2) once：相对 "+30m" 或 ISO 时间戳
  if (raw.startsWith("+")) {
    const rel = /^\+(\d+)([smhd])$/i.exec(raw);
    if (rel) {
      const n = parseInt(rel[1], 10);
      if (n <= 0) return null;
      return { kind: "once", expr: `+${n}${rel[2].toLowerCase()}` };
    }
    return null;
  }
  if (ISO_RE.test(raw)) {
    return { kind: "once", expr: raw };
  }

  // 3) 中文
  const cn = parseChinese(raw);
  if (cn) return cn;

  // 4) 英文（大小写不敏感）
  const en = parseEnglish(raw.toLowerCase());
  if (en) return en;

  return null;
}

function parseChinese(raw: string): ParsedSchedule | null {
  const s = raw.replace(/\s+/g, ""); // 中文模式忽略空白
  if (s.length === 0) return null;

  // 每 N 单位（阿拉伯数字或中文数字）：每5分钟 / 每 2 小时 / 每十分钟 / 每两小时
  let m = /^每(?:隔)?([0-9一二两三四五六七八九十]+)(秒|分钟|小时|钟头|天|日)$/.exec(s);
  if (m) {
    const n = cnNum(m[1]!);
    const unit = CN_UNIT[m[2]!];
    if (n === null || n <= 0 || n > INTERVAL_MAX[unit]) return null;
    return { kind: "interval", expr: `${n}${unit}` };
  }

  // 每半小时 / 每半个钟头
  if (/^每(?:隔)?半个?(?:小时|钟头)?$/.test(s)) {
    return { kind: "interval", expr: "30m" };
  }

  // 每秒 / 每分钟 / 每小时 / 每天（无数字）
  m = /^每(?:隔)?(秒|分钟|小时|钟头|天|日)$/.exec(s);
  if (m) {
    return { kind: "interval", expr: `1${CN_UNIT[m[1]!]!}` };
  }

  // 每周X [时间]：每周一9点 / 每周日 9点
  m = new RegExp(`^每(?:隔)?周([一二三四五六日天])((?:${CN_TIME})?)$`).exec(s);
  if (m) {
    const dow = CN_WEEKDAY[m[1]!];
    if (dow === undefined) return null;
    const t = m[2] ? cnTime(m[2]!) : { h: 0, m: 0 }; // 无时间默认午夜
    if (!t) return null;
    return { kind: "cron", expr: toCron(t.h, t.m, "*", "*", String(dow)) };
  }

  // 每天 [时间]：每天9点 / 每天中午 / 每天 9点半
  m = new RegExp(`^每(?:隔)?天((?:${CN_TIME})?)$`).exec(s);
  if (m) {
    if (!m[1]) return { kind: "interval", expr: "1d" }; // 每天 无时间 → interval 1d
    const t = cnTime(m[1]!);
    if (!t) return null;
    return { kind: "cron", expr: toCron(t.h, t.m, "*", "*", "*") };
  }

  return null;
}

function parseEnglish(s: string): ParsedSchedule | null {
  // every N unit：every 5 minutes / every 2 hours
  let m = /^every\s+(\d+)\s+(second|minute|hour|day)s?$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = EN_UNIT[m[2]!];
    if (n <= 0 || n > INTERVAL_MAX[unit]) return null;
    return { kind: "interval", expr: `${n}${unit}` };
  }

  // every hour / every minute / every day
  m = /^every\s+(second|minute|hour|day)s?$/.exec(s);
  if (m) {
    return { kind: "interval", expr: `1${EN_UNIT[m[1]!]!}` };
  }
  if (s === "hourly") return { kind: "interval", expr: "1h" };

  // in N unit / in an hour → once
  m = /^in\s+(\d+)\s+(second|minute|hour|day)s?$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n <= 0) return null;
    return { kind: "once", expr: `+${n}${EN_UNIT[m[2]!]!}` };
  }
  m = /^in\s+an?\s+(second|minute|hour|day)$/.exec(s);
  if (m) {
    return { kind: "once", expr: `+1${EN_UNIT[m[1]!]!}` };
  }

  // every <weekday> [at] <time>：every sunday 9am / every monday at 9:30pm
  m = /^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:at\s+)?(.+))?$/.exec(s);
  if (m) {
    const dow = EN_WEEKDAY[m[1]!]!;
    const t = m[2] !== undefined ? enTime(m[2]!) : { h: 0, m: 0 }; // 无时间默认午夜
    if (!t) return null;
    return { kind: "cron", expr: toCron(t.h, t.m, "*", "*", String(dow)) };
  }

  // daily [at] <time>：daily at 9am / daily at midnight / daily
  m = /^daily(?:\s+at\s+(.+))?$/.exec(s);
  if (m) {
    if (m[1] === undefined) return { kind: "interval", expr: "1d" };
    const t = enTime(m[1]!);
    if (!t) return null;
    return { kind: "cron", expr: toCron(t.h, t.m, "*", "*", "*") };
  }

  // every day [at] <time>：every day at 9am / every day
  m = /^every\s+day(?:\s+at\s+(.+))?$/.exec(s);
  if (m) {
    if (m[1] === undefined) return { kind: "interval", expr: "1d" };
    const t = enTime(m[1]!);
    if (!t) return null;
    return { kind: "cron", expr: toCron(t.h, t.m, "*", "*", "*") };
  }

  return null;
}

/** 中文时间解析：返回 {h, m}；非法 → null */
function cnTime(s: string): { h: number; m: number } | null {
  if (s === "中午") return { h: 12, m: 0 };
  if (s === "午夜" || s === "凌晨") return { h: 0, m: 0 };
  const m = /^([0-9一二两三四五六七八九十]+)[点时](半|([0-9一二两三四五六七八九十]+)分)?$/.exec(s);
  if (!m) return null;
  const h = cnNum(m[1]!);
  if (h === null || h > 23) return null;
  let min = 0;
  if (m[2] === "半") min = 30;
  else if (m[3] !== undefined) {
    const mm = cnNum(m[3]!);
    if (mm === null || mm > 59) return null;
    min = mm;
  }
  return { h, m: min };
}

/** 英文时间解析：9am / 9:30pm / 12 / 21:00 / midnight / noon；非法 → null */
function enTime(s: string): { h: number; m: number } | null {
  const t = s.trim();
  if (t === "midnight") return { h: 0, m: 0 };
  if (t === "noon" || t === "midday") return { h: 12, m: 0 };
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (h > 23 || min > 59) return null;
  if (meridiem === "pm" && h < 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  return { h, m: min };
}

function cnNum(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return CN_NUM[s] ?? null;
}

/** 6 字段 cron（秒位 0）："0 <min> <hour> <dom> <month> <dow>" */
function toCron(h: number, m: number, dom: string, month: string, dow: string): string {
  return `0 ${m} ${h} ${dom} ${month} ${dow}`;
}
