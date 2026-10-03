# Markdown plan coverage and runnable-pilot gates

Audit: 2026-10-03, session `codex-queue`, board task `markdown-board-audit`.
The operator requested that unfinished work in committed Markdown be completed or present in the system, then that planning continue until Factorio, Minecraft and paper trading have complete test/run paths. This is a coverage audit, **not a claim that the pilots are runnable**. Live assignment/status lives in `quant-swarm-coord`.

All tracked Markdown at the audit snapshot was inventoried, including plans, BACKLOG, historical review/handoffs, root/game/VM/dashboard guides and optional hackathon ideas. A parallel publisher added `docs/factorio-pilot-contract.md`; its release boundaries map to the same Factorio chain below. Old review findings explicitly resolved in the review's follow-up table are not recreated as bugs. Historical “uncommitted” claims are not evidence of missing code where later committed code/handoffs supersede them.

## Coverage by source and remaining deliverable

| Source / unfinished work | System task(s) or completion evidence |
| --- | --- |
| IMPLEMENTATION_PLAN Phase 0: real read-only account/data check | `trading-connectivity-acceptance`; credentials/account/feed choices tracked in `trading-pilot-choices` |
| Phase 1: identities, scoped views, claims, leases, replay and recovery | Implemented; `scripts/check-phase-one.ts`, `scripts/check-all.ts`, review follow-up and pushed `resolve-rebase` results record local acceptance. Deployment identity remains `trading-ops-deployment`. |
| Phase 2: narrative evidence, valuation/portfolio roles, real sourced model cycle | `trading-qualitative-evidence`, `trading-team-roles`, `trading-model-acceptance` |
| New/amended filings and recurring research, missing from initial backlog | `trading-sec-updates`, `trading-research-scheduler` |
| Phase 3: risk rules and freshness | Local authoritative gate implemented (`spacetimedb/src/risk.ts`, `risk-gate.ts`, regression/process checks); actual service acceptance is `trading-risk-live-acceptance` |
| Phase 4: trade updates, cancellation, partial/uncertain fills, external activity, live order reconciliation | `trading-order-stream`, `trading-operator-cancel`, `trading-paper-order-acceptance` |
| Phase 5: holding/review/exit conditions, position linkage and event-triggered exits | `trading-position-reviews`; requires specialist/evidence work and coordinates with SEC updates/scheduler |
| Phase 6: benchmark returns, metrics, no-trade quality, dollar costs, alerts | `trading-evaluation-alerts` |
| Phase 6: private deployment, OIDC/service credentials, lifecycle supervision, recurring backups, deployment manifest | `trading-ops-deployment`; existing backup/restore scripts and `check-backup.ts` have historical passed drill evidence, not proof of scheduled backups |
| Operator trace, fresh browser permissions, pause/cancel, live startup handoff | Existing dashboard plus `trading-dashboard-acceptance`, `trading-live-demo-guide` |
| Open trading strategy, universe, budget/account/model/feed/cadence choices | Executable validator/preparer complete in `trading-pilot-config` (f003575, pushed through e1e9980); actual operator choices remain `trading-pilot-choices` |
| GAME_AGENT_IMPLEMENTATION_PLAN M0: private server, ten idle joins, Java/EULA/whitelist | `minecraft-server`, `minecraft-pilot-choices` |
| M1: local state, fixed commands, one model worker, budget/trace | `minecraft-commands`, `minecraft-worker` |
| M2: scoped game state, authenticated messages/knowledge, cited actions | `game-state-core`, `minecraft-shared-state`; reuse `generic-message-board` where compatible |
| M3: ten independent processes, no coordinator, global/per-agent limits | `minecraft-ten-agents` |
| M4: information modes and matched-seed sharing experiment | `minecraft-sharing-eval` |
| M5: death, disconnect/crash/server restore/DB recovery | `minecraft-recovery` |
| Minecraft undecided goals/cadence/spend/radius/library and final visible run | `minecraft-pilot-choices`, `minecraft-live-demo-guide`, `game-operator-dashboard` |
| FACTORIO_IMPLEMENTATION_TASKS F0 | `generic-message-board`, `factorio-contract`, `factorio-f0-runtime`, `factorio-f0-action-contract` |
| F1: durable worker, uncertain-action recovery, real production | `factorio-f1-board-worker`, `factorio-f1-recovery`, `factorio-f1-production` |
| F2: ten workers and shared operator visibility | `factorio-f2-ten-workers`, `factorio-f2-dashboard` |
| F3: fault suite, bounded model adapter | `factorio-f3-fault-suite`, `factorio-f3-model-brain` |
| F4: natural-map progression, bounded rocket report, final runbook | `factorio-f4-freeplay-chain`, `factorio-f4-bounded-attempt`, `factorio-f4-runbook` |
| Factorio live graphical observer demo and independent release gate | `factorio-live-demo-guide`, restored missing `factorio-acceptance-review`, restored tracking umbrella `factorio-gameplay-swarm` |
| BACKLOG cancelled Factorio evaluation retains comparison criteria | `factorio-sharing-eval`; recovery itself is in F1/F3 |
| Deferred game/README historical GUI join and adapter IDs | `factorio-client-join` (blocked), `factorio-desktop-adapter` (waits on blocked join); these do not replace current headless production/spectator demo tasks |
| src/game/README live Mac input/camera/watchdog and token/currency limitations; VM guide/runtime handoffs | `vision-vm-runtime` (blocked), `vision-linux-isolation` (depends on blocked runtime), plus `factorio-desktop-adapter`. Covers licensing/account plan, one native/guest validation, Linux service, two-client isolation and later scaling. |
| HACKATHON_TRACKS_AND_PRIZES optional integrations and submission ideas | `optional-track-selection` (blocked): all suggested ASI/Photon/Neon/Nessie/voice/Notability/Figma/sustainability/hardware/Relay/space/side-quest/healthcare/Solana options are listed for explicit selection; no optional integration is silently authorized |
| README/dashboard/IMPLEMENTATION_PLAN contradictory historical status | `docs-current-state`: update current instructions while preserving dated evidence |
| HANDOFF pending SEC provenance wording and live model/risk/executor checks | Provenance implementation exists; narrative/model/live acceptance mapped above. Missing dashboard supervision belongs to `trading-ops-deployment`; scheduled research to `trading-research-scheduler`. Old run test rows are retained audit data, not orders to delete. |
| HANDOFF old risk/security/protocol/budget defects | Explicitly resolved in IMPLEMENTATION_REVIEW follow-up and current module/tests; do not recreate superseded human-approval or public-table designs |
| AGENTS later live-money trading | Explicitly outside authorized paper product; requires separate owner authorization/product phase. It is not an unfinished pilot task and is not enabled by this audit. |

