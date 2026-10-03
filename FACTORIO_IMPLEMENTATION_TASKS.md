# Factorio Swarm implementation task plan

This is the detailed DEVELOPMENT-board breakdown of the F0–F4 plan owned by `factorio-gameplay-swarm`. The existing implementation plan lives at `factorio/IMPLEMENTATION_PLAN.md` on `feat/factorio-gameplay-swarm` until integrated. This document specifies intended deliverables, not completed capabilities. At planning time, runtime verification and a protocol/mod draft were reported; live validation was still pending.

## Scope and delivery order

Build ten independent, durable gameplay workers in one private headless Factorio world. Prove a cooperative production fixture first, then recovery and operator controls, then natural-map progression and a bounded rocket attempt. A game-reported rocket event is the victory criterion. Scripted characters, fixture production and vanilla freeplay must be labeled separately.

The existing `factorio-gameplay-swarm` task remains the implementation umbrella; `factorio-acceptance-review` remains independent acceptance. The tasks below are its detailed work packages, not competing rewrites. Before claiming an overlapping package, coordinate ownership and file-lock transfer with the umbrella owner. Existing implementation can satisfy a package when its checks and pushed commit are recorded. Do not mark tasks done solely because code is drafted. Cross-cutting independent acceptance remains a release gate.

## Board connection and execution rules

- **Development:** `quant-swarm-coord` holds these coding tasks, implementation decisions, locks and results. Use `node scripts/coord.ts ... --as <session>` (set `COORD_DB=quant-swarm-coord` explicitly when switching contexts).
- **Factorio:** `quant-swarm-factorio-coord` holds gameplay participants, objectives, task claims, resource reservations, observations, requests and action results. Reuse the shared message-board module/client and dashboard; do not build a second messaging implementation. Workers receive board/world configuration from configuration, not model text.
- Durable gameplay messages identify run/world, task, sender, kind, timestamp, compact payload and operation/evidence references. Useful kinds include observation, resource request, task handoff, blocker and action result; freeze exact names against the shared client contract before implementation. Recipient labels route messages; they do not imply privacy.
- Each worker uses a saved distinct identity, waits for subscription application, reconnects with bounded backoff and reconciles ownership plus pending receipts before acting. Game state determines action success; board messages alone do not prove it.
- The board currently supports one `--after` prerequisite. The linear chain below deliberately makes every mandatory prerequisite enforceable. Independent acceptance may proceed alongside implementation, but its passing result is required for release.
- Claim the task, lock files, post contract changes, update a distinct `HANDOFF.md` entry and preserve other sessions' work. Every task: **push when finished**. Completion records must include pushed commit, check commands/results, evidence links, limitations and next steps.

## Registered work packages

| Board task | Depends on | Delivery |
| --- | --- | --- |
| `factorio-f0-runtime` | `generic-message-board` | F0: Reproducible private runtime and scenario |
| `factorio-f0-action-contract` | `factorio-f0-runtime` | F0: Validated observation and action protocol |
| `factorio-f1-board-worker` | `factorio-f0-action-contract` | F1: Durable worker connected to Factorio message board |
| `factorio-f1-recovery` | `factorio-f1-board-worker` | F1: Journal, reservations and uncertain-action recovery |
| `factorio-f1-production` | `factorio-f1-recovery` | F1: Rules worker completes verified iron production |
| `factorio-f2-ten-workers` | `factorio-f1-production` | F2: Ten independent workers and shared-resource coordination |
| `factorio-f2-dashboard` | `factorio-f2-ten-workers` | F2: Factorio board visibility and operator controls |
| `factorio-f3-fault-suite` | `factorio-f2-dashboard` | F3: Isolated production and fault-injection suite |
| `factorio-f3-model-brain` | `factorio-f3-fault-suite` | F3: Bounded model decision adapter |
| `factorio-f4-freeplay-chain` | `factorio-f3-model-brain` | F4: Natural-map production and research progression |
| `factorio-f4-bounded-attempt` | `factorio-f4-freeplay-chain` | F4: Bounded ten-agent rocket attempt and evidence report |
| `factorio-f4-runbook` | `factorio-f4-bounded-attempt` | F4: Reproducible operator handoff and release checklist |

## F0: Reproducible private runtime and scenario

- **Task:** `factorio-f0-runtime`; **depends on:** `generic-message-board`.
- **Deliverables:** Pin the existing 2.0.77 base-game runtime, seed, mod manifest and ports; provide install/preflight, isolated save directories and cooperative-starter versus freeplay configuration. Document scripted characters versus real multiplayer clients and all fixture grants.
- **Likely scope:** factorio/, config/factorio-pilot.json, scripts/factorio.ts. File ownership must be checked before edits.
- **Acceptance:** A clean setup starts a private server; version/scenario/seed are captured; missing binary, conflicting port and mismatched save fail clearly; no existing save is overwritten.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F0: Validated observation and action protocol

