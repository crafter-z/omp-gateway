# omp-gateway

Single resident gateway daemon for [omp](https://github.com/can1357/oh-my-pi)
(Oh My Pi): **cron scheduler + QQ gateway** in one process, driven by
`omp --mode rpc`. Full TypeScript/Bun stack.

Successor of the archived [omp-scheduler](https://github.com/crafter-z/omp-scheduler)
and [omp-qq-bridge](https://github.com/crafter-z/omp-qq-bridge) skeletons.
Part of migrating the user's hermes-agent + opencode workflow onto omp,
replacing hermes's gateway process (cron `cronjob` + official QQ Bot API v2 adapter).

## Status

**Planning** — design docs complete (`docs/`), no implementation yet.

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

## Planned Scope

- **scheduler**: one-shot / recurring / cron-expression / natural-language jobs,
  per-job fresh agent session, no-agent `$0` script mode, execution ledger with
  crash recovery, anti-overlap locking, per-job tools/skills binding, misfire catch-up
- **qq**: official QQ Bot API v2 (C2C private, group @-mentions, guild),
  persistent WebSocket inbound, REST outbound (text/Markdown/images/files),
  voice transcription (QQ ASR + configurable STT), per-chat session mapping,
  user/group allowlists, home channel
- **delivery**: file / QQ / origin targets, SILENT mode, continuable replies

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
