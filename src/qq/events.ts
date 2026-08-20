/**
 * QQ gateway dispatch-frame parsing: raw gateway payload → InboundMessage.
 *
 * Only C2C_MESSAGE_CREATE and GROUP_AT_MESSAGE_CREATE are inbound message
 * events; every other frame shape / event type yields null so the gateway
 * can ignore handshake and unrelated frames.
 */
import type { InboundAttachment, InboundMessage } from "./types.ts";

export const C2C_MESSAGE_CREATE = "C2C_MESSAGE_CREATE";
export const GROUP_AT_MESSAGE_CREATE = "GROUP_AT_MESSAGE_CREATE";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Normalize QQ attachment entries: `type` is inferred from the content_type
 * prefix (image/* → image, audio/* → voice, everything else → file); voice
 * ASR transcription (asr_refer_text) is carried as asrText. Entries without
 * a usable url are dropped.
 */
function normalizeAttachments(value: unknown): InboundAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: InboundAttachment[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const url = asString(item.url);
    if (!url) continue;
    const contentType = asString(item.content_type) ?? "";
    const type: InboundAttachment["type"] = contentType.startsWith("image/")
      ? "image"
      : contentType.startsWith("audio/")
        ? "voice"
        : "file";
    const att: InboundAttachment = { type, url };
    const asr = asString(item.asr_refer_text);
    if (asr) att.asrText = asr;
    out.push(att);
  }
  return out;
}

/**
 * Parse a gateway dispatch frame into an InboundMessage, or null when the
 * frame is not a target event (or is malformed).
 *
 * - C2C_MESSAGE_CREATE → chatKey "c2c:<author.user_openid>"
 * - GROUP_AT_MESSAGE_CREATE → chatKey "group:<group_openid>", authorOpenid
 *   from author.member_openid
 * - content has QQ rich-text tags (<@!id> etc.) stripped
 */
export function parseEvent(raw: unknown): InboundMessage | null {
  if (!isRecord(raw)) return null;
  const t = raw.t;
  if (t !== C2C_MESSAGE_CREATE && t !== GROUP_AT_MESSAGE_CREATE) return null;
  const d = isRecord(raw.d) ? raw.d : null;
  if (!d) return null;
  // Markdown (msg_type 2) messages carry no plain content — skip them.
  if (d.msg_type === 2) return null;
  const id = asString(d.id);
  if (!id) return null;
  const author = isRecord(d.author) ? d.author : null;
  const content = asString(d.content) ?? "";
  const text = content.replace(/<@[^>]+>/g, "").trim();

  let chatKey: string;
  let authorOpenid: string;
  if (t === C2C_MESSAGE_CREATE) {
    const openid = author ? asString(author.user_openid) : null;
    if (!openid) return null;
    chatKey = `c2c:${openid}`;
    authorOpenid = openid;
  } else {
    const groupOpenid = asString(d.group_openid);
    const memberOpenid = author ? asString(author.member_openid) : null;
    if (!groupOpenid || !memberOpenid) return null;
    chatKey = `group:${groupOpenid}`;
    authorOpenid = memberOpenid;
  }

  return {
    id,
    chatKey,
    authorOpenid,
    text,
    attachments: normalizeAttachments(d.attachments),
    raw,
  };
}
