# omp-gateway

Single resident gateway process for [omp](https://github.com/can1357/oh-my-pi)
(Oh My Pi): **cron scheduler + QQ gateway** in one daemon, driven by `omp --mode rpc`.

Successor of the archived [omp-scheduler](https://github.com/crafter-z/omp-scheduler)
and [omp-qq-bridge](https://github.com/crafter-z/omp-qq-bridge) skeletons.
Part of migrating the user's hermes-agent + opencode workflow onto omp,
replacing hermes's gateway process (cron `cronjob` + official QQ Bot API v2 adapter).

## Status

**Skeleton only** — repository initialized, no implementation yet.

## Architecture (planned)

```
[QQ mobile/desktop] ⇄ [official QQ Bot API v2: WS inbound + REST outbound]
                          │
                          ▼
              [omp-gateway daemon (Python, asyncio)]
                ├── qq_gateway module    (C2C/group@guild, per-chat sessions)
                ├── scheduler module     (APScheduler, job store, delivery)
                └── omp_rpc client       (spawns `omp --mode rpc` per turn)
                          │
                          ▼
                     [omp agent]
```

- Single process = no cross-process delivery contract; cron results deliver to QQ directly
- `QQBOT_HOME_CHANNEL` shared as default delivery target
- Runs as a resident service (Windows Task Scheduler / NSSM)

## Planned Scope

- **scheduler**: one-shot / recurring / cron-expression jobs, natural-language parsing,
  per-job fresh agent session, no-agent `$0` script mode, execution ledger with crash recovery,
  anti-overlap locking, per-job tools/skills binding, misfire catch-up
- **qq_gateway**: official QQ Bot API v2 (C2C private, group @-mentions, guild),
  persistent WebSocket inbound, REST outbound (text/Markdown/images/files),
  voice transcription (QQ ASR + configurable STT), per-chat session mapping,
  user/group allowlists, home channel

## Development

Requires Python 3.11+, [Bun](https://bun.sh) (omp), and omp.

```bash
pip install -e .
bun test
```
