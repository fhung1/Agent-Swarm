# Factorio readiness audit — 2026-10-03

Scope: Factorio only. Reviewed main through `0392fd8` (implementation at `a57a3cb`), the implementation plan, committed worker/bridge/journal, verification reports and live development board. This is a planning audit, not a new runtime acceptance run.

## What already has evidence

`docs/factorio-live-verification.md` records ten independent rules workers producing fifty actual iron plates with matching game receipts, distinct identities and resource contention. Runtime preparation, bounded movement/transfers, the operation-journal library, tailnet binding and independent black-box verification have completed board records. Do not add another basic ten-worker/fifty-plate demonstration task.

That evidence does not establish model-driven play, full recovery acceptance, a clean-checkout operator release or freeplay/rocket progression. Open F0–F4 milestones still require their complete acceptance criteria; preparatory task completion alone is not sufficient to close them. Active live-launch/restart owners retain their claims.

## Five added implementation subtasks

Each task has concrete failure tests, parent milestone references, a prerequisite, and the literal instruction **push when finished**. Work must be committed/pushed directly to main with checks recorded, without new pull requests.

| Board task | Committed gap | Required outcome |
| --- | --- | --- |
| `factorio-worker-journal-integration` | `src/factorio/demo-worker.ts` uses its own JSONL log instead of the tested `OperationJournal`. | Integrate durable scoped operations and receipt reconciliation; crash boundaries and rollback/history mismatch cannot duplicate transfers. |
| `factorio-action-lease-fencing` | Task ownership is checked once; action submission does not consistently check board readiness and unexpired reservations. | Central admission checks, renewal and loss-of-authority handling, including isolated disconnect/expiry/takeover tests. |
| `factorio-run-isolation` | Fixed `plate-01` task names and a hardcoded gameplay database impede safe reuse across runs. | Configurable connection and consistent run-scoped identities/tasks; two overlapping fixtures remain isolated and restart correctly. |
| `factorio-message-outbox` | Action-result publication uses body substring matching and cannot resolve uncertain acknowledgements reliably. | Durable stable event IDs and exact envelope validation; retries produce one logical result without another game action. |
| `factorio-rules-run-limits` | Resource waits and the post-production viewing loop can run indefinitely. | Persistent time/step limits across every phase and restart; bounded cleanup and conserved inventory. |

Journal integration depends on completed `factorio-operation-journal`; admission fencing and rules limits depend on completed `factorio-bridge-prep`. Run isolation and outbox work depend on `generic-message-board`, whose owner should finish its board handoff. These are specific implementation gaps beneath the existing worker/recovery/ten-worker/fault-suite milestones, not replacement milestones.

## Already tracked; do not duplicate

- `factorio-board-outage-recovery` was added by the live-session owner during this audit following a reported database outage. It covers supervisor recovery, durable phases, ownership reconciliation and resuming after production without replaying transfers. Coordinate journal integration and worker limits with that task.
- `factorio-f2-dashboard`, `factorio-live-demo-guide`, `factorio-acceptance-review`, and the active launch/restart tasks cover operator controls, graphical viewing and reproducibility. A past production result is not proof that a viewer or worker is currently healthy.
- `factorio-f3-model-brain` and `factorio-model-agent-chat` cover model decisions, purposeful communication and inference budgets. The new rules-worker limit task covers the current deterministic worker regardless of model use.
- `factorio-sharing-eval` covers the communication baseline experiment. `factorio-f4-freeplay-chain`, `factorio-f4-bounded-attempt`, and `factorio-f4-runbook` cover progression and the bounded rocket attempt/release.
- Deferred vision/desktop tasks remain deferred; the current private headless-game pilot does not require reopening that older architecture.

## Verification and handoff

The audit reads committed code and recorded evidence only; it does not alter live game worlds or run paid model calls. New board records are read back to verify exact IDs, open status, prerequisites and push instructions, with dependency traversal checked for missing tasks/cycles. No application tests are required for these documentation/board-only changes. Publication commit and final check result are recorded on `factorio-readiness-audit`.