- **Task:** `factorio-f0-action-contract`; **depends on:** `factorio-f0-runtime`.
- **Deliverables:** Define versioned observations, bounded command schemas and structured errors. Implement own inventory/position and nearby observations, item/recipe/reach/timing validation in TypeScript and Lua, stable operation IDs, per-avatar serialization and game receipts. Models cannot provide raw Lua or RCON.
- **Likely scope:** src/factorio/, factorio/. File ownership must be checked before edits.
- **Acceptance:** A real resource-consuming action succeeds; malformed/out-of-range actions preserve resources; identical ID/payload replay returns one receipt; changed payload with the same ID fails; observations honor configured radius.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F1: Durable worker connected to Factorio message board

- **Task:** `factorio-f1-board-worker`; **depends on:** `factorio-f0-action-contract`.
- **Deliverables:** Reuse MessageBoardClient and generated bindings; configure quant-swarm-factorio-coord separately from quant-swarm-coord. Persist a distinct token per worker; wait for subscription snapshot, consume tasks/messages, atomically claim work and publish typed task-linked observations/results. Include run/world IDs, authenticated identity where available, timestamp and operation/evidence references. Document the trusted-local identity boundary.
- **Likely scope:** src/factorio/, shared message-board client. File ownership must be checked before edits.
- **Acceptance:** Two clients see the same task/message; one competing claim wins; restart keeps identity and receives durable history; DEVELOPMENT tasks/messages never appear on FACTORIO and gameplay records never appear on DEVELOPMENT.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F1: Journal, reservations and uncertain-action recovery

- **Task:** `factorio-f1-recovery`; **depends on:** `factorio-f1-board-worker`.
- **Deliverables:** Write a private pending-operation journal before game submission; reconcile game receipts and board task ownership on reconnect. Add renewable entity/resource reservations, bounded reconnect backoff and explicit stale-owner recovery. Stop on world/run mismatch, save rollback or unresolved action outcome.
- **Likely scope:** src/factorio/, factorio/. File ownership must be checked before edits.
- **Acceptance:** Crash after game execution but before board recording produces one resource change and one reconciled result. Competing reservations cannot both succeed; expired reservations recover visibly; board disconnection blocks actions until reconciliation.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F1: Rules worker completes verified iron production

- **Task:** `factorio-f1-production`; **depends on:** `factorio-f1-recovery`.
- **Deliverables:** Implement bounded observe/claim/act/verify behavior to obtain ore and fuel, operate a furnace and collect five actual iron plates. Publish useful resource discoveries, requests, blockers and completion evidence to the Factorio board. Keep shared knowledge sourced from messages and local observations.
- **Likely scope:** src/factorio/. File ownership must be checked before edits.
- **Acceptance:** One worker completes a production task against the real game; input/output accounting agrees with receipts and inventory; impossible actions produce a bounded failure or replan, never fabricated success.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F2: Ten independent workers and shared-resource coordination

- **Task:** `factorio-f2-ten-workers`; **depends on:** `factorio-f1-production`.
- **Deliverables:** Launch ten separate processes with distinct tokens/journals/avatar IDs in one world. Seed ten production tasks; workers claim and coordinate through the board. Supervise bounded restarts and preserve task ownership. Launcher manages lifecycle, not hidden strategy.
- **Likely scope:** scripts/factorio.ts, src/factorio/, config/factorio-pilot.json. File ownership must be checked before edits.
- **Acceptance:** Ten identities are simultaneously connected; each performs a verified action; ten tasks each yield five plates with non-duplicated accounting. A deliberate shared-resource conflict demonstrates reservation/retry or handoff, rather than ten isolated scripts merely running together.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F2: Factorio board visibility and operator controls

- **Task:** `factorio-f2-dashboard`; **depends on:** `factorio-f2-ten-workers`.
- **Deliverables:** Use the existing shared dashboard to expose ten participants, task owners, reservations, typed messages, action receipts and artifact links. Add or verify run pause/resume/stop with enforcement at worker scheduling and the game adapter; show stale/disconnected state and selected board. Coordinate dashboard edits with its owner.
- **Likely scope:** shared dashboard, src/factorio/, scripts/factorio.ts. File ownership must be checked before edits.
- **Acceptance:** An operator follows task-to-action-to-result history live and after reload; pause prevents new mutations, resume reconciles first, stop cleans up workers; switching boards retains isolation and no secrets are displayed.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F3: Isolated production and fault-injection suite

- **Task:** `factorio-f3-fault-suite`; **depends on:** `factorio-f2-dashboard`.
- **Deliverables:** Create repeatable checks using disposable SpacetimeDB state and a real pinned game process. Cover schema bounds, resource conservation, task/reservation races, worker crash, transport uncertainty, token reuse, board restart, pause/resume and save rollback. Coordinate with factorio-acceptance-review for independent black-box verification.
- **Likely scope:** scripts/check-factorio.ts, factorio-acceptance/, CI. File ownership must be checked before edits.
- **Acceptance:** Production and fault assertions pass with game-state evidence; all subprocesses terminate; failure reports identify stage/seed/run; user saves and both active boards remain unchanged by tests. Attach commands, artifacts and independent review result before closing.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F3: Bounded model decision adapter

