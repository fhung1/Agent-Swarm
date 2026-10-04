# Coal delivery recovery — coaltrace, 2026-10-04

Task: `factorio-coal-recovery` (push when finished).

The live `iron-zero-20261004` run stopped actors 1, 3 and 5 on expired furnace reservations restored during startup. Miner 247 had no fuel despite coal held by actors and storage. The preceding burner bridge repair already supports drill fuel transfers.

Startup must reconcile pending receipts before starting reservation renewal and only restore unexpired owned leases. New actions continue to acquire reservations atomically; losing a lease during active work remains fatal. Recovery tests cover expired own reservations, completed-transfer reconciliation without replay, and quarantine of unknown transfers. Existing lease safety tests cover peer takeover and uncertain renewals.

The private actor-1 prompt now requests observing drill 247, supplying five existing coal if needed, and verifying working state. The original prompt is backed up beside it. This bootstrap action does not prove unattended automation. Preserve world/history IDs, actor identities/journals, the original deadline and shared $100 spend ledger on restart. Coordinate deployment with the research/assembler owner; do not start duplicate workers.

Validation: three new recovery tests and four existing resource-lease tests pass against the owner's integrated startup fix; TypeScript check passes with the matching in-progress research protocol/prompt types. The recovery test failed on the original worker with the observed `Resource lease lost` error. Runtime verification awaits the coordinated deployment.
