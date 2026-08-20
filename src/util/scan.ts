/**
 * 凭据外泄扫描（docs/02-contracts.md §6.4）：识别文本中的密钥形态并脱敏。
 * 命中片段替换为 `[REDACTED:<name>]`；阈值 ≥10 字符，避免误报普通文本。
 * 纯本地正则匹配，不碰网络、不烧 token，可挂在 delivery 出口与 prompt 注入前。
 */

export interface ScanResult {
  /** 命中的原始密钥片段（按出现顺序、去重） */
  matched: string[];
  /** 命中片段已替换为 [REDACTED:<name>] 的文本 */
  redacted: string;
}

interface SecretPattern {
  name: string;
  re: RegExp;
}

/** 最小命中长度（字符）：短串（单字母、单词片段）不算密钥 */
const MIN_MATCH_LENGTH = 10;

/** 模式清单：全局匹配；重叠命中在扫描后合并，同一片段只脱敏一次。
 *  具体形态（QQBot/sk-/JWT/AWS/…）在前，裸 app_secret 兜底放最后。 */
const SECRET_PATTERNS: SecretPattern[] = [
  // QQBot 鉴权头：QQBot <AppID>.<AppSecret>
  { name: "qqbot_token", re: /\bQQBot\s+[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
  // 环境变量风格：QQBOT_<TOKEN>
  { name: "qqbot_token", re: /\bQQBOT_[A-Za-z0-9_-]{10,}/g },
  // app_secret 字段赋值（YAML/ENV 形式，值 16-64 位字母数字）
  { name: "app_secret", re: /\bapp_secret\s*[:=]\s*['"]?[A-Za-z0-9]{16,64}/g },
  // OpenAI 风格 sk- 密钥
  { name: "sk_key", re: /\bsk-[A-Za-z0-9_-]{10,}/g },
  // Bearer JWT
  { name: "jwt", re: /\bBearer\s+eyJ[A-Za-z0-9_.-]{10,}/g },
  // AWS access key（AKIA + 16 位）
  { name: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub token
  { name: "github_token", re: /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/g },
  // Slack token
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  // app_secret 裸形态：16-64 位连续字母数字（兜底，最后匹配）
  { name: "app_secret", re: /(?<![A-Za-z0-9])[A-Za-z0-9]{16,64}(?![A-Za-z0-9])/g },
];

interface Span {
  start: number;
  end: number;
  name: string;
}

export function scanSecrets(text: string): ScanResult {
  const matched: string[] = [];
  const spans: Span[] = [];
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      if (m[0].length < MIN_MATCH_LENGTH) continue; // 阈值：短串不算
      spans.push({ start: m.index, end: m.index + m[0].length, name: p.name });
      if (!matched.includes(m[0])) matched.push(m[0]);
      if (m[0].length === 0) p.re.lastIndex += 1; // 防死循环（本模式不会产生空匹配）
    }
  }
  if (spans.length === 0) return { matched: [], redacted: text };

  // 按起点排序，重叠区间合并（同一片段命中多个模式只脱敏一次）
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }

  let out = "";
  let cursor = 0;
  for (const s of merged) {
    out += text.slice(cursor, s.start);
    out += `[REDACTED:${s.name}]`;
    cursor = s.end;
  }
  out += text.slice(cursor);
  return { matched, redacted: out };
}
