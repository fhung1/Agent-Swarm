# Factorio acceptance work packages

Use these requirements to scope tasks on the **Development** board. Claim work and check locks before editing; each task must say **push when finished**. The [roadmap](IMPLEMENTATION_PLAN.md) defines phase order. Historical IDs below are acceptance labels, not a live assignment list.

| Package | Required evidence |
| --- | --- |
| `factorio-f0-runtime` | Fresh private 2.0.77 world, seed/mod hashes, ten actors, clear binary/port/save errors, no overwritten saves. |
| `factorio-f0-action-contract` | Bounded observations and `move`/`take`/`put`; invalid requests conserve resources; exact-ID retry returns original receipt; changed payload is rejected. |
| `factorio-f1-board-worker` | Distinct saved identities, applied subscriptions, atomic claim race, typed scoped messages, separate development/gameplay histories. |
| `factorio-f1-recovery` | Persist intent before submission; reconcile receipts/ownership; expire and renew reservations safely; stop on unknown outcomes or rollback. Crash after execution must not duplicate transfers. |
| `factorio-f1-production` | One worker turns declared ore/fuel into five game-produced plates; inventory and receipts agree. |
| `factorio-f2-ten-workers` | Ten processes/identities/actors, ten five-plate results, unique accounting and a real shared-resource conflict resolved through coordination. |
| `factorio-f2-dashboard` | Visible task/action/result history, stale/disconnected state, enforced pause/resume/stop, no exposed secrets. |
| `factorio-f3-fault-suite` | Disposable real-engine/database tests for resource conservation, claim/reservation races, crash, uncertain transport, restart, pause and save rollback; no leaked processes. |
| `factorio-f3-model-brain` | Validated bounded decisions, persisted limits including retries, per-actor prompts, peer context isolation, provider-free failures and separately recorded live inference. |
| `factorio-f4-freeplay-chain` | Mining, electricity, logistics, science, oil and advanced components from a declared natural map, without hidden grants/unlocks. |
| `factorio-f4-bounded-attempt` | Declared seed/time/model/action budgets; engine milestones and rocket event or an honest failure report with missing prerequisites. |
| `factorio-f4-runbook` | Fresh-checkout replay of install/start/watch/pause/stop/recovery; exact versions, commands, evidence and remaining gaps. |

## Cross-cutting checks

- Use stable run/world/history/actor/task/operation IDs; reject cross-scope inputs.
- Enforce ownership, unexpired reservations and pause immediately before action submission, including after inference.
- Test missing/corrupt journals, save rollback, lost acknowledgements and prolonged board outages. Preserve uncertain actions for reconciliation.
- Bound production, retries and viewing by persistent time/action budgets. Restart must not reset counters.
- Deduplicate logical action-result events; substring matching is not a delivery guarantee.
- Test simultaneous runs with overlapping actor indices and separate task identities.

## Operator release

The final guide must state host/client versions, dependencies, addresses, mods, finite budgets, log locations and safe stop/restart commands. An independent operator follows it from a fresh checkout, joins with a matching graphical client, sees ten actors and live messages, and checks pause/restart behavior. Record the source commit and artifacts. Unit tests, HTTP responses and old screenshots do not satisfy this gate.

A fixture pass proves fixture production. A real-provider run proves only the behavior actually observed. A rocket objective requires the game's rocket-launch event.
