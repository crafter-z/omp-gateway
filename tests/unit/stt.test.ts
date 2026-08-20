/**
 * Unit tests for the QQ STT module (stt.ts) using a global fetch mock.
 * Verifies provider routing (none/zai/openai), multipart request shape,
 * and the fail-to-null contract.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { downloadAudio, transcribeVoice } from "../../src/qq/stt.ts";
import type { QqSttConfig } from "../../src/qq/types.ts";

const realFetch = globalThis.fetch;

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mock: audio URLs return bytes; anything else is the STT endpoint. */
function sttMock(): typeof fetch {
  return mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init });
    if (url.startsWith("https://audio.example/")) {
      return new Response(new Uint8Array([0x01, 0x02, 0x03]), { status: 200 });
    }
    return jsonResponse({ text: "转写结果" });
  }) as unknown as typeof fetch;
}

const ZAI_CFG: QqSttConfig = {
  provider: "zai",
  base_url: "https://api.z.ai/api/paas/v4",
  api_key: "key-1",
  model: "glm-asr",
};

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = sttMock();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("transcribeVoice", () => {
  test("provider none returns null without any fetch", async () => {
    const cfg: QqSttConfig = { provider: "none", base_url: "", api_key: "", model: "" };
    const out = await transcribeVoice(cfg, "https://audio.example/voice.mp3");
    expect(out).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  test("zai posts multipart to {base}/audio/transcriptions and returns text", async () => {
    const out = await transcribeVoice(ZAI_CFG, "https://audio.example/voice.mp3");

    expect(out).toBe("转写结果");
    expect(fetchCalls[0]!.url).toBe("https://audio.example/voice.mp3");
    const stt = fetchCalls[1]!;
    expect(stt.url).toBe("https://api.z.ai/api/paas/v4/audio/transcriptions");
    expect(stt.init?.method).toBe("POST");
    expect(stt.init?.headers).toMatchObject({ Authorization: "Bearer key-1" });
    const form = stt.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("glm-asr");
    const filePart = form.get("file") as File;
    expect(filePart.name).toBe("voice.mp3");
    expect(new Uint8Array(await filePart.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("zai defaults the base_url and model when unset", async () => {
    const cfg: QqSttConfig = { provider: "zai", base_url: "", api_key: "k", model: "" };
    const out = await transcribeVoice(cfg, "https://audio.example/voice.mp3");
    expect(out).toBe("转写结果");
    expect(fetchCalls[1]!.url).toBe("https://api.z.ai/api/paas/v4/audio/transcriptions");
    expect((fetchCalls[1]!.init?.body as FormData).get("model")).toBe("glm-asr");
  });

  test("openai posts to {base}/v1/audio/transcriptions", async () => {
    const cfg: QqSttConfig = {
      provider: "openai",
      base_url: "https://stt.example",
      api_key: "key-2",
      model: "whisper-1",
    };
    const out = await transcribeVoice(cfg, "https://audio.example/voice.wav");
    expect(out).toBe("转写结果");
    expect(fetchCalls[1]!.url).toBe("https://stt.example/v1/audio/transcriptions");
    const form = fetchCalls[1]!.init?.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect((form.get("file") as File).name).toBe("voice.wav");
  });

  test("strips trailing slashes from base_url", async () => {
    const cfg: QqSttConfig = { provider: "zai", base_url: "https://api.z.ai/api/paas/v4/", api_key: "k", model: "glm-asr" };
    await transcribeVoice(cfg, "https://audio.example/voice.mp3");
    expect(fetchCalls[1]!.url).toBe("https://api.z.ai/api/paas/v4/audio/transcriptions");
  });

  test("non-2xx stt response returns null", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://audio.example/")) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return jsonResponse({ error: "rate limited" }, 429);
    }) as unknown as typeof fetch;

    const out = await transcribeVoice(ZAI_CFG, "https://audio.example/voice.mp3");
    expect(out).toBeNull();
  });

  test("malformed stt body returns null", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://audio.example/")) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return new Response("not json at all", { status: 200 });
    }) as unknown as typeof fetch;

    const out = await transcribeVoice(ZAI_CFG, "https://audio.example/voice.mp3");
    expect(out).toBeNull();
  });

  test("audio download failure returns null (never throws)", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push({ url });
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;

    const out = await transcribeVoice(ZAI_CFG, "https://audio.example/missing.mp3");
    expect(out).toBeNull();
    expect(fetchCalls).toHaveLength(1); // no STT call after failed download
  });
});

describe("downloadAudio", () => {
  test("returns the response bytes", async () => {
    const bytes = await downloadAudio("https://audio.example/voice.mp3");
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("throws on non-2xx", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(downloadAudio("https://audio.example/missing.mp3")).rejects.toThrow(/404/);
  });
});
