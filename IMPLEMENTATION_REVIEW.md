# Quant Swarm implementation review — 2026-10-03

> **Historical snapshot.** Findings and line references below describe the repository at the time of this review. The follow-up table records fixes known when the review was updated, but later implementation should be read from [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), [README.md](README.md), and the live `quant-swarm-coord` board. [docs/markdown-task-coverage.md](docs/markdown-task-coverage.md) maps every remaining release gate to a board task. Do not use an unresolved statement in the original findings as current architecture guidance.

The repo has a working local research swarm: separate worker identities, leased tasks, persisted evidence and messages, analyst/skeptic/coordinator model handlers, and durable decisions and bounded proposals. It also has a read-only Alpaca adapter, an initial pure risk evaluator, order-ledger reducers, a separate one-client macOS game agent, and two VM lifecycle providers.

The follow-up completed **Phase 1 for the local prototype**, including its scoped reads and process recovery acceptance. Phase 0 is implemented but lacks its real Alpaca exit check. Pieces of Phases 2–4 have been built ahead of their acceptance checks. The complete Alpaca paper-trading demo has not happened; later local reducer checks use synthetic order/fill records.

This review inspected the current working tree, including uncommitted work, rather than only the last commit. Existing handoffs establish historical checks; checks rerun for this review are listed below. The original review made no implementation changes; the follow-up resolutions are recorded below.

## Fixes and acceptance follow-up

The findings below describe the original review. The subsequent bug-fix task implemented these changes:

| Finding | Resolution |
| --- | --- |
| Malformed account rows/numbers accepted | Strict shared parsers and snapshot validation reject malformed rows; regression tests reproduce the original cases. |
| Wrong cross-symbol prices / missing cash and shares | Per-symbol quote valuation, remaining order amounts, client-ID deduplication and atomic account-wide reservations. Optional portfolio/order/daily-loss limits fail closed when required inputs are absent. |
| Trusted arbitrary risk verdict / changed inputs | Immutable operator policy, snapshot/clock-pinned authoritative evaluation, TTL clamp and current-input recheck. Unsubmitted proposals can be re-reviewed; old verdicts remain in a private history table. |
| Public unrestricted reads | All state tables private, indexed `my_*` views with role/run/account grants and live revocation. |
| Weak order/fill validation | Explicit transitions, immutable broker identity, exact decimal fill sums, overfill rejection and full retry comparison. Broker submission/reconciliation service remains Phase 4. |
| Temporary failures and paused work | Bounded retries, cancellation, run-aware dispatch, stale-connection guards and abort on lost lease. |
| Decision input drift | Frozen thesis/critique/quote/model/prompt/policy/cap records; durable model response audit and replay. |
| Reassigned task authorship collision | Replacement workers reuse durable thesis/challenge/claim rows without impersonating their original authors. |
| Protocol bounds / oversized IDs | Run-scoped evidence, future-date rejection, payload limits, lease validation and stable bounded IDs. |
| No inference budgets | Durable per-run call/token/concurrency/attempt reservations, actual usage/model/output records; uncertain calls retain reserved budget. Currency cost reporting remains Phase 6. |
| Game forced-input cleanup / token overshoot | Independent input-release watcher survives helper termination; model token preflight reserves the maximum output before sending a request. Swift build and dry-run EOF release check passed; live gameplay remains unverified. |

The owner has superseded per-order human approval: a fresh authoritative risk pass is the gate for paper execution. The optional legacy approval table/reducer does not authorize or block execution. Prompts and current setup documentation follow this decision.

Phase 1 acceptance passed through `npm run check:phase-one` in run `phase-one-1791058021567`: actual claim-racing workers, sourced three-role decisions, same-token restart, pause/resume, lease takeover, 65-second lease renewal, grant revocation, long IDs, budgets, and risk/ledger checks. The separate structured-handler fixture also passed with 13 synthetic responses. Real Alpaca connectivity, broker execution/reconciliation, deployment service identities, and live gameplay remain separate exit checks. Initial SEC ingestion now saves the primary filing document, a checksum-matched manifest and accession-filtered XBRL facts. The provenance session verified this on `sec2`. Qualitative excerpts, richer research semantics and a model-backed real-company decision remain Phase 2 work.

## Original trading plan assessment (historical)

