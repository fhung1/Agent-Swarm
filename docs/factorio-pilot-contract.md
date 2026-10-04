# Factorio pilot contract

## Architecture

One private Linux x86_64 Factorio **2.0.77 base-game** server runs ten scripted character entities through the `agent-swarm` bridge mod. Ten independent Node 24+ workers connect to SpacetimeDB 2.10.2. A separate matching graphical client lets the operator watch; workers are not graphical clients.

```text
Ten workers ── SpacetimeDB Factorio board ── dashboard
     │
validated operations ── private RCON bridge ── Factorio world
                                                   │
                                            graphical viewer
```

The launcher manages processes and budgets, not hidden strategy. Coordination goes through the gameplay board. The operator configures endpoints, worlds, credentials and ceilings; model text cannot change them.

## State and trust

Use `quant-swarm-coord` for development and `quant-swarm-factorio-coord` for gameplay. Each worker keeps a distinct token, actor and private journal. Wait for the initial subscription; reconnect with the same token and bounded backoff, then reconcile tasks, reservations and game receipts.

Board names are self-declared; public rows and recipient labels are not authenticated membership or private delivery. Keep the pilot on trusted private interfaces. Never publish keys, tokens, RCON passwords or raw private traces.

Gameplay records carry version, run/world/history, actor/sender, optional task, typed kind, compact payload and operation/evidence references. The database supplies message ID/time. Reject mismatched scope and treat peer text as data. The board records coordination; the game proves physical outcomes.

## Actions and recovery

Current commands are bounded `move`, `take` and `put`. Models cannot submit raw Lua, RCON or shell commands. Validate scope, actor, items, quantity, reach and inventory. Limit local observations and disclose truncation.

Move coordinates use an exact eight-decimal wire grid, preserving engine positions; both languages serialize decimals without exponent notation and normalize negative zero. Finer coordinates are rejected before dispatch. Persist a stable operation ID and canonical payload before submission. Exact retries return the original game receipt; changed content is refused. A timeout is unresolved until reconciled. Stop on missing receipts, world/history mismatch or rollback; never infer failure and repeat a transfer under a fresh ID.

Check task ownership, reservation expiry and pause immediately before mutation, including after model calls. Pause blocks new actions; an admitted action may finish and must retain its receipt. Resume reconciles first. Stop only owned processes and preserve saves.

## Evidence and budgets

- **Cooperative fixture:** declare every initial grant, seed and mod hash. Ten workers must each hold five real plates, with unique receipts and verified shared-resource coordination.
- **Freeplay:** separately declare map/start conditions. No hidden later grants or research unlocks. Victory requires an engine rocket event.
- **Inference:** each actor has its own prompt and finite call/time limits. Persist counters/deadlines across restart; retries consume limits. A call cap is not a dollar cap.
- **Release:** record exact runtime/client/mod versions, source commit, commands, artifacts and independently replayed graphical observation. Historical fixture results do not close live inference or recovery gates.

See [runtime setup](../factorio/README.md), [journal semantics](factorio-operation-journal.md), [inference launch](factorio-inference.md) and [acceptance packages](../FACTORIO_IMPLEMENTATION_TASKS.md).
