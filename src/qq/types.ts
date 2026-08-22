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
  /** WebSocket gateway URL override; empty derives from portal host (tests/sandbox). */
  ws_url?: string;
  /** Subscribed event names; defaults to C2C + group-at intents. */
  intents?: string[];
}

/** Normalized attachment carried by an inbound QQ message. */
export interface InboundAttachment {
  type: "image" | "voice" | "file";
  url: string;
  /** Original filename from attachment metadata (may be empty). */
  filename?: string;
  /** QQ-provided pre-converted WAV URL for voice attachments (preferred STT source). */
  voiceWavUrl?: string;
  /** ASR transcription; present for voice attachments with asr_refer_text. */
  asrText?: string;
}

/** Quoted-message context (message_type 103 → msg_elements[0]). */
export interface QuotedContext {
  /** Concatenated quoted text, or "(image)" marker for image-only quotes. */
  text: string;
  /** Quoted image attachment URLs (downloaded by the caller like main images). */
  images: string[];
}

/** Normalized inbound QQ message (C2C direct message, group @, or guild channel). */
export interface InboundMessage {
  /** Message id — the dedup key. */
  id: string;
  /** "c2c:<user_openid>" | "group:<group_openid>" | "guild:<channel_id>". */
  chatKey: string;
  /** c2c: author.user_openid; group: author.member_openid; guild: author.id. */
  authorOpenid: string;
  /** content with QQ rich-text tags (e.g. <@!bot_openid>) stripped. */
  text: string;
  attachments: InboundAttachment[];
  /** Quoted-message context when the user replied to another message. */
  quoted?: QuotedContext;
  /** The raw gateway dispatch frame. */
  raw: unknown;
}

/**
 * Outbound chat target. `openid` holds the c2c user_openid or the
 * group_openid depending on the chatKey prefix; the REST path is chosen
 * from the prefix ("group:" → /v2/groups/…, otherwise /v2/users/…).
 */
export type ChatRef = { chatKey: string; openid: string };
/**
 * Optional QqGateway knobs. `wsUrl` lets tests inject a local gateway mock;
 * `tokenProvider` supplies the current access token for IDENTIFY/RESUME
 * (production wires rest.ts's getAccessToken; tests use a static value).
 */
export interface QqGatewayOptions {
  wsUrl?: string;
  /** Returns a valid access token ("QQBot <token>" is prefixed by the gateway). */
  tokenProvider?: () => Promise<string>;
  /** Internal protocol-level log hook (daemon wires the logger). */
  onLog?: (message: string) => void;
}

/**
 * STT provider config for voice attachment transcription (config qq.stt).
 * Mirrors qqSttConfigSchema so the qq module stays dependency-free; the
 * daemon adapts the zod-inferred shape into this one (structurally equal).
 */
export interface QqSttConfig {
  /** "zai" (GLM-ASR) | "openai" (OpenAI-compatible endpoint) | "none" (disabled). */
  provider: "zai" | "openai" | "none";
  /** API base URL; empty selects the provider default. */
  base_url: string;
  /** API key sent as `Authorization: Bearer <key>`. */
  api_key: string;
  /** STT model id (zai default: glm-asr). */
  model: string;
}
