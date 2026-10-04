# Coal delivery recovery — coaltrace, 2026-10-04

Task: `factorio-coal-recovery` (push when finished).

The live `iron-zero-20261004` run stopped actors 1, 3 and 5 on expired furnace reservations restored during startup. Miner 247 had no fuel despite coal held by actors and storage. The preceding burner bridge repair already supports drill fuel transfers.

Startup must reconcile pending receipts before starting reservation renewal and only restore unexpired owned leases. New actions continue to acquire reservations atomically; losing a lease during active work remains fatal. Recovery tests cover expired own reservations, completed-transfer reconciliation without replay, and quarantine of unknown transfers. Existing lease safety tests cover peer takeover and uncertain renewals.

The private actor-1 prompt now requests observing drill 247, supplying five existing coal if needed, and verifying working state. The original prompt is backed up beside it. This bootstrap action does not prove unattended automation. Preserve world/history IDs, actor identities/journals, the original deadline and shared $100 spend ledger on restart. Coordinate deployment with the research/assembler owner; do not start duplicate workers.

Validation: three new recovery tests and four existing resource-lease tests pass against the owner's integrated startup fix; TypeScript check passes with the matching in-progress research protocol/prompt types. The recovery test failed on the original worker with the observed `Resource lease lost` error. Runtime verification awaits the coordinated deployment.

Live deployment: `bfe2f47` includes the startup fix; tests were pushed as `2e953c5`. After the coordinated resume, all five worker journals advanced. Engine receipt `iron-zero-20261004-iron-zero-20261004-agent-1-act-218` completed `put` of five coal into drill 247. At tick 109167 its fuel inventory contained five coal. Its new status was `no_minable_resources`, exposing a separate placement problem. Actor 1 now has a private operator-prompt follow-up to recover/rebuild the drill over observed iron ore and verify actual operation, with existing resources only. Same world/history, original deadline and $100 ledger retained.

Operator correction: gameplay strategy belongs to the Astra orchestrator. Removed both actor-1 operator-prompt overrides, restoring its original prompt. The verified coal transfer above was operator-directed and is **not** autonomous orchestration evidence. No further fueling/placement instructions from this development session. The expired-lease recovery fix remains deployed; normal actor/orchestrator decisions continue under the preserved run controls.
