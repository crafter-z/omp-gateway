/**
 * 共享调度表达式工具：interval → cron、once → Date。
 * scheduler（注册）与 preflight（创建前校验）必须使用同一实现，
 * 避免两处规则漂移（历史上 preflight 放行 "90m" 而 croner 注册时才抛错）。
 *
 * interval 语义：转换为 cron 步长表达式，即按自然刻度对齐
 * （"5m" → 每小时的 :00 :05 :10 …，而非自创建时刻起每 5 分钟）。
 * 因此 n 必须落在 croner 字段步长上限内：s/m ≤ 59、h ≤ 23、d ≤ 31。
 */

/** 每个单位的合法范围与 croner 目标字段 */
const INTERVAL_RANGE: Record<"s" | "m" | "h" | "d", number> = {
  s: 59,
  m: 59,
  h: 23,
  d: 31,
};

export type IntervalUnit = keyof typeof INTERVAL_RANGE;

/** interval 表达式（"5m"）→ croner 6 字段 cron 表达式；越界/非法抛错 */
export function intervalToCron(expr: string): string {
  const m = /^(\d+)(s|m|h|d)$/i.exec(expr.trim());
  if (!m) {
    throw new Error(`invalid interval expression "${expr}" (expected e.g. 30s, 5m, 2h, 1d)`);
  }
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase() as IntervalUnit;
  if (n <= 0) throw new Error(`invalid interval "${expr}": must be positive`);
  if (n > INTERVAL_RANGE[unit]) {
    throw new Error(
      `invalid interval "${expr}": ${unit} step must be 1-${INTERVAL_RANGE[unit]} ` +
        `(larger spans need a cron expression)`,
    );
  }
  switch (unit) {
    case "s":
      return `*/${n} * * * * *`;
    case "m":
      return `0 */${n} * * * *`;
    case "h":
      return `0 0 */${n} * * *`;
    case "d":
      return `0 0 0 */${n} * *`;
  }
}

/** once 表达式 → 目标 Date；"+30m" 相对时间或 ISO 时间戳；非法 → null */
export function onceDate(expr: string): Date | null {
  const trimmed = expr.trim();
  if (trimmed.startsWith("+")) {
    const rel = /^(\d+)(s|m|h|d)$/i.exec(trimmed.slice(1).trim());
    if (!rel) return null;
    const n = parseInt(rel[1], 10);
    const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return new Date(Date.now() + n * unitMs[rel[2].toLowerCase()]);
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}
