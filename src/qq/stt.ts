/**
 * QQ voice transcription (contract: docs/02-contracts.md §6.1).
 *
 * transcribeVoice turns a voice attachment into text:
 * 1. QQ's built-in asr_refer_text wins when present (free, no API call).
 * 2. Otherwise the STT provider transcribes audio. The attachment is
 *    downloaded (with the bot's Authorization header — QQ's multimedia CDN
 *    requires it) and, when needed, converted SILK/AMR → WAV via ffmpeg so
 *    STT engines can process it.
 *
 * Provider: zai GLM-ASR (OpenAI-compatible /audio/transcriptions on the
 * paas/v4 base) or any OpenAI-compatible endpoint ({base_url}/v1/audio/
 * transcriptions). provider "none" disables transcription. Transcription is
 * best-effort — failures resolve to null and never break message handling.
 *
 * All HTTP goes through the global fetch so tests can mock it.
 */
import type { QqSttConfig } from "./types.ts";
import { isSafeUrl } from "../util/urlsafe.ts";

const ZAI_DEFAULT_BASE = "https://api.z.ai/api/paas/v4";
const OPENAI_DEFAULT_BASE = "https://api.openai.com";
const DEFAULT_MODEL = "glm-asr";

/** Download a URL (voice blob or image) into memory. Throws on non-2xx or unsafe URL. */
export async function downloadMedia(
  url: string,
  opts: { authToken?: string } = {},
): Promise<Uint8Array> {
  if (!isSafeUrl(url)) throw new Error(`blocked unsafe media URL: ${url.slice(0, 80)}`);
  const headers: Record<string, string> = {};
  if (opts.authToken) headers.Authorization = `QQBot ${opts.authToken}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`downloadMedia failed (${res.status}): ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Back-compat alias (images, tests). */
export async function downloadAudio(url: string): Promise<Uint8Array> {
  return downloadMedia(url);
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

const AUDIO_EXTS = /\.(silk|amr|speex)$/i;

/**
 * Convert SILK/AMR audio bytes to WAV via ffmpeg (spawn, pipe stdin→stdout).
 * Returns null when ffmpeg is unavailable or conversion fails — the caller
 * falls back to the raw bytes (STT providers with SILK support still work).
 */
export async function convertToWav(bytes: Uint8Array): Promise<Uint8Array | null> {
  let proc: Bun.PipedSubprocess;
  try {
    proc = Bun.spawn(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "wav", "pipe:1"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch {
    return null; // ffmpeg not installed
  }
  try {
    proc.stdin.write(bytes);
    proc.stdin.flush();
    proc.stdin.end();
    const [out, err] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0 || out.byteLength === 0) {
      // Conversion failed; keep the original bytes for providers that can
      // handle SILK/AMR natively.
      return null;
    }
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

/**
 * Transcribe a voice attachment to text. Returns null when STT is disabled
 * (provider "none") or when transcription fails for any reason — never throws.
 *
 * @param authToken QQ access token used for the media download Authorization
 * header (multimedia.nt.qq.com.cn requires it).
 */
export async function transcribeVoice(
  cfg: QqSttConfig,
  audioUrl: string,
  opts: { authToken?: string; voiceWavUrl?: string } = {},
): Promise<string | null> {
  if (cfg.provider === "none") return null;
  const defaultBase = cfg.provider === "zai" ? ZAI_DEFAULT_BASE : OPENAI_DEFAULT_BASE;
  const base = stripTrailingSlash(cfg.base_url || defaultBase);
  const endpoint =
    cfg.provider === "zai" ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;

  try {
    // Prefer QQ's pre-converted WAV URL (avoids SILK decoding entirely).
    const downloadUrl = opts.voiceWavUrl || audioUrl;
    let audio = await downloadMedia(downloadUrl, { authToken: opts.authToken });

    // QQ voice is SILK/AMR; convert to WAV so the STT API can read it.
    if (!opts.voiceWavUrl && AUDIO_EXTS.test(fileNameFromUrl(audioUrl))) {
      const wav = await convertToWav(audio);
      if (wav) audio = wav;
    }

    const form = new FormData();
    form.append("model", cfg.model || DEFAULT_MODEL);
    const name = opts.voiceWavUrl ? "voice.wav" : fileNameFromUrl(downloadUrl);
    form.append("file", new Blob([audio]), name);
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
