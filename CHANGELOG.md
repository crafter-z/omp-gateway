# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added (M1–M2, 2026-08-20)
- `omp-gateway` daemon core: config (zod + env/secret resolution), omp RPC
  driver (`--mode rpc`, v2 protocol negotiation with v1 fallback), cron
  scheduler (croner: interval/once/cron), execution ledger with crash
  recovery (pending→claimed→running→completed/failed/unknown), anti-overlap
  claim, no-agent script executor with `wake_agent` preflight gate, QQ
  official Bot API v2 client (WS inbound + REST outbound, heartbeat,
  exponential-backoff reconnect, message dedup, per-chat session mapping),
  delivery framework (file/qq/origin, SILENT, response wrapping, home
  channel), CLI (`start|stop|status|jobs|run-prompt`).

### Added (M3–M4, in progress)
- Natural-language schedule parsing (zh/en), preflight job validation,
  misfire catch-up, credential-leak scan on delivery, model fail-closed,
  nudge on repeated failures.
- Delivery segmentation, QQ media (image/voice/file) + STT fallback.
- Admin HTTP API + WS event push; omp extension shell (`/gateway`, `qq_send`,
  `job_add` tools, QQ→session injection, agent-job anti-loop).
- Single-file build (`bun build --compile`), Windows service management
  (`service install|uninstall|status`), CI (ubuntu+windows).
