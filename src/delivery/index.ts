/**
 * Delivery framework (contract 02 §5): routes a RunResult to file | qq |
 * origin | all | multi-target. Applies silence handling, response wrapping,
 * classified failure summaries, silence-narration filtering, credential
 * scanning, oversized-output audit save, media-tag extraction, durable
 * delivery-ledger hooks and boundary-aware segmentation.
 * Zero cross-module imports: callers adapt their Job type to DeliveryJob.
 */

import { summarizeFailure } from "../util/classify.ts";
import { filterSilenceNarration, isAutonomousSilenceResponse } from "../util/silence.ts";
import { extractMediaTags, stripMarkdown } from "../util/media.ts";

export type DeliveryTargetName = "file" | "qq" | "origin";

/** Minimal job shape consumed by delivery (daemon adapts the scheduler Job). */
export interface DeliveryJob {
  name: string;
  delivery: {
    /** "file" | "qq" | "origin" | "all" | comma-separated list (chatKeys + kinds). */
    target: string;
    file?: string;
    qq_chat?: string;
    silent?: boolean;
    wrap_response?: boolean;
    /** Strip markdown before send (QQ non-markdown mode). */
    markdown_support?: boolean;
  };
}

/** Minimal run result shape consumed by delivery. */
export interface DeliveryRun {
  ok: boolean;
  output: string;
  error?: string;
}

export interface DeliveryDeps {
  /** Send a QQ message to a chat key (daemon wires rest.sendText). */
  qqSend: (chatKey: string, text: string, opts?: { msgId?: string; msgSeq?: number }) => Promise<void>;
  /** Send an image/file attachment to a chat key (daemon wires rest.sendMedia). */
  qqSendMedia?: (chatKey: string, filePath: string, kind: "image" | "file") => Promise<void>;
  /** Write output to a file (daemon wires fs). */
  fileSink: (path: string, text: string) => Promise<void>;
  /** Optional audit sink for oversized outputs (daemon wires output dir). */
  auditSink?: (path: string, text: string) => Promise<void>;
  /** Default target when job does not specify (config delivery.default_target). */
  defaultTarget: DeliveryTargetName;
  /** cron results default destination (config delivery.home_channel). */
  homeChannel: string;
  /** Global response wrapping toggle (config delivery.wrap_response). */
  wrapResponse: boolean;
  /** Prefix that marks a message silent (config delivery.silent_trigger). */
  silentTrigger: string;
  /** Drop hallucinated silence-narration tokens before send (default true). */
  filterSilenceNarration?: boolean;
  /** Optional durable delivery-obligation ledger (crash-recovery redelivery). */
  ledger?: {
    record(chatKey: string, text: string): string | null;
    markAttempting(id: string): void;
    markDelivered(id: string): void;
    markFailed(id: string, error: string): void;
  };
  /** Credential-leak scan mounted at the delivery exit (contract 02 §6.4). */
  scan?: (text: string) => { matched: string[]; redacted: string };
  /** Invoked with the job name + matched patterns when the scan hits. */
  onScanHit?: (jobName: string, matched: string[]) => void;
  /** Invoked when a MEDIA: attachment send fails (daemon logs a warning). */
  onMediaError?: (jobName: string, path: string, error: string) => void;
}

/** Result of a delivery: target + (per-target) destination + how many messages/segments were emitted. */
export interface DeliverOutcome {
  target: string;
  /** qq/origin destination chat key. */
  chatKey?: string;
  /** file target path. */
  path?: string;
  /** Number of messages actually sent (qq/origin: segmented parts; file: 1; suppressed: 0). */
  segments: number;
}

/** Outputs above this size are audit-saved and referenced from the chat body. */
const MAX_PLATFORM_OUTPUT = 4000;

/**
 * Strip the SILENT trigger prefix AND detect autonomous silence markers
 * (whole/first/last line [SILENT]/SILENT/NO_REPLY). Returns whether the run
 * asked for silence. The returned text keeps the marker stripped only for
 * the prefix form (other forms are removed entirely).
 */