| Phase | Implementation at review time | Remaining work recorded at review time |
| --- | --- | --- |
| 0 — Connectivity | SpacetimeDB CLI/SDK 2.10.2, local published database, generated bindings, persistent client tokens. Alpaca adapter reads account, positions, paginated open orders, and selected quotes using fixed hosts and GET only. Account and quote rows persist atomically. | Run the actual Alpaca paper-account read with credentials and an entitled feed; confirm response parsing and resulting records. Synthetic fixture snapshots do not satisfy this check. |
| 1 — Swarm core | 19 tables; owner grants; role-gated reducers; typed durable messages; task dependencies, atomic versioned claims, 60-second leases and renewals; snapshot-before-work and reconnect reconciliation. Three roles support rules or structured Claude/Codex inference. Trade decisions and proposals commit atomically and accept identical retries. | Scoped read views, authorization for private account/order consumers, run membership, deployment authentication, and recovery/error improvements. Local coordination/restart checks passed. A Codex three-worker fixture run completed; Claude inference has not passed. |
| 2 — Research | Sources, dated facts, thesis citations, skeptic challenges, explicit trade/abstain/revise decisions, fixture ingestor. Same-symbol market observations can be cited. | SEC ingestion; artifact store and document excerpts; reporting/filing/amendment metadata; extraction and valuation quality checks; deterministic freshness rules; immutable decision-input snapshots; model/prompt/version metadata; structured catalysts, holding horizon, review dates and exit paths. A sourced real-company cycle is still missing. |
| 3 — Risk and review | Pure deterministic evaluator with tests; separate risk authority; risk expiry, operator approval and gated reservation reducers. | Running risk worker, authorized account/order views, Alpaca clock/calendar ingestion, versioned policy storage, aggregate reservations and portfolio limits, strict input parsing, material-change invalidation, operator approval interface. No deployed proposal-to-risk-to-approval workflow exists. |
| 4 — Paper execution | Private order/fill/reconciliation tables, unique proposal/client-order identifiers, gated order-intent reservation, update/fill reducers. | Actual paper executor; submit/lookup/cancel calls; uncertain-submission recovery; trade-update stream; partial-fill/account-activity reconciliation; validated state transitions; startup and periodic reconciliation; timeout and external-activity drills. The adapter inspected at review time could not submit an order. |
| 5 — Position monitoring | Thesis invalidation text and stored position snapshots are foundations. | Scheduled/event-triggered thesis review, position-to-thesis linkage, hold/reduce/exit proposals and exit checks through the same risk/approval path. No position-monitor service exists. |
| 6 — Evaluation and operations | Metric/reconciliation tables, logs, setup docs and local fixture checks. | Automated metrics and cost collection, benchmarks, decision-quality review, portfolio reports, dashboard/alerts, deployment supervision, failure drills, backup/restore and reproducible CI checks. |

At review time there was no operator dashboard or approval screen. The reviewed `run` schema stored only ID, goal, status and creation time; the planned universe, policy version, model budget and cadence were not durable run configuration. Dedicated valuation and portfolio analysts had not been implemented; the first analyst/skeptic/coordinator combination was intentional and sufficient to prove coordination.

## Evidence and checks

Rerun for this review:

