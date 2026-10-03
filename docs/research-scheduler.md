# Recurring research cycles

The existing local supervisor can periodically refresh filing evidence and create new analyst tasks within one run. The existing coordinator creates each skeptic review as a dependency of its thesis and records a decision. No per-order approval or order-execution authority is added by scheduling research.

## Configure and start

Use Node 24 or newer on Linux with util-linux `flock`, project dependencies and the local SpacetimeDB host. In your existing swarm JSON, add `schedule` under `research` and configure explicit `limits`:

```json
{
  "limits": {
    "maxInferences": 100,
    "maxTokens": 1000000,
    "maxConcurrent": 2,
    "maxAttempts": 3
  },
  "research": {
    "symbols": ["AAPL", "MSFT"],
    "evidence": "sec",
    "objective": "Assess current filing evidence, valuation and counterarguments",
    "schedule": {
      "everySeconds": 86400,
      "maxCycles": 7,
      "maxPendingCycles": 1
    }
  }
}
```

This is a fragment to merge into the existing config, not a complete config. Keep analyst, skeptic and coordinator counts positive; symbols must be unique. Evidence must be `sec` or clearly labeled `fixture`. SEC ingestion requires `SEC_USER_AGENT` and a run ID of at most 64 characters. Omit `schedule` to retain the original one-time startup seeding behavior.

From the repository root, using your configured file:

```sh
node scripts/swarm.ts plan --config config/swarm.json
node scripts/swarm.ts register --config config/swarm.json
node scripts/swarm.ts grants --apply --config config/swarm.json
node scripts/swarm.ts up --config config/swarm.json
```

Inspect grant commands before applying them if your account/run policy has not been reviewed. The existing roles, credentials, fixed paper endpoint, risk policy and deterministic execution gates continue to apply. `up` stays running; Ctrl+C stops its workers and any active ingestor. `plan` displays configured cadence, admission windows and overlap. The supervisor polls durable state at most every ten seconds and refreshes evidence sequentially for each missing symbol before queueing its task. Periodic market snapshots remain the existing adapter's responsibility.

The pilot helper's `reviewEveryHours` remains position-review metadata. This scheduler explicitly uses `swarm.research.schedule`; it does not turn that metadata into an automatic exit plan.

## Durable cadence and recovery

Cadence windows are anchored to the database run's `createdAt`, with window zero starting at creation. `maxCycles` bounds those windows, not the count of successful batches. Late startup, pause and downtime skip past empty windows; there is no burst of catch-up work. A newly enabled schedule on an old run may already be exhausted, so configure the cadence before creating the run or explicitly create a new operator-approved run.

Each task ID contains a stable digest of the run ID, its window number and symbol. The task objective contains an immutable fingerprint of the research configuration. Existing task rows detect configuration drift: changing symbols, objective, evidence or schedule after a task is published is rejected on restart. Use a new run for a changed schedule. Repeated timers and restarts reuse task IDs; an uncertain successful `create_task` is discovered from the durable rows and is not replayed as another task.

If part of a multi-symbol batch was already published, restart resumes missing symbols in that batch before admitting another, even after its last cadence window ends. Each missing symbol is refreshed again before publication. Failed ingestion creates no thesis task. If the window changes during ingestion before any task has been recorded, the stale candidate is discarded and the next poll uses the current window. Choose a cadence longer than the expected ingestion time.

`maxPendingCycles` counts batches until every thesis has either failed or has a durable coordinator decision. A completed thesis awaiting its review/decision is still pending. Existing manual/one-time thesis tasks count as one competing batch. A failed review without a decision conservatively retains its slot; inspect and resolve that failure rather than silently bypassing it. Pending overlap never expands the model budget: every cycle uses the same durable run inference/token counters, including outstanding reservations. Exhausted or unavailable budget state blocks admission at the scheduler's snapshot check; concurrent reservations can change the budget afterward, and the existing inference reducer remains the authoritative limit on model calls.

The supervisor rechecks run state and budget after evidence collection. Paused or closed runs queue no tasks; the reducer also checks active status transactionally if a pause arrives after the last snapshot. An in-flight ingestion can finish or fail while paused; it cannot authorize a task or order. Resume uses the current window or reconciles an existing partial batch. An already queued cycle retains its worker ownership, lease and ordinary recovery behavior.

## Local process ownership

Scheduled `up` acquires an exclusive Linux `flock` for the configured server/database/run under `logs/`. A second supervisor for that same configured run fails immediately. The OS releases the lock after a crash; no stale PID file removal is needed. Signals are forwarded to the child process group, and one-shot ingestors are tracked for shutdown alongside workers. CLI reads/writes have a 30-second timeout; ingestion and snapshot subprocess attempts are terminated after five minutes and do not authorize a task when they fail.

This is a single-host supervisor. All publishers for a run must use the same checkout/configured server name and lock directory; running another scheduler on a different host or using database/server aliases bypasses this local lock and is unsupported. Distributed cycle admission needs a separate authoritative reducer; do not deploy multiple scheduler hosts under this implementation. The run/task/decision/budget records remain authoritative; the file lock only prevents competing local supervisor processes.

## Reproducible checks

With Node 24+ and the local SpacetimeDB host running:

```sh
node --test src/research-schedule.test.ts src/swarm-plan.test.ts
node scripts/check-research-scheduler.ts
```

The first command covers pause/budget changes during ingestion, partial recovery, uncertainty, configuration drift, overlap limits, skipped windows and required config. The second checks actual Linux lock contention and crash release, creates a randomly named disposable database from **committed** trading-module source, compiles the fixture ingestor and rules workers, and verifies two actual sourced thesis/review/decision chains, idempotent retry/restart, authoritative pause rejection and resume. Its cadence clock is virtual for a fast deterministic check. It makes no SEC, broker or model requests and never publishes or resets either shared board or the paper database.

Successful output starts with `PASS: two real sourced cycles`. The check stops its workers and deletes its temporary database. Failed checks retain private temporary logs and print their directory; successful checks remove it. The check requires a local CLI identity and uses no brokerage/provider credentials. It is fixture acceptance, not real SEC freshness, Alpaca connectivity or model acceptance; those retain their separate board gates.