export function parseSilent(output: string, trigger: string): { text: string; silent: boolean } {
  let text = output;
  if (trigger && text.trimStart().startsWith(trigger)) {
    text = text.trimStart().slice(trigger.length).trimStart();
  }
  const silent = isAutonomousSilenceResponse(output) || (trigger !== "" && output.trimStart().startsWith(trigger));
  return { text, silent };
}

/** Wrap a run result for delivery: status + timestamp + classified failure summary. */
export function wrapResult(run: DeliveryRun, jobName: string, enabled: boolean): string {
  const ts = new Date().toISOString();
  if (!run.ok) {
    // Classified one-line failure summary — never ship raw stack traces.
    const { message } = summarizeFailure(run.error ?? run.output, jobName);
    return `[${jobName}] ${ts} FAILED\n${message}`;
  }
  return `[${jobName}] ${ts} ok\n${run.output}`;
}

/** Characters that are safe cut points when segmenting (whitespace + common CJK/Latin punctuation). */
const SEGMENT_BOUNDARY = /[\s。，、；：？！,.!?;:]/;

/**
 * Split text into chunks of at most {@link maxLen} characters (default 2000,
 * the practical QQ single-message content ceiling). Each chunk prefers to end
 * on the last boundary character inside the window (never splits a word);
 * when the window holds no boundary it hard-cuts at maxLen. The loop always
 * advances, so it cannot spin forever even for degenerate input. Empty text
 * yields a single empty chunk (a blank message).
 */
export function segment(text: string, maxLen = 2000): string[] {
  const size = Math.floor(maxLen);
  const n = size > 0 ? size : 1;
  if (text.length <= n) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + n, text.length);
    let cut = end;
    if (end < text.length) {
      // Walk back from the end: prefer the last boundary inside the window.
      for (let j = end - 1; j > start; j--) {
        if (SEGMENT_BOUNDARY.test(text[j])) {
          cut = j + 1;
          break;
        }
      }
    }
    parts.push(text.slice(start, cut));
    start = cut;
  }
  return parts;
}

/** Resolved concrete targets for a delivery. */
type ResolvedTarget = { kind: "file" } | { kind: "qq"; chatKey: string; label: string };

/**
 * Parse a target spec into concrete targets:
 * - "file" → file destination
 * - "qq" → explicit qq_chat ?? home channel
 * - "origin" → origin chat (degrades to defaultTarget when absent)
 * - "all" → home channel + origin (deduped)
 * - comma-separated mix, where chatKeys ("c2c:…"/"group:…"/"guild:…") send directly
 */
function resolveTargets(
  spec: string,
  ctx: { defaultTarget: DeliveryTargetName; homeChannel: string; explicitChat?: string; originChatKey?: string },
): ResolvedTarget[] {
  const out: ResolvedTarget[] = [];
  const seen = new Set<string>();
  const push = (t: ResolvedTarget) => {
    const key = t.kind === "file" ? "file" : t.chatKey;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  const parts = spec.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) parts.push(ctx.defaultTarget);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "file") {
      push({ kind: "file" });
    } else if (lower === "qq") {
      const chatKey = ctx.explicitChat || ctx.homeChannel;
      if (!chatKey) throw new Error(`delivery: no qq target (qq_chat or home_channel unset)`);
      push({ kind: "qq", chatKey, label: "qq" });
    } else if (lower === "origin") {
      const originKey = ctx.originChatKey;
      if (originKey) {
        push({ kind: "qq", chatKey: originKey, label: "origin" });
      } else {
        // Degrade to defaultTarget (existing semantics).
        const fallback = ctx.defaultTarget;
        if (fallback === "file") push({ kind: "file" });
        else {
          const chatKey = ctx.explicitChat || ctx.homeChannel;
          if (!chatKey) throw new Error(`delivery: origin target without originChatKey and no home_channel`);
          push({ kind: "qq", chatKey, label: "origin" });
        }
      }
    } else if (lower === "all") {
      if (ctx.homeChannel) push({ kind: "qq", chatKey: ctx.homeChannel, label: "all" });
      if (ctx.originChatKey) push({ kind: "qq", chatKey: ctx.originChatKey, label: "all" });
      if (seen.size === 0) throw new Error(`delivery: "all" target needs home_channel or origin chat`);
    } else if (/^(c2c|group|guild):/.test(lower)) {
      push({ kind: "qq", chatKey: part, label: part });
    } else {
      throw new Error(`delivery: unknown target "${part}" (expected file|qq|origin|all|chatKey[, …])`);
    }
  }
  return out;
}

