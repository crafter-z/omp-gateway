/**
 * QQ voice transcription (P6; contract: docs/02-contracts.md §6.1).
 *
 * transcribeVoice turns a voice attachment URL into text via the configured
 * STT provider: zai GLM-ASR (OpenAI-compatible /audio/transcriptions on the
 * paas/v4 base) or any OpenAI-compatible endpoint ({base_url}/v1/audio/
 * transcriptions). provider "none" disables transcription. All HTTP goes
 * through the global fetch so tests can mock it. Transcription is best-effort
 * — failures resolve to null and never break message handling.
 */
import type { QqSttConfig } from "./types.ts";

const ZAI_DEFAULT_BASE = "https://api.z.ai/api/paas/v4";
const OPENAI_DEFAULT_BASE = "https://api.openai.com";
const DEFAULT_MODEL = "glm-asr";

/** Download a URL (voice blob or image) into memory. Throws on non-2xx. */
export async function downloadAudio(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloadAudio failed (${res.status}): ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, "");
}

/** Last path segment of the URL when it carries a file extension; else a neutral name. */
function fileNameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").pop();
    if (name && /\.[a-z0-9]{1,8}$/i.test(name)) return name;
  } catch {
    // invalid URL — fall through
  }
  return "voice.bin";
}

/**
 * Transcribe a voice attachment URL to text. Returns null when STT is
 * disabled (provider "none") or when transcription fails for any reason —
 * never throws.
 */
export async function transcribeVoice(cfg: QqSttConfig, audioUrl: string): Promise<string | null> {
  if (cfg.provider === "none") return null;
  const defaultBase = cfg.provider === "zai" ? ZAI_DEFAULT_BASE : OPENAI_DEFAULT_BASE;
  const base = stripTrailingSlash(cfg.base_url || defaultBase);
  const endpoint =
    cfg.provider === "zai" ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
  try {
    const audio = await downloadAudio(audioUrl);
    const form = new FormData();
    form.append("model", cfg.model || DEFAULT_MODEL);
    form.append("file", new Blob([audio]), fileNameFromUrl(audioUrl));
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.api_key}` },
      body: form,
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
    if (data && typeof data.text === "string" && data.text.length > 0) return data.text;
    return null;
  } catch {
    return null;
  }
}
