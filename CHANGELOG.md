# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed
- QQ replies now ride the passive-reply window: inbound message id is echoed
  as `msg_id`, and segmented replies carry incrementing `msg_seq` (previously
  every reply was an active message subject to active-send quotas).
- `qq.allow` (users / groups / allow_all_users) is now enforced in the daemon
  inbound path — previously configured but never checked; empty lists deny by
  default.
- Extension `job_add` reuses the CLI's NL schedule parser (`parseSchedule`) —
  inputs like "every 5 minutes" or "每天 9 点" no longer produce invalid job
  schedules that died silently at registration; parse failures are reported
  to the agent.
- Admin job PATCH can no longer flip an agent-created (`meta.source=agent`)
  job to an `agent` action, closing the anti-loop bypass; jobs.meta is
  persisted (schema v2 migration) and admin add/update now run preflight.
- Ledger terminal writes (`markRunning`/`markCompleted`/`markFailed`) carry a
  status guard: a run that outlives the misfire window and gets marked
  `unknown` by scanStale can no longer be overwritten to completed/failed,
  and job status resets don't clobber a newer claim.
- Once jobs missed while the daemon was down now fire on startup when inside
  the misfire grace window, or are explicitly retired (next_run=null + log)
  instead of hanging forever.
- Interval schedules are range-validated against croner step limits
  (s/m ≤ 59, h ≤ 23, d ≤ 31) in one shared implementation (`scheduler/expr.ts`)
  used by scheduler registration, preflight, and the NL parser — "90m" is now
  rejected at creation instead of crashing registration.
- no-agent script execution dispatches by extension (.sh → bash, .py → python,
  .bat/.cmd → cmd, .ps1 → powershell) instead of always spawning bun.
- `/api/status` reports the real gateway state (`connected`/`connecting`) via
  `QqGateway.connected` instead of a constant "connecting".
- QQ gateway attempts one op 6 RESUME (session id + last seq) after an
  abnormal disconnect before falling back to IDENTIFY.

### Changed
- QQ REST client: access-token cache keyed per (app_id, portal_host);
  transient failures (429 with Retry-After, 500/502/503/504) retried up to 3
  times with linear backoff via `postJsonWithRetry`.
- Scheduler accepts an injected logger (`SchedulerOptions.log`); daemon wires
  util/logger instead of raw console.error.

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