## Added tasks

The audit added these 18 tasks; existing backlog/package tasks were preserved:

- Trading: `trading-pilot-choices`, `trading-risk-live-acceptance`, `trading-research-scheduler`, `trading-sec-updates`, `trading-ops-deployment`, `trading-dashboard-acceptance`, `trading-live-demo-guide`.
- Minecraft: `minecraft-pilot-choices`, `minecraft-live-demo-guide`.
- Factorio: `factorio-acceptance-review`, `factorio-gameplay-swarm`, `factorio-sharing-eval`.
- Deferred: `factorio-client-join`, `factorio-desktop-adapter`, `vision-vm-runtime`, `vision-linux-isolation`, `optional-track-selection`.
- Documentation: `docs-current-state`.

Each carries source references, concrete deliverables, acceptance criteria, dependencies where enforceable, and the literal “push when finished” instruction. The board accepts one prerequisite: additional required gates are explicit in task details and the checklist below. A ready claim does not mean all release conditions are satisfied. Deferred children remain open behind blocked prerequisites because the board cannot block an unclaimable dependent task; they are not ready to execute.

## Test/run release checklist

| Application | Minimum gates before reporting ready |
| --- | --- |
| Paper trading | Operator-selected valid pilot; real account/feed connectivity; fresh authoritative risk-service checks; sourced model cycle; trade-update/cancel and timeout/restart/partial/external-activity evidence; actual reconciled paper order; scoped dashboard/control checks; scheduler/review/alert coverage; reproducible guide and chosen deployment/backup procedure. No live credentials or endpoint. |
| Minecraft | Resolved pilot budgets/goal; operator EULA and supported private server; ten idle joins; bounded command/model checks; private game-board audit; ten-agent run without orchestrator; information-mode comparison; recovery; visible licensed-client/operator guide replay. |
| Factorio | Version/scenario contract; real runtime and action receipts; durable board identity/claims; journals/reservations/recovery; verified plates; ten workers; dashboard pause/stop; F3 fault suite and independent visible demo. F4 readiness additionally needs freeplay chain, bounded attempt evidence and final runbook. An honest failed rocket report never proves victory. |

## Verification and limitations

Read back the persisted task table after additions: **63 total records**, all **18 new task payloads and prerequisite links** verified, all prerequisite IDs exist, and the graph is acyclic. Later concurrent edits may change counts/status. Existing Factorio IDs and BACKLOG tasks were matched to records; cancelled aliases map to active replacements, not lost requirements. The audit did not run game clients, broker orders or provider inference, and does not reuse draft code as acceptance evidence. Source-level pilot checks are recorded separately in `docs/handoffs/codex-queue.md`.

Next planning passes should turn concrete failures from acceptance runs into narrow follow-up tasks, rather than declaring readiness from this inventory alone. Keep the three final demo/release tasks open until their required evidence exists.
