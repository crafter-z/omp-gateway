/**
 * QQ gateway dispatch-frame parsing: raw gateway payload → InboundMessage.
 *
 * Handled event types:
 * - C2C_MESSAGE_CREATE → chatKey "c2c:<author.user_openid>"
 * - GROUP_AT_MESSAGE_CREATE → chatKey "group:<group_openid>", author from
 *   author.member_openid
 * - GUILD_MESSAGE_CREATE / GUILD_AT_MESSAGE_CREATE → chatKey "guild:<channel_id>",
 *   author from author.id (subscribe PUBLIC_GUILD_MESSAGES to receive these)
 *
 * Every other frame shape / event type yields null so the gateway can ignore
 * handshake and unrelated frames.
 */
import type { InboundAttachment, InboundMessage, QuotedContext } from "./types.ts";
import { isRecord } from "../util/record.ts";

export const C2C_MESSAGE_CREATE = "C2C_MESSAGE_CREATE";
export const GROUP_AT_MESSAGE_CREATE = "GROUP_AT_MESSAGE_CREATE";
export const GUILD_MESSAGE_CREATE = "GUILD_MESSAGE_CREATE";
export const GUILD_AT_MESSAGE_CREATE = "GUILD_AT_MESSAGE_CREATE";

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** QQ voice messages carry content_type "voice" (NOT "audio/*"); audio files
 *  uploaded as regular files carry content_type "file" and must stay files. */
function isVoiceAttachment(contentType: string, filename: string): boolean {
  const ct = contentType.trim().toLowerCase();
  if (ct === "voice" || ct.startsWith("audio/")) return true;
  if (ct === "file") return false; // file uploads must not be misrouted into STT
  const ext = filename.trim().toLowerCase();
  return /\.(silk|amr|mp3|wav|ogg|m4a|aac|speex|flac)$/.test(ext);
}

/**
 * Normalize QQ attachment entries: `type` is inferred from content_type
 * (image/* → image, voice/audio/* → voice, everything else → file); voice
 * ASR transcription (asr_refer_text) and the pre-converted WAV URL
 * (voice_wav_url) are carried through. Entries without a usable url are
 * dropped.
 */
function normalizeAttachments(value: unknown): InboundAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: InboundAttachment[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const url = asString(item.url);
    if (!url) continue;
    const contentType = asString(item.content_type) ?? "";
    const filename = asString(item.filename) ?? "";
    const type: InboundAttachment["type"] = contentType.startsWith("image/")
      ? "image"
      : isVoiceAttachment(contentType, filename)
        ? "voice"
        : "file";
    const att: InboundAttachment = { type, url };
    if (filename) att.filename = filename;
    const wav = asString(item.voice_wav_url);
    if (wav) att.voiceWavUrl = wav;
    const asr = asString(item.asr_refer_text);
    if (asr) att.asrText = asr;
    out.push(att);
  }
  return out;
}

/**
 * Parse quoted-message context (message_type 103): the referenced message
 * lives in msg_elements[0] with its own content + attachments. Bare
 * quote-replies (no user text) previously produced nothing — now they
 * surface the quoted text and run quoted attachments through the same
 * pipeline as the main body.
 */
function parseQuoted(d: Record<string, unknown>): QuotedContext | undefined {
  try {
    if (Number(d.message_type ?? 0) !== 103) return undefined;
  } catch {
    return undefined;
  }
  const elements = d.msg_elements;
  if (!Array.isArray(elements) || elements.length === 0) return undefined;

  const textParts: string[] = [];
  const attachments: unknown[] = [];
  for (const elem of elements) {
    if (!isRecord(elem)) continue;
    const content = asString(elem.content);
    if (content && content.trim() !== "") textParts.push(content.trim());
    if (Array.isArray(elem.attachments)) attachments.push(...elem.attachments);
  }
  const quoted = normalizeAttachments(attachments);
  const images = quoted
    .filter((a) => a.type === "image")
    .map((a) => a.url);
  if (textParts.length === 0 && images.length === 0) return undefined;
  const text = textParts.length > 0 ? textParts.join(" ") : "(image)";
  return { text, images };
}

/**
 * Parse a gateway dispatch frame into an InboundMessage, or null when the
 * frame is not a target event (or is malformed). content has QQ rich-text
 * tags (<@!id> etc.) stripped.
 */
export function parseEvent(raw: unknown): InboundMessage | null {
  if (!isRecord(raw)) return null;
  const t = raw.t;
  if (t !== C2C_MESSAGE_CREATE && t !== GROUP_AT_MESSAGE_CREATE && t !== GUILD_MESSAGE_CREATE && t !== GUILD_AT_MESSAGE_CREATE) {
    return null;
  }
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
  } else if (t === GROUP_AT_MESSAGE_CREATE) {
    const groupOpenid = asString(d.group_openid);
    const memberOpenid = author ? asString(author.member_openid) : null;
    if (!groupOpenid || !memberOpenid) return null;
    chatKey = `group:${groupOpenid}`;
    authorOpenid = memberOpenid;
  } else {
    // GUILD_MESSAGE_CREATE / GUILD_AT_MESSAGE_CREATE
    const channelId = asString(d.channel_id);
    const authorId = author ? asString(author.id) : null;
    if (!channelId || !authorId) return null;
    chatKey = `guild:${channelId}`;
    authorOpenid = authorId;
  }

  const msg: InboundMessage = {
    id,
    chatKey,
    authorOpenid,
    text,
    attachments: normalizeAttachments(d.attachments),
    raw,
  };
  const quoted = parseQuoted(d);
  if (quoted) msg.quoted = quoted;
  return msg;
}
