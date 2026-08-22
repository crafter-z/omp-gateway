# omp-gateway

Single resident gateway daemon for [omp](https://github.com/can1357/oh-my-pi)
(Oh My Pi): **cron scheduler + QQ gateway** in one process, driven by
`omp --mode rpc`. Full TypeScript/Bun stack.

Successor of the archived [omp-scheduler](https://github.com/crafter-z/omp-scheduler)
and [omp-qq-bridge](https://github.com/crafter-z/omp-qq-bridge) skeletons.
Part of migrating the user's hermes-agent + opencode workflow onto omp,
replacing hermes's gateway process (cron `cronjob` + official QQ Bot API v2 adapter).

## Status

**Implemented (M1–M4, 2026-08-20)** — daemon core, scheduler, QQ gateway,
delivery, admin API, extension shell, packaging. 249 tests green; `tsc` clean.

- M1 (P0–P2): daemon skeleton + config + omp RPC driver (`run-prompt` verified
  against real omp)
- M2 (P3–P4): cron (interval/once/cron) + QQ text round-trip
- M3 (P5–P6): NL schedule parsing (zh/en), preflight validation, misfire
  catch-up, credential-leak scan, nudge, model fail-closed; delivery
  segmentation, QQ media + STT
- M4 (P7–P8): admin HTTP API + WS event push, omp extension shell, single-file
  build (`bun build --compile`), Windows service commands, CI

## Usage

```bash
# 1. configure ~/.omp-gateway/config.yml (qq.app_id/app_secret required)
# 2. run the daemon
omp-gateway start --daemon          # detached background process
omp-gateway status                  # process + config summary
omp-gateway jobs add --name daily --schedule "每天 9 点" --prompt "..." --target qq
omp-gateway jobs list               # view ledger state

# dev: run one prompt through the real omp RPC path
omp-gateway run-prompt "1+1"
```

### omp extension shell (Phase 2)

```bash
omp plugin install omp-gateway      # npm 包发布后
# env: OMP_GATEWAY_ADMIN_URL (default http://127.0.0.1:18765),
#      OMP_GATEWAY_ADMIN_TOKEN (match config admin.token)
```

Provides `/gateway status|jobs` commands, `qq_send` / `job_add` tools
(agent-created scheduling jobs are restricted to no-agent actions — anti-loop),
and injects QQ inbound messages into the live session via `sendUserMessage`.

### Windows service (P8)

```bash
bun run build                       # dist/omp-gateway.exe
omp-gateway service install --config <path>
sc start omp-gateway
omp-gateway service status
```

## Development

Requires Bun 1.3.14+ (omp) and Node/Bun toolchain.

```bash
bun install
bun test
```

## Docs

- `docs/01-architecture.md` — process model, module boundaries, data flow
- `docs/02-contracts.md` — config schema, job model, execution ledger, IPC protocol
- `docs/03-capability-gap.md` — hermes capability baseline vs. this project
- `docs/04-roadmap.md` — phased implementation plan
- `docs/05-implementation-plan.md` — concrete implementation plan: stack, file tree, type skeleton, per-phase steps

## Architecture

```
[QQ mobile/desktop] ⇄ [official QQ Bot API v2: WS inbound + REST outbound]
                          │
                          ▼
              [omp-gateway daemon (TypeScript/Bun, resident)]
                ├── qq module         (C2C/group@guild, per-chat sessions)
                ├── scheduler module  (croner, job store, execution ledger)
                ├── delivery module   (file / QQ / origin targets)
                └── omp-rpc client    (spawns `omp --mode rpc` per turn)
                          │
                          ▼
                     [omp agent]
```

- **Phase 1**: standalone daemon + CLI (`omp-gateway start|stop|status`) — no
  plugin dependency; cron and QQ run fully headless
- **Phase 2**: optional omp extension shell (`omp plugin install`) bridging the
  daemon into live TUI sessions (message injection, `/gateway` commands, `qq_send` tool)

See `docs/01-architecture.md` for details.
