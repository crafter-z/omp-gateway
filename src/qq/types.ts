/**
 * Public types of the qq module.
 *
 * The daemon adapts the full validated config (config/schema) into the minimal
 * {@link QqConfig} shape below; the qq module deliberately depends on nothing
 * else in the repo so it can be developed and tested in isolation.
 */

/** Minimal QQ config subset consumed by the qq module. */
export interface QqConfig {
  /** q.qq.com AppID. */
  app_id: string;
  /** q.qq.com AppSecret. */
  app_secret: string;
  /** API portal host; defaults to "q.qq.com" (sandbox: "sandbox.q.qq.com"). */
  portal_host?: string;
  /** Subscribed event names; defaults to C2C + group-at intents. */
  intents?: string[];
}

/** Normalized attachment carried by an inbound QQ message. */
export interface InboundAttachment {
  type: "image" | "voice" | "file";
  url: string;
  /** ASR transcription; present for voice attachments with asr_refer_text. */
  asrText?: string;
}

/** Normalized inbound QQ message (C2C direct message or group @). */
export interface InboundMessage {
  /** Message id — the dedup key. */
  id: string;
  /** "c2c:<user_openid>" or "group:<group_openid>". */
  chatKey: string;
  /** c2c: author.user_openid; group: author.member_openid. */
  authorOpenid: string;
  /** content with QQ rich-text tags (e.g. <@!bot_openid>) stripped. */
  text: string;
  attachments: InboundAttachment[];
  /** The raw gateway dispatch frame. */
  raw: unknown;
}

/**
 * Outbound chat target. `openid` holds the c2c user_openid or the
 * group_openid depending on the chatKey prefix; the REST path is chosen
 * from the prefix ("group:" → /v2/groups/…, otherwise /v2/users/…).
 */
export type ChatRef = { chatKey: string; openid: string };

/** Optional QqGateway knobs; `wsUrl` lets tests inject a local gateway mock. */
export interface QqGatewayOptions {
  wsUrl?: string;
}
