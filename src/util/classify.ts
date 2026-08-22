/**
 * Compact classified failure summaries for cron delivery (hermes parity:
 * _summarize_cron_failure_for_delivery). Never ships raw stack traces or
 * provider JSON to the chat; one actionable line, capped at 180 chars.
 */

export interface FailureSummary {
  /** The classified one-liner (with marker prefix). */
  message: string;
  kind: "rate_limit" | "timeout" | "auth" | "quota" | "not_found" | "generic";
}

const MAX_LEN = 180;

function classify(raw: string): FailureSummary["kind"] {
  const s = raw.toLowerCase();
  if (s.includes("rate") && s.includes("limit")) return "rate_limit";
  if (s.includes("429") || s.includes("too many requests")) return "rate_limit";
  if (s.includes("timeout") || s.includes("timed out") || s.includes("deadline")) return "timeout";
  if (s.includes("401") || s.includes("403") || s.includes("unauthorized") || s.includes("forbidden") || s.includes("invalid appid")) {
    return "auth";
  }
  if (s.includes("quota") || s.includes("insufficient") || s.includes("billing")) return "quota";
  if (s.includes("404") || s.includes("not found")) return "not_found";
  return "generic";
}

const LABEL: Record<FailureSummary["kind"], string> = {
  rate_limit: "rate-limited by provider",
  timeout: "timed out",
  auth: "authentication/authorization failed",
  quota: "provider quota/usage limit hit",
  not_found: "target not found",
  generic: "failed",
};

/** Build a one-line failure summary; truncates long details. */
export function summarizeFailure(error: string | undefined, jobName: string): FailureSummary {
  const detail = (error ?? "").trim() || "unknown error";
  const kind = classify(detail);
  let message = `⚠️ [${jobName}] ${LABEL[kind]}`;
  if (kind === "generic") {
    // Keep a short slice of the detail for generic failures so the operator
    // has something to act on, but never the full trace.
    const snippet = detail.replace(/\s+/g, " ").slice(0, 120);
    message += `: ${snippet}`;
  }
  if (message.length > MAX_LEN) message = `${message.slice(0, MAX_LEN - 3)}...`;
  return { message, kind };
}