- `npm run typecheck`, `npm run build`, `npm test`: passed; 22 tests cover the pure risk evaluator, role validation and game action schema.
- `npm run game:build`: passed, including the Swift desktop helper.
- `SPACETIME_CLI="$HOME/.local/bin/spacetime" npm run check:research-fixture`: passed against the real local database. It exercised all three model handlers using 13 schema-validated synthetic responses; trade/abstain/revise, replay, same-identity coordinator reconnection, role rejection and atomic decision/proposal rollback passed. Run `model-fixture-1791056537322` was closed and temporary roles revoked. This is not a live provider or full worker-process test.
- Local database inspection confirmed completed analyst/review tasks in `codex-e2e-1` and an `abstain` decision. The prior handoff records that these workers used actual Codex inference. I did not repeat paid inference in this review.
- Local `paper_order` count: zero.
- Both Python fleet modules parsed; remote-libvirt and both Tart example configurations passed their read-only `plan` commands. No VM was created, started, stopped or deleted.
- Alpaca open-order pagination was checked against the [official Get All Orders reference](https://docs.alpaca.markets/us/reference/getallorders-1): the current `before_order_id` cursor and 500-row page limit are documented. This does not replace the pending live account check.
- Targeted pure-risk probes reproduced the parsing and valuation defects below despite the existing suite passing.

Prior handoffs also record a two-worker claim race with exactly one winner, identity persistence after restart, a three-role rules cycle, interrupted analyst recovery, and a 70-second task completing through lease renewal. The live Alpaca read, live Claude cycle, live game interaction, and VM-hosted game loop remain unverified.

## Correctness and completeness findings

**High — account parsing can approve malformed risk inputs.** `src/agents/risk.ts:45–65` drops non-object array entries and converts invalid/missing numeric position and order fields to zero. Probes with an AAPL position whose `qty`/`market_value` are `"bad"`, and an MSFT open buy whose quantity fields are `"bad"`, both returned `pass`. Reject malformed rows and distinguish supported notional orders from corrupt quantity orders. Account snapshot validation currently checks JSON arrays, not row contents.

**High — pending exposure is incomplete and other-symbol prices are wrong.** `src/agents/risk.ts:22` gives pending swarm intents only ID, symbol and side; they cannot reserve quantity or cash. Checks at lines 127–140 count them only for same-symbol/side duplicates. Two buys in different symbols can each pass against the same buying power before either reaches Alpaca. The `orderValue` fallback at line 118 also prices every unpriced broker order using the proposed symbol's midpoint. A probe proposing an AAPL buy showed an open MSFT market order valued at AAPL's $200 midpoint. Carry remaining quantities/notionals, per-symbol marks and atomic reservations; reject unknown exposure. Add the planned total exposure, daily loss and open-order limits, which are absent from the policy interface.

**High — risk approval is a trusted service assertion with no operating service yet.** `spacetimedb/src/records.ts:124` accepts a risk identity's `pass`, checks text, policy string and future expiry without evaluating `risk.ts` or referencing a persisted policy/snapshot version. `reservePaperOrder` checks active run, TTL and operator approval, but does not invalidate approval after account/quote changes or re-evaluate account state. Preserve the independent service authority while making its policy, input snapshot and reservations durable and validating them before execution.

**High before remote use — read authorization is unfinished.** Public tables are readable by any connecting client (`spacetimedb/src/schema.ts`); a recipient role is only a message label. No scoped views exist, and generated clients cannot subscribe to private account/risk/approval/order rows. This is both a confidentiality boundary and a functional blocker for risk, executor and dashboard clients. The provided local start script binds to loopback, which is appropriate for the current implementation.

**High before execution — order/fill validation is incomplete.** `spacetimedb/src/records.ts:169–192` allows nonterminal order status regressions, Alpaca ID replacement, and fills with arbitrary price/quantity strings or cumulative quantity beyond the proposal. It prevents a small set of terminal regressions and deduplicates activity IDs, but does not enforce a full order state machine. Submission reservations are unique, but an uncertain reservation retry has no consumer read/reconciliation path yet. Validate transitions, immutable broker identity, fill amounts and cumulative totals; implement recovery before adding broker writes.

**Medium — retries and pause handling can turn temporary conditions into failed research.** `src/worker.ts:108` marks every analyst/skeptic exception as terminal, including transient model/network failures. Its scan does not check the cached run status before resuming work or invoking the coordinator model. Database reducers block paused writes, but a paused run can still incur inference and lead to task failure. Add run-aware dispatch, bounded transient retries, explicit permanent errors, cancellation and recovery records.

**Medium — traceability does not yet freeze the decision inputs.** The coordinator reads a latest quote and challenges into memory (`src/agents/model-handlers.ts:110`) but the decision stores only thesis ID/outcome/rationale. The exact sizing quote, selected critique IDs, policy, model and prompt versions are not stored with the decision. Immutable evidence IDs are useful, but they do not reconstruct all inputs actually shown to the model. Freeze the decision-input set, its timestamps and versions; apply deterministic availability/freshness checks.

**Medium — task reassignment can collide with stored authorship.** Recovery is strongest when the same token returns. If an analyst publishes its thesis and claim message, then disappears before completing the task, a different analyst reclaiming the expired lease skips the stored thesis but attempts to repost the same claim ID with a different sender. `postMessage` rejects that retry; the replacement worker can fail the task. Handle existing durable results/messages across authorized assignee changes and test partial completion followed by lease takeover.

**Medium — protocol validation and ID derivation need tightening.** `requireEvidence` checks existence and symbol but not source/thesis run scope or decision-time availability. Several research fields lack payload bounds, and thesis publication checks ownership but not lease expiry. Task IDs may be 128 characters, while worker-derived thesis/review/decision/message IDs add prefixes/suffixes and exceed the same 128-character limit. Add domain-specific checks and bounded stable ID derivation.

**Medium — accounting, policy and recovery tests remain incomplete.** Research inference has no run-wide concurrency/spend budget or durable token/cost accounting. Existing tests do not cover these risk defects, scoped reads, task takeover, order transitions, approval invalidation or submission timeout reconciliation. The fixture checker exercises reducers/handlers, not a supervised worker fleet. These are concrete remaining acceptance checks rather than reasons to discard the functioning prototype.

## Game and VM track

This track is separate from the Alpaca phases and follows `GAME_AGENT_IMPLEMENTATION_PLAN.md`.

- **Scenario phase 0 remains open:** choose the first game/server/scenario and prove a human client joins; accounts, licensing, host capacity and budget remain decisions.
- **One-agent phase 1 is implemented but unaccepted:** the macOS Factorio/Minecraft agent captures a foreground game window, calls a vision model, validates bounded actions, emits keys/mouse input through a Swift helper and saves before/after traces. Minecraft has relative camera, simultaneous keys and crosshair actions. Builds and action-schema tests pass; actual movement, camera response, coordinate alignment, goal completion and stop behavior have not been verified in a running game.
- **VM lifecycle infrastructure exists:** remote libvirt over SSH and local Tart for macOS/Linux support plan/create/start/up/status/stop/destroy, state manifests and identity safeguards. Tart requires an installed runtime and prepared template. This review exercised only configuration planning. Neither provider installs games, starts a game server, launches agents or establishes a graphical session.
- **Game phases 2–6 remain unimplemented as a working system:** two isolated concurrent agents, SpacetimeDB game schema/messages/action references, dashboard grid, stuck/reconnect/crash recovery, incremental scaling to ten and a cooperative baseline experiment.
- **Linux game control is missing:** the current worker rejects non-macOS platforms and uses macOS capture/input APIs. Linux VM lifecycle support does not imply Linux agent support.
- **Reliability limit:** held input uses normal-path cleanup and bounded sequences; forced termination of the native helper has no independent input-release watchdog. The game token budget is checked around completed requests and can overshoot by one inference. Fix and verify these before concurrent/unattended game runs.

## Next implementation work recorded by the review (historical)

1. Complete the Phase 0 real Alpaca paper-account/feed read and the live risk-worker check with configured credentials. Local reducer fixtures do not satisfy broker connectivity acceptance.
2. Complete Phase 2 research acceptance on real SEC evidence: usable filing excerpts, valuation/catalyst context, holding horizon, review/exit conditions and a model-backed thesis/challenge/decision trace. Define the pilot universe, cadence, benchmark, entitlements and limits.
3. Complete Phase 3 service acceptance against fresh broker inputs, including rejected stale/duplicate/over-limit/changed-state proposals and unattended risk refresh. The authoritative module gate and local regressions are implemented.
4. Build Phase 4 paper submission/lookup/cancel, trade updates and startup/periodic reconciliation. Verify one risk-passed order, uncertain submission, partial fills and external activity with unique client IDs and no duplicate broker submission.
5. Add Phase 5 position review and hold/reduce/exit proposals through the same gate.
6. Add the Phase 6 operator trace/dashboard, evaluation/benchmark reports, monetary cost accounting, alerts, deployment supervision and backup/restore drill.

Phase 1 is locally accepted. Game work remains a separate track: prove one running client’s capture, input, model loop and termination before scaling the fleet.

Current replacements for this list are tracked explicitly: connectivity (`trading-connectivity-acceptance`), sourced model research (`trading-qualitative-evidence`, `trading-team-roles`, `trading-model-acceptance`), live risk (`trading-risk-live-acceptance`), broker acceptance (`trading-paper-order-acceptance`), position review (`trading-position-reviews`), and evaluation/operations (`trading-evaluation-alerts`, `trading-ops-deployment`, `trading-live-demo-guide`). The executor, operator cancellation, trade-update stream, dashboards, CI-style isolated checks, and backup/restore drill were implemented after the original assessment; their existence does not satisfy the remaining credentialed exit checks.