export class Delivery {
  constructor(private readonly deps: DeliveryDeps) {}

  /**
   * Deliver a run result to every resolved target. SILENT (job flag or
   * response marker) suppresses qq/origin targets; file target still writes.
   * Returns one outcome per target (suppressed targets report 0 segments).
   */
  async deliver(
    run: DeliveryRun,
    job: DeliveryJob,
    opts: { originChatKey?: string; replyTo?: string } = {},
  ): Promise<DeliverOutcome[]> {
    const raw = this.deps.filterSilenceNarration === false ? run.output : filterSilenceNarration(run.output);
    const { text, silent } = parseSilent(raw, this.deps.silentTrigger);
    const jobSilent = job.delivery.silent ?? false;
    const wrap = job.delivery.wrap_response ?? this.deps.wrapResponse;

    // Build the wrapped payload once; strip markdown when the platform mode is text-only.
    let payload = text;
    if (wrap && !(silent || jobSilent)) payload = wrapResult({ ...run, output: text }, job.name, run.ok);
    if (job.delivery.markdown_support === false) payload = stripMarkdown(payload);

    // Oversized output: audit-save the full body and reference it.
    if (payload.length > MAX_PLATFORM_OUTPUT && this.deps.auditSink) {
      const auditPath = `.omp-gateway-audit-${sanitizeName(job.name)}-${Date.now()}.txt`;
      try {
        await this.deps.auditSink(auditPath, payload);
        payload = `${payload.slice(0, MAX_PLATFORM_OUTPUT)}\n… [truncated, full output saved to ${auditPath}]`;
      } catch {
        // audit failure must not block delivery
      }
    }

    // MEDIA:<path> tags → attachment sends (best-effort, errors logged).
    const { text: textNoMedia, media } = extractMediaTags(payload);
    payload = textNoMedia;

    const targets = resolveTargets(job.delivery.target, {
      defaultTarget: this.deps.defaultTarget,
      homeChannel: this.deps.homeChannel,
      explicitChat: job.delivery.qq_chat,
      originChatKey: opts.originChatKey,
    });

    const outcomes: DeliverOutcome[] = [];
    for (const target of targets) {
      if (target.kind === "file") {
        const path = job.delivery.file ?? `.omp-gateway-output-${sanitizeName(job.name)}.txt`;
        await this.deps.fileSink(path, this.scanPayload(job.name, payload));
        outcomes.push({ target: "file", path, segments: 1 });
        continue;
      }
      if (silent || jobSilent) {
        outcomes.push({ target: target.label, chatKey: target.chatKey, segments: 0 });
        continue;
      }
      const segments = await this.sendToChat(job, target.chatKey, payload, media, opts.replyTo);
      outcomes.push({ target: target.label, chatKey: target.chatKey, segments });
    }
    return outcomes;
  }

  /** Send a single chat target: segments + optional media attachments.
   *  Returns the number of text segments sent (scan applied exactly once). */
  private async sendToChat(
    job: DeliveryJob,
    chatKey: string,
    payload: string,
    media: string[],
    replyTo: string | undefined,
  ): Promise<number> {
    const safe = this.scanPayload(job.name, payload);
    const parts = segment(safe);
    for (const [i, part] of parts.entries()) {
      const opts = sendOpts(replyTo, i);
      await this.sendWithLedger(chatKey, part, opts);
    }
    for (const path of media) {
      if (!this.deps.qqSendMedia) continue;
      try {
        await this.deps.qqSendMedia(chatKey, path, looksLikeImage(path) ? "image" : "file");
      } catch (err) {
        this.deps.onMediaError?.(job.name, path, err instanceof Error ? err.message : String(err));
      }
    }
    return parts.length;
  }