- **Task:** `factorio-f3-model-brain`; **depends on:** `factorio-f3-fault-suite`.
- **Deliverables:** Reuse the repository model interface behind a configurable brain. Supply compact local observations and relevant board messages; validate structured proposals through the same action contract. Enforce per-agent/run inference, token, step and wall-clock budgets including retries; retain compact decision audit and private trace references.
- **Likely scope:** src/factorio/, existing inference interface. File ownership must be checked before edits.
- **Acceptance:** Deterministic stub checks reject malformed output and forbidden commands, count retries against budgets and stop at limits. Optional live smoke is explicitly reported as run or unrun; rules-only acceptance needs no provider credentials.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F4: Natural-map production and research progression

- **Task:** `factorio-f4-freeplay-chain`; **depends on:** `factorio-f3-model-brain`.
- **Deliverables:** Extend the action vocabulary and board task decomposition for electricity, mining/smelting, logistics, science/research, oil/chemicals, advanced components and rocket prerequisites. Use configurable specializations and shared requests rather than hard-coded worker-to-worker calls. Record prerequisite tasks and resource demand on the gameplay board. Break further work into narrowly owned development tasks if the capability gap exceeds one change.
- **Likely scope:** src/factorio/, factorio/, scenario configuration. File ownership must be checked before edits.
- **Acceptance:** From a separately declared freeplay seed, demonstrate successive resource-conserving production/research milestones with game evidence and no post-start item grants or research unlocks. Report unsupported steps explicitly; a fixture smelting pass cannot close this task.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F4: Bounded ten-agent rocket attempt and evidence report

- **Task:** `factorio-f4-bounded-attempt`; **depends on:** `factorio-f4-freeplay-chain`.
- **Deliverables:** Run the ten-worker swarm with explicit seed, scenario, action/model/time budgets. Capture milestones, game rocket-launch events, research state, blockers, communication overhead, contention, recovery and inference cost. Store large artifacts outside hot tables with board references.
- **Likely scope:** run artifacts, factorio reports, DEVELOPMENT follow-up tasks. File ownership must be checked before edits.
- **Acceptance:** Publish a reproducible report with ten identities and actual game evidence. Victory requires a real rocket event; budget exhaustion or failure must list exact missing prerequisites and create follow-up DEVELOPMENT tasks. An honest failed attempt can complete reporting but never the rocket objective.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## F4: Reproducible operator handoff and release checklist

- **Task:** `factorio-f4-runbook`; **depends on:** `factorio-f4-bounded-attempt`.
- **Deliverables:** Document install/start, board selection, rules/model configuration, pause/resume/stop, restart, recovery and report commands. State proven capabilities versus remaining gaps, fixture/freeplay differences and trusted-local limits. Link this task inventory, original implementation plan and independent acceptance report.
- **Likely scope:** README.md, factorio/IMPLEMENTATION_PLAN.md, HANDOFF.md. File ownership must be checked before edits.
- **Acceptance:** A fresh-checkout operator can reproduce the documented production check and inspect gameplay history. Final handoff includes checks, artifacts, pushed commits and any open progression tasks; no undocumented local state or secrets are required.
- **Completion:** Record evidence and checks in the board result and handoff; push when finished.

## Immediate next steps

The current implementer should map completed work to F0/F1 acceptance before anyone starts overlapping edits. First close the private runtime and real action contract gates; advance through the dependency chain. The independent acceptance owner should cross-check the F3 fault matrix. Keep all development discussion on Development and exercise the Factorio board only with gameplay records or isolated test databases.

## Planning handoff — factor-plan, 2026-10-03

- **Status:** Planning and board registration complete; implementation remains with the existing owners.
- **Work:** Created 12 detailed work packages on Development, with an enforced dependency chain from the completed shared-framework task. Preserved the active implementation umbrella and independent acceptance task.
- **Checks:** Read back persisted SpacetimeDB task rows and verified all 12 IDs, open statuses, prerequisite links, acceptance criteria and literal push instruction against this plan. Documentation whitespace check passed. No game or implementation tests were run for this planning-only change.
- **Coordination:** Requested a shared `HANDOFF.md` entry/lock handover from `codex-factorio`. That file remains locked by the implementation session; this distinct entry and the planning task result preserve the handoff without editing another session's locked file. Copy this entry to the shared log when its owner releases it. Publication commit is recorded in `factorio-plan-tasks` on Development.
- **Next:** The implementation owner maps existing work to F0/F1 evidence, then claims or allocates these packages with file-lock coordination. Independent acceptance reviews F3 and the final report. Gameplay communications use only the Factorio board.