  /** Wrap a send in the durable delivery ledger (crash-recovery redelivery). */
  private async sendWithLedger(
    chatKey: string,
    text: string,
    opts: { msgId?: string; msgSeq?: number } | undefined,
  ): Promise<void> {
    const ledger = this.deps.ledger;
    if (!ledger) return this.deps.qqSend(chatKey, text, opts);
    const id = ledger.record(chatKey, text);
    if (!id) return this.deps.qqSend(chatKey, text, opts);
    ledger.markAttempting(id);
    try {
      await this.deps.qqSend(chatKey, text, opts);
      ledger.markDelivered(id);
    } catch (err) {
      ledger.markFailed(id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Apply the credential-leak scan to the payload; alert on hits (contract 02 §6.4). */
  private scanPayload(jobName: string, payload: string): string {
    if (!this.deps.scan) return payload;
    const { matched, redacted } = this.deps.scan(payload);
    if (matched.length > 0) this.deps.onScanHit?.(jobName, matched);
    return redacted;
  }
}

/** Passive-reply options for segment i (0-based). */
function sendOpts(
  replyTo: string | undefined,
  segmentIndex: number,
): { msgId?: string; msgSeq?: number } | undefined {
  if (!replyTo) return undefined;
  if (segmentIndex === 0) return { msgId: replyTo };
  return { msgId: replyTo, msgSeq: segmentIndex + 1 };
}

/** Sanitize a job name for use as a filename component. */
function sanitizeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 60);
}

/** Heuristic: image extensions → media type image, else file. */
function looksLikeImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(path);
}

export interface StreamingReplyOptions {
  /** Send one chunk (daemon wires rest.sendText with passive-reply fields). */
  send: (text: string, opts?: { msgId?: string; msgSeq?: number }) => Promise<void>;
  /** Inbound message id — the passive-reply window this stream rides on. */
  replyTo: string;
  /** Target chars per chunk; chunks cut at boundary characters. */
  chunkChars: number;
  /** Optional credential scan applied to each chunk before send. */
  scan?: (text: string) => { matched: string[]; redacted: string };
}

/**
 * QQ 回复流式投递（contract 02 §5.3）。官方 API 无消息编辑能力，"流式"=
 * text_delta 缓冲切块按 msg_seq 递增顺序发送；首块携带 msg_id，后续块
 * msg_seq = i+1（同一被动回复窗口）。[SILENT] 前缀命中后丢弃全部后续内容。
 */
export class StreamingReply {
  private buffer = "";
  private seq = 1;
  private closed = false;
  private silenced = false;
  /** Number of chunks actually sent. */
  sentChunks = 0;

  constructor(private readonly opts: StreamingReplyOptions) {}

  /** Buffer a text delta; flush complete chunks when the buffer is full enough. */
  async push(delta: string): Promise<void> {
    if (this.closed) return;
    if (this.silenced) return;
    if (delta.startsWith("[SILENT]")) {
      this.silenced = true;
      this.buffer = "";
      return;
    }
    this.buffer += delta;
    if (this.buffer.length >= this.opts.chunkChars) {
      await this.flushChunks();
    }
  }

  /** Flush the remainder and close the stream. Idempotent. */
  async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.silenced || this.buffer.length === 0) return;
    await this.flushChunks();
  }

  private async flushChunks(): Promise<void> {
    const maxLen = Math.max(1, this.opts.chunkChars);
    while (this.buffer.length > 0) {
      if (this.buffer.length <= maxLen) {
        await this.sendOne(this.buffer);
        this.buffer = "";
        break;
      }
      let cut = maxLen;
      // Prefer the last boundary inside the window.
      for (let j = maxLen - 1; j > 0; j--) {
        if (SEGMENT_BOUNDARY.test(this.buffer[j]!)) {
          cut = j + 1;
          break;
        }
      }
      await this.sendOne(this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut);
    }
  }

  private async sendOne(text: string): Promise<void> {
    const scan = this.opts.scan;
    const payload = scan ? scan(text).redacted : text;
    const opts = this.seq === 1 ? { msgId: this.opts.replyTo } : { msgId: this.opts.replyTo, msgSeq: this.seq };
    await this.opts.send(payload, opts);
    this.seq++;
    this.sentChunks++;
  }
}
