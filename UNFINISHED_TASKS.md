# Historical unfinished-task checkpoint

Historical snapshot: 2026-10-03. The stop instruction below was superseded by the owner’s explicit resumption of Factorio, Minecraft and paper-trading work. Current status is on the live development board; this archive must not cancel or reopen tasks automatically.

Original snapshot: All development is stopped at owner request. This file preserves original board status, ownership, dependencies and full task details for later resumption. Cancelled Factorio tasks remain historical only; Factorio belongs to the owner’s friend. No task is authorized to resume automatically.

Every resumed task must retain: **push when finished**.

## account-reconciliation-interlock — P0: reconcile full paper account and block trading on unresolved mismatches

**details**: Evidence: cycle reserves new orders before reconciliation and only compares known order status/fills plus unknown qs- open orders. It does not reconcile position/cash movements or external activity; reconciliation rows are informational and evaluateProposal/requireCurrentRisk never consult them. Add durable account reconciliation state, baseline/activities/cursors and explicit resolution; run startup reconciliation before new submissions and repeat periodically independently of pending proposals. Include external orders/fills, cash/position discrepancies and corporate-action-triggered review. Acceptance: external activity, missing/lagging fill and credential/account mismatch block new risk passes/submissions until a recorded reconciliation resolves them; restart preserves the block; clean account recovers without per-order approval.

push when finished

**area**: src/executor.ts spacetimedb/src/schema.ts spacetimedb/src/records.ts spacetimedb/src/risk-gate.ts

**status**: claimed

**created_by**: codex-plan

**assignee**: codex-plan

**depends_on**: paper-executor-reconcile

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060162455839}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791062360654711}

## alpaca-live-read — Complete Phase 0 real paper-account and data-feed read

**details**: The read-only Alpaca adapter has only fixture/local verification. With operator-provided paper credentials and chosen feed, read account, positions, open orders, quotes and clock, then verify persisted snapshot linkage and entitlement behavior; do not submit an order.

push when finished

**area**: src/alpaca-paper-adapter.ts

**status**: open

**created_by**: codex-plan

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791057656635969}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## alpaca-trade-update-stream — P1 Phase 4: authenticated paper trade-update stream with polling recovery

**details**: Plan Phase 4 requires trade updates; current executor polls every 10 seconds and has no WebSocket consumer. Add the fixed paper stream, authenticated subscription, validated events, activity-ID fill deduplication, connection health, bounded reconnect and reconciliation after gaps. Polling remains a recovery path. Acceptance with recorded/mock events: partial fill followed by fill, duplicates, out-of-order updates, disconnect and reconnect converge to the same ledger; accepted never implies filled; unhealthy stream is exposed to operator-alerts.

push when finished

**area**: src/executor.ts src/alpaca-trade-stream.ts src/agents/execution.ts

**status**: open

**created_by**: codex-plan

**depends_on**: paper-executor-reconcile

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060163668697}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## deployment-provenance — P2 Phase 6: immutable code/model/policy deployment manifest for decision replay

**details**: Plan operating controls require versioned deployment records. Current rows retain policy IDs, model and prompt version but no immutable deployment manifest linking exact code/build/config to a run. Store a bounded manifest and artifact reference/hash for code revision (including a dirty build identifier), module schema/bindings version, SDK/CLI, model/prompt, strategy/risk versions and evidence-selection settings; link decisions/inference/order traces to it. Acceptance: two deployments cannot overwrite one manifest; replay can identify exact inputs and versions without embedding secrets or full traces in hot tables.

push when finished

**area**: spacetimedb/src/schema.ts scripts/swarm.ts docs/decisions/

**status**: open

**created_by**: codex-plan

**depends_on**: pilot-contract-config

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060175053307}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## deployment-service-identities — P2 Phase 6: deployment service identities, scoped secrets and supervised operation

**details**: Local supervisor and role/run/account grants are implemented; README explicitly defers production OIDC/service provisioning. Specify deployment target with owner, provision distinct service identities/tokens per worker and least-privilege secret delivery, graceful shutdown/health supervision and token rotation/revocation. Keep localhost prototype usable and Alpaca fixed to paper; do not provision external infrastructure during implementation without owner deployment choice. Acceptance in a local/staging fixture: revoked/rotated identity loses access, research workers never receive broker secrets, restart keeps intended identity, service outage blocks submissions and recovers with reconciliation.

push when finished

**area**: src/tokens.ts scripts/swarm.ts docs/deployment.md

**status**: open

**created_by**: codex-plan

**depends_on**: pilot-contract-config

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060173414061}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## desktop-adapter-service — Game: per-desktop adapter service reachable only by its assigned worker

**details**: PRIORITY: medium-high (needed before an orchestrator on the host can drive agents inside separate VMs).

CONTEXT: The plan's Desktop adapter contract describes a small service inside each desktop exposing only capture, click/drag/scroll, key, move_mouse, wait and health. Today the agent and helper run in the same session and talk over a local pipe.

SCOPE:
1. A service process inside each desktop/guest exposing exactly those operations over HTTP or WebSocket, bound to the guest's private interface, authenticated with a per-desktop secret provisioned at clone time (not baked into the template), and accepting one worker connection at a time.
2. The worker uses a remote desktop client implementing the same interface as the local backend, so the agent loop is unchanged.
3. Every response includes a desktop identity (guest name + boot ID) and capture provenance; the worker fails closed on identity mismatch or missing screenshot (plan 'Fail closed on desktop identity mismatch').
4. Disconnect or timeout releases all held input on the desktop side.
5. health is supervisor-only and never fed to the model.

OUT OF SCOPE: shell access, file transfer, anything beyond the contract.

ACCEPTANCE: from the host Mac, a worker drives the agent in one guest through the service; a second worker with the wrong secret is refused; dropping the connection mid-hold releases the key.

Reference: GAME_AGENT_IMPLEMENTATION_PLAN.md (phases, adapter contract, schema, recovery), src/game/README.md, vm_fleet/README.md. Ground rule for every game task: agents observe only their own screenshots and act only through validated mouse/keyboard input; no server APIs, world files, memory reads or admin commands ever reach an agent.

push when finished

**area**: src/game/

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: linux-desktop-adapter

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058912803278}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## dev-dashboard-runtime-acceptance — Verify development board messages, task claims, dependencies and recovery in real Chrome

**details**: The development dashboard has verified live reads but its message composer and task-action controls lack reproducible browser coverage. Add an isolated quant-swarm-coord browser fixture using the same dashboard server: sending/routing safe text, competing task claims, dependency refusals, owner complete/block/release, live locks, reload/reconnect, no mutation of the shared board. Reuse the trading-browser harness infrastructure where appropriate. Include a clear startup command and observed results. push when finished

**area**: scripts/check-dev-dashboard.ts scripts/dashboard-test-env.ts docs/dev-dashboard-acceptance.md

**status**: claimed

**created_by**: repo_reader

**assignee**: repo_reader

**depends_on**: dev-dashboard

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791064473376846}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064476235147}

## executor-durable-attempts — P0: persist submission uncertainty and bound retries across executor restarts

**details**: Evidence: submits attempts/lastAt and cancelRequested are process-local; settle only applies the absence grace when bookkeeping exists. Restart loses retry counts/grace; after three ambiguous submissions and absent lookups it records rejected without durable proof of nonacceptance. Persist attempt IDs/times/classification and broker request IDs where supplied; preserve client order ID; keep uncertain exposure until reconciliation proves resolution. Make cancel retries recover from network failures rather than remembering a failed request forever. Acceptance: crash after POST or lost response preserves uncertainty/backoff/attempt bound; delayed broker visibility never causes premature rejection or exposure release; transient cancel failure retries safely.

push when finished

**area**: src/executor.ts spacetimedb/src/schema.ts spacetimedb/src/records.ts src/alpaca-orders.ts

**status**: open

**created_by**: codex-plan

**depends_on**: executor-submit-revalidation

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060161225666}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## executor-failure-drills — Phase 4 exit: paper execution failure drills (timeout, partial fill, external activity, restart)

**details**: PRIORITY: high (Phase 4 exit check in IMPLEMENTATION_PLAN.md section 6).

NEEDS: Alpaca paper keys; market hours for fills.

CONTEXT: paper-executor-reconcile (quant-swarm-3d) builds submission and reconciliation. This task proves it under failure, separately from building it.

SCOPE: script scripts/check-execution.ts plus a fault-injection hook in the executor (env-gated, e.g., EXECUTOR_FAULT=timeout_after_submit, test only, disabled by default) to run:
1. Happy path: one risk-passed limit buy of 1 share reaches 'filled' or 'accepted' and is reconciled against Alpaca by client_order_id.
2. Uncertain submission: the HTTP response is dropped after Alpaca accepted the order; the executor must look up by client_order_id and must not submit a second order. Assert exactly one Alpaca order exists for that client_order_id.
3. Partial fill: a limit order sized to fill partially (or simulated via order updates); fills are recorded once per activity ID and the cumulative quantity never exceeds the order.
4. External activity: an order placed manually in the Alpaca paper dashboard (owner does this) is detected by reconciliation and recorded as external, and blocks trading for that symbol until acknowledged, per AGENTS.md.
5. Restart: kill the executor between reservation and submission, and between submission and fill; on restart it reconciles and reaches a consistent state.
6. Cancel: an operator cancel request for an open order reaches canceled at Alpaca and in the ledger.

ACCEPTANCE: every scenario asserts both the ledger and Alpaca's state; a summary with order IDs goes into HANDOFF.md. Never infer a fill from an accepted request.

push when finished

**area**: scripts/check-execution.ts HANDOFF.md

**status**: claimed

**created_by**: quant-swarm-84

**assignee**: codex-plan

**depends_on**: paper-executor-reconcile

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058582937124}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791062626408399}

## executor-submit-revalidation — P0: revalidate reserved paper intents immediately before broker submission

**details**: Evidence: reservePaperOrder checks current risk once, but cycle calls settle on broker-ID-less orders before pause handling; submit makes POST without renewed run/access/account/quote/clock validation. Lookup and uncertain recovery must remain possible while paused, but a new POST must fail closed after pause, revoked grants, stale/changed inputs or a connection change. Add an authoritative pre-submit transition; distinguish never-submitted from uncertain attempts. Acceptance with mock broker: pause/expiry/input change between reserve and submit yields zero POSTs; reconnect cannot submit using an old cache; lookup of an already accepted uncertain order still records it. No per-order human approval.

push when finished

**area**: src/executor.ts spacetimedb/src/records.ts spacetimedb/src/risk-gate.ts

**status**: claimed

**created_by**: codex-plan

**assignee**: codex-plan

**depends_on**: paper-executor-reconcile

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060159900885}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060996198945}

## fa-command-mod — Factorio F1: bounded structured observations and commands for ten independent avatars

**details**: Implement a Factorio 2.x Lua mod with per-agent characters, local radius observations, inventory/health, bounded move/mine/craft/build/transfer commands and stable request IDs. No model-authored Lua or raw RCON exposed to model; server bridge alone holds password. Persist command results to avoid duplicate mutation after worker crash. Exit: a deterministic agent mines resources/crafts/builds from valid inputs; invalid/distant/forged/replayed commands handled.

push when finished

**area**: factorio/mod/ games/src/factorio.ts

**status**: cancelled

**created_by**: codex-plan

**depends_on**: fa-server

**result**: Owner cancelled Factorio work; friend owns Factorio. Minecraft and paper trading continue under their existing tasks and minecraft-trading-readiness. push when finished

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060461203055}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064615015651}

## fa-dashboard — Factorio: operator view and run pause/stop for headless agents

**details**: Read scoped positions/inventory/actions/incidents/messages/citations; pause/stop via reducers, no RCON/password in browser. Browser acceptance checks grants, live updates, revocation, reconnect and pause stopping commands.

push when finished

**area**: games/dashboard/

**status**: cancelled

**created_by**: codex-plan

**depends_on**: fa-sharing-tools

**result**: Owner cancelled Factorio work; friend owns Factorio. Minecraft and paper trading continue under their existing tasks and minecraft-trading-readiness. push when finished

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060469262251}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064616576264}

## fa-launcher-ten — Factorio F3: launch ten headless workers with shared goal and no coordinator

**details**: Launch ten independent processes, distinct persistent tokens, shared budgets/global inference cap, clean stop and bounded restart. Operator chooses seed/goal/limits. Exit: ten agents act concurrently for 30 minutes; no code execution from models, communication only via SpacetimeDB; all actions attributable.

push when finished

**area**: games/scripts/ config/factorio-pilot.json

**status**: cancelled

**created_by**: codex-plan

**depends_on**: fa-sharing-tools

**result**: Owner cancelled Factorio work; friend owns Factorio. Minecraft and paper trading continue under their existing tasks and minecraft-trading-readiness. push when finished

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060464990504}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064618243170}

## fa-reliability — Factorio F4: crash, uncertain-action, RCON loss and world restore drills

**details**: Drills preserve worker identities, command deduplication and SpacetimeDB audit after model failure/worker kill/server restart/database loss. Verify uncertain commands queried rather than repeated. Unaffected agents continue; out-of-sync worlds block actions until recovery recorded.

push when finished

**area**: games/scripts/ factorio/

**status**: cancelled

**created_by**: codex-plan

**depends_on**: fa-launcher-ten

**result**: Owner cancelled Factorio work; friend owns Factorio. Minecraft and paper trading continue under their existing tasks and minecraft-trading-readiness. push when finished

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060466328097}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064620133243}

## fa-server — Factorio F0: pinned localhost headless server, deterministic save and RCON health check

**details**: Prepare a pinned official headless runtime with localhost-only game/RCON ports, private generated password, fixed seed, no public listing, start/stop/save/restore commands. Linux Docker path supported on Mac. No model gameplay until readiness succeeds. Exit: server boots a saved world and authenticated RCON answers; stop saves cleanly.

push when finished

**area**: factorio/ games/

**status**: cancelled

**created_by**: codex-plan

**result**: Owner cancelled Factorio work; friend owns Factorio. Minecraft and paper trading continue under their existing tasks and minecraft-trading-readiness. push when finished

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060460031219}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064622095346}

## fa-sharing-experiment — Factorio F5: matched-seed sharing experiment and replayable report

**details**: Run no-sharing, messages-only, messages-plus-knowledge with equal seed/goal/model/budget. Measure milestones, redundant mining/building, use/validity/age of shared evidence, command failures, cost and tick performance. Do not feed global evaluator state to agents.

push when finished

**area**: games/scripts/

**status**: cancelled

**created_by**: codex-plan

**depends_on**: fa-launcher-ten

**result**: Owner cancelled Factorio work; friend owns Factorio. Minecraft and paper trading continue under their existing tasks and minecraft-trading-readiness. push when finished

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060467524029}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064623668982}

## fa-sharing-tools — Factorio F2: SpacetimeDB state, messages, knowledge and evidence citations

**details**: All agent communication goes through private run-scoped SpacetimeDB tables/views/reducers. Authors authenticated, payloads bounded, knowledge confirmations require local observation. Record action inputs/results and message/knowledge citations. Exit: two workers share and act on resource evidence, reconnect retains identity, forged author/cross-run read rejected.

push when finished

**area**: games/module/ games/src/

**status**: cancelled

**created_by**: codex-plan

**depends_on**: fa-worker-core

**result**: Owner cancelled Factorio work; friend owns Factorio. Minecraft and paper trading continue under their existing tasks and minecraft-trading-readiness. push when finished

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060463681042}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064625419752}

## fa-worker-core — Factorio F1: long-lived model agent with structured actions, spend bounds and recovery

**details**: Independent workers use fixed command schema, local observation, configurable model and bounded steps/budgets; deterministic brain for checks. Stable identity/step IDs; no coordinator; cancellation and uncertain actions reconcile on restart. Exit: one worker completes a resource/crafting goal; trace links observation, inference, action and outcome.

push when finished

**area**: games/src/

**status**: cancelled

**created_by**: codex-plan

**depends_on**: fa-command-mod

**result**: Owner cancelled Factorio work; friend owns Factorio. Minecraft and paper trading continue under their existing tasks and minecraft-trading-readiness. push when finished

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060462410595}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064627000297}

## game-cooperative-experiment — Game Phase 6: cooperative task vs uncoordinated baseline with audit reconstruction

**details**: PRIORITY: later (Phase 6).

SCOPE:
1. Define with the owner a goal that requires different roles and exchanged information (e.g., Factorio modest production chain), success milestones judged from screen recordings or post-run server inspection (never fed back to agents during the run).
2. Run the coordinated swarm and an uncoordinated baseline (same agents, no messages or task claims) on the same scenario/seed and budget.
3. scripts/game-report.ts reconstructs from SpacetimeDB and artifacts who observed, claimed, messaged, acted and achieved each milestone; reports completion, time to first milestone, duplicate work, conflicting actions, message usefulness, operator interventions, errors and cost.
4. Keep strict-screen-only and swarm-communication results separate.

ACCEPTANCE: report produced for both conditions with the audit trail for every milestone.

push when finished

**area**: scripts/game-report.ts HANDOFF.md

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: game-scale-to-ten

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058913698227}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-dashboard-grid — Game dashboard: live grid of client screens with last action, message and error per agent

**details**: PRIORITY: medium (plan: live grid of ten screens; operator inspects each agent's last screenshot, action, message and error).

SCOPE:
1. A game view in the dashboard (reuse the operator-dashboard app if it exists; otherwise a minimal local page) subscribing via scoped views to game_client, game_action, game_observation, game_incident and messages for one run.
2. Grid of the latest screenshot per agent (served from the local artifact store by hash, localhost only), with role, current task, last action and validation result, last message, last error, budget used, connection state.
3. Controls wired to the orchestrator: pause/resume per agent and all, hard stop.
4. Operator interventions logged as game_incident with kind operator_intervention.

ACCEPTANCE: with two agents running, the grid updates within a few seconds of each action; pause from the grid pauses only that agent.

push when finished

**area**: dashboard/

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: game-worker-integration

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058913365846}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-dedicated-server — Game server: scripted dedicated server (Factorio headless first) with save, backup and health

**details**: PRIORITY: high for Phase 0 exit (one human client joins the dedicated server).

CONTEXT: Nothing in the repo starts or manages a game server. The plan says the server hosts the shared world, the operator may administer it, and its state is never exposed to agents.

SCOPE (Factorio headless first; Minecraft dedicated server only if the owner picks it):
1. game-server/ scripts to: download or verify the pinned server version (checksum), create a world from the chosen scenario/map-gen settings with a fixed seed, start the headless server bound to a configurable LAN interface and port, stop it gracefully with a save, and rotate timestamped save backups.
2. Server settings file generated from config/game-pilot.json: player limit, password (from an env var name, never committed), no public listing, autosave interval, pause-when-empty off, admin list containing only the operator.
3. Health check command: process alive, port listening, last autosave time. Logs to logs/game-server.log.
4. Restore: start from a chosen backup save (used later by game-reliability-drills).
5. Document how a human connects from the host Mac and from a VM guest (address, direct connect).

OUT OF SCOPE: anything that feeds server state to agents; evaluation tooling (game-cooperative-experiment may read server state after a run, never during).

ACCEPTANCE: Phase 0 exit check: one human-operated client joins the dedicated server, moves, and the server save reflects it after a graceful stop; a backup restores and the client rejoins. Record versions and steps in HANDOFF.md.

Reference: GAME_AGENT_IMPLEMENTATION_PLAN.md (phases, adapter contract, schema, recovery), src/game/README.md, vm_fleet/README.md. Ground rule for every game task: agents observe only their own screenshots and act only through validated mouse/keyboard input; no server APIs, world files, memory reads or admin commands ever reach an agent.

push when finished

**area**: game-server/ README.md

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: game-scenario-decisions

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058912130398}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-one-agent-live-check — Game Phase 1 exit: live one-agent run on the Mac (Factorio, then Minecraft camera check)

**details**: PRIORITY: high (the macOS prototype builds and passes action-schema tests but has never controlled a live game).

NEEDS OWNER: game installed and licensed on the Mac, macOS Screen Recording and Accessibility permissions for the terminal, ANTHROPIC_API_KEY.

SCOPE:
1. Factorio, single-player safe save: run GAME_GOAL='Open the inventory, then close it' with GAME_MAX_STEPS=3, then the plan's first task (mine visible ore, place and fuel a furnace, verify output on screen) with a higher step budget. Record each run's .game-runs/<id>/ trace summary (steps, invalid actions, tokens, wall time, operator-verified outcome).
2. Input-release checks on the real OS (dry-run EOF release is already tested): (a) Ctrl+C mid-hold releases the key; (b) kill -9 of the agent process mid-hold; (c) kill -9 of the Swift helper mid-hold. After each, verify in the game and with a key-state check that nothing is held.
3. Focus safety: switch focus away mid-run; input must stop. Resize the window; input must stop.
4. Coordinate accuracy: click a known UI element at 3 positions after resizing the window; record expected vs actual.
5. Minecraft (if available): verify relative 'look' camera response and cursor capture; record degrees per unit, and fix the scale if needed.
6. Fix defects found (in src/game/ with board coordination) and add regression tests where possible.

ACCEPTANCE: the plan's Phase 1 exit: agent completes a simple visible task using only screenshots and input, and all held keys release on stop. Results in HANDOFF.md, and IMPLEMENTATION_REVIEW.md game section updated.

Reference: GAME_AGENT_IMPLEMENTATION_PLAN.md (phases, adapter contract, schema, recovery), src/game/README.md, vm_fleet/README.md. Ground rule for every game task: agents observe only their own screenshots and act only through validated mouse/keyboard input; no server APIs, world files, memory reads or admin commands ever reach an agent.

push when finished

**area**: src/game/ .game-runs/ HANDOFF.md

**status**: cancelled

**created_by**: quant-swarm-84

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058912248360}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-orchestrator — Game: orchestrator that binds N workers to N desktops with quotas, staggering and hard stop

**details**: PRIORITY: medium (Phase 2-5).

SCOPE:
1. Reads the fleet's status (tart_fleet.py/fleet.py JSON output; add a --json flag if missing) and config/game-pilot.json; assigns exactly one worker per desktop and per player identity for the run, and records the binding in game_client.
2. Starts each worker as its own process with its own model conversation and SpacetimeDB identity; no global step barrier; staggers initial calls; enforces a configurable global semaphore on concurrent model requests without serializing desktop actions.
3. Controls: pause/resume one agent or all; hard stop that releases all held input on every desktop; per-agent time, step and spend budgets; restart a crashed worker against the same desktop.
4. Never merges screens across agents; never gives a worker another desktop's address or secret.

ACCEPTANCE: with two desktops, both agents act in overlapping wall-clock intervals; pausing one does not pause the other; hard stop releases input on both (Phase 2 exit, together with game-two-agent-isolation).

Reference: GAME_AGENT_IMPLEMENTATION_PLAN.md (phases, adapter contract, schema, recovery), src/game/README.md, vm_fleet/README.md. Ground rule for every game task: agents observe only their own screenshots and act only through validated mouse/keyboard input; no server APIs, world files, memory reads or admin commands ever reach an agent.

push when finished

**area**: src/game/orchestrator.ts

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: desktop-adapter-service

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058913140705}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-reliability-drills — Game Phase 4: reconnect, crash, stuck detection, timeouts and server save/restore drills

**details**: PRIORITY: medium (Phase 4 exit).

SCOPE (implement missing behavior, then drill each):
1. Model timeout: stop the current action, release held input, keep the client, retry with a fresh screenshot after bounded backoff.
2. Worker crash: kill one worker; its task lease is released; the restarted worker reorients from a fresh screenshot; unaffected agents continue.
3. Client/desktop crash: kill one game client; mark the agent unavailable; restart the client, rejoin with the same player identity, and resume.
4. Stuck detection: N consecutive steps with near-identical screenshots (perceptual hash) and no task progress raise a game_incident and trigger a recovery prompt or pause.
5. Server failure: stop all input, restore the server from its last save (game-dedicated-server restore), resume only after each client has visibly rejoined, and discard stale planned actions.
6. SpacetimeDB disconnect: behavior from game-worker-integration, drilled.

ACCEPTANCE: each drill run at least once with two agents and recorded (what was killed, recovery time, whether the other agent continued) in HANDOFF.md.

push when finished

**area**: src/game/ game-server/ HANDOFF.md

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: game-two-agent-isolation

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058913475012}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-scale-to-ten — Game Phase 5: scale 1 to 2 to 5 to 10 clients with measured host and API headroom

**details**: PRIORITY: later (Phase 5). NEEDS OWNER: hosts and licenses for ten clients, API rate limits sufficient for about 60+ requests/minute.

SCOPE:
1. Benchmark at 1, 2, 5 and 10 clients: per-agent screenshot-to-action latency, actions/minute, invalid actions, stuck time, client FPS, server tick health, host CPU/RAM/GPU, disconnects, model requests/tokens/images, cost.
2. Tune display resolution, screenshot cadence, global model concurrency, host distribution and server settings between steps; record each change.
3. Check project/model rate limits before the 10-client step; back off on rate limits per agent.

ACCEPTANCE: ten clients stay connected and ten independent loops run for a sustained test (duration agreed with the owner, e.g., 30 minutes) without cross-control; host and API load stay within configured limits; measurements table in HANDOFF.md.

push when finished

**area**: HANDOFF.md config/game-pilot.json

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: game-reliability-drills

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058913583812}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-scenario-decisions — Game Phase 0: lock game, scenario, server, accounts/licensing, host plan, info mode and budget

**details**: PRIORITY: blocks all multi-client game work. NEEDS OWNER DECISIONS.

CONTEXT: GAME_AGENT_IMPLEMENTATION_PLAN.md 'Decisions to lock before implementation' lists five open decisions. Factorio is the recommended first pilot (top-down, screen-coordinate building). Minecraft Java requires a distinct entitled Microsoft account per simultaneous player on an authenticated server; Factorio can use distinct player names on a private LAN/direct-connect server without account verification.

SCOPE:
1. Prepare a one-page proposal on the board for the owner covering: game (Factorio recommended) and exact client/server version; scenario/save and the first one-agent, two-agent and ten-agent tasks (plan 'Suggested first tasks'); information mode (strict screen-only vs swarm communication; recommend swarm communication, since this project tests the communication system); player identities and licensing (how many game licenses are needed, server auth mode); client host plan (host Mac directly, Tart macOS guests, Tart Linux guests, or remote libvirt), to be confirmed after the one-client graphics test; model, screenshot cadence, max action duration, per-agent and per-run spend ceilings.
2. After the owner answers, record the decisions in GAME_PILOT.md and a machine-readable config/game-pilot.json (versioned) that later tasks read (server version, player names, info mode, budgets, cadence).

ACCEPTANCE: owner confirmation quoted in the task result; config validated by a schema; no credentials or account passwords in the repo.

Reference: GAME_AGENT_IMPLEMENTATION_PLAN.md (phases, adapter contract, schema, recovery), src/game/README.md, vm_fleet/README.md. Ground rule for every game task: agents observe only their own screenshots and act only through validated mouse/keyboard input; no server APIs, world files, memory reads or admin commands ever reach an agent.

push when finished

**area**: GAME_PILOT.md config/game-pilot.json

**status**: cancelled

**created_by**: quant-swarm-84

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058912013944}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-spacetimedb-schema — Game: SpacetimeDB tables, reducers and scoped views for game runs, actions and observations

**details**: PRIORITY: medium-high (Phase 3 swarm coordination; today the game agent writes only local traces).

CONTEXT: Plan 'SpacetimeDB extension' table: game_run, game_client, game_task, game_message, game_action, game_observation, game_incident. Reuse run/agent/task/message concepts where possible. Screenshots stay in an artifact store; the database keeps references and hashes.

SCOPE:
1. Decide (and post on the board) whether game tasks/messages reuse the existing task and message tables (with a game kind) or get separate tables; prefer reuse plus game-specific tables only for action/observation/client/incident.
2. Tables (private, scoped views per worker; supervisor/dashboard role reads all for its run): game_run (game, server ID, scenario/version, info mode, model/prompt version, status, limits), game_client (agent identity, desktop ID, connection state, last screenshot time, health), game_action (agent, sequence ID, requested actions JSON, validation result, start/end, before/after observation IDs), game_observation (agent, capture time, image SHA-256, artifact ref, dimensions, optional agent-authored summary), game_incident (kind enum, agent, details, recovery).
3. Reducers validate ownership (a worker writes only its own actions/observations), payload size, run status and idempotency IDs. A worker cannot record another worker's observation.
4. Information-mode enforcement: in strict screen-only mode, messages are archived but never delivered to worker views.
5. Artifact store for screenshots: content-addressed files under ~/.local/share/quant-swarm/artifacts/game/ (local), referenced by hash.
6. Additive migration only; coordinate spacetimedb/src/ changes on the board.

ACCEPTANCE: reducer tests: duplicate action IDs are idempotent; cross-worker writes rejected; strict mode hides messages from workers; bindings regenerated.

push when finished

**area**: spacetimedb/src/ src/module_bindings/

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: game-scenario-decisions

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058912914819}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-spend-budget — Game agent: per-agent and per-run currency spend ceilings with image-token accounting

**details**: PRIORITY: medium (required before any unattended or multi-agent run).

CONTEXT: src/game/README.md: the run has step and token limits (GAME_MAX_TOKENS, preflight input count plus max output) but no dollar spend ceiling. Ten agents at one request every 10 s is about 60 requests/minute before retries (plan capacity section).

SCOPE:
1. Versioned price table in config (model -> input/output/image token prices) with a date and source note; refuse to run with an unknown model.
2. Per-request cost estimate before sending (preflight tokens including images) and actual cost after (usage), recorded in trace.jsonl and summarized in run.json.
3. Limits: per-agent ceiling (GAME_MAX_COST_USD) and, once the orchestrator exists, a shared per-run ceiling enforced by a reservation the agent takes before each call (reuse the trading module's inference reservation pattern if game state moves into SpacetimeDB).
4. Backoff on rate-limit responses with jitter; never retry all agents at once.

ACCEPTANCE: unit tests for the estimator; a run with a tiny ceiling stops before the call that would exceed it and records why.

push when finished

**area**: src/game/agent.ts config/

**status**: cancelled

**created_by**: quant-swarm-84

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058912354229}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-two-agent-isolation — Game Phase 2 exit: two concurrent agents in one world with no input leakage

**details**: PRIORITY: medium (the plan's first engineering milestone: two concurrent agents with separate desktops and auditable, screen-only actions).

DEPENDS ON: game-dedicated-server and a working client host (tart-macos-guest-check or linux-desktop-adapter in addition to the orchestrator).

SCOPE: two desktops, two clients connected to the dedicated server as distinct players, two workers with distinct roles (e.g., Factorio: one mines iron, one builds a small smelting line and requests materials). Run the plan's targeted tests: focus/input isolation (actions on desktop A never appear on B); screenshot from the wrong desktop is rejected; coordinates remain correct after a resize; out-of-order model responses do not apply to the wrong agent; pausing one agent leaves the other running; one agent blocking (long model call) does not stall the other.

ACCEPTANCE: script or documented procedure with recorded results per test; both agents act during overlapping intervals; traces show per-agent before/after screenshots.

push when finished

**area**: HANDOFF.md scripts/check-game-two.ts

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: game-orchestrator

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058913253547}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## game-worker-integration — Game: agent publishes actions/observations, claims game tasks and exchanges messages via SpacetimeDB

**details**: PRIORITY: medium-high (Phase 3).

SCOPE:
1. Give the game agent a SpacetimeDB identity and token (same pattern as src/worker.ts), run access, and a game worker role.
2. Per step: upload before/after screenshots to the artifact store, record game_observation and game_action rows with validation results and timing.
3. Tasks: claim game tasks with leases and renew while working; release on stop, pause or budget exhaustion.
4. Messages (swarm communication mode only): include permitted teammate messages in the prompt as reported claims, labeled untrusted; allow the model to emit a bounded message (kind: request, offer, observation, commitment, result). Never include server-derived facts.
5. Treat in-game chat/sign text as untrusted observations (prompt-injection guard in the system prompt and in how they are quoted).
6. On SpacetimeDB disconnect: freeze new claims/messages, buffer a bounded local trace, reconnect with the same identity, reconcile by operation ID, then resume.

ACCEPTANCE: Phase 3 exit with two agents: exactly one worker claims a contested task; a message is delivered only under the chosen information policy; every action has before/after image references whose hashes verify against stored files.

Reference: GAME_AGENT_IMPLEMENTATION_PLAN.md (phases, adapter contract, schema, recovery), src/game/README.md, vm_fleet/README.md. Ground rule for every game task: agents observe only their own screenshots and act only through validated mouse/keyboard input; no server APIs, world files, memory reads or admin commands ever reach an agent.

push when finished

**area**: src/game/

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: game-spacetimedb-schema

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058913022104}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## legacy-approval-removal — Remove the legacy operator-approval table, reducer, view and 'approved' status

**details**: PRIORITY: medium (owner decision: no human approval in the trade path, documented in 4eb5056).

CONTEXT: reservePaperOrder (spacetimedb/src/records.ts) already ignores approvals, but the module still has the approval table, approveProposal reducer, myApproval view, and accepts proposal status 'approved' as legacy. Keeping dead authorization paths invites someone to wire them back in.

SCOPE:
1. Confirm the local database has zero approval rows and zero proposals in status 'approved' (spacetime sql as owner); record counts in the task result.
2. Remove approveProposal, the approval table, the myApproval view, and the 'approved' branch in reservePaperOrder and any risk/exposure code that treats 'approved' as in-flight. If proposals in 'approved' exist, migrate them to 'risk_passed' only if their risk decision is still current; otherwise to 'rejected' with a note.
3. Regenerate bindings; remove any client references (grep for approveProposal, myApproval, 'approved').
4. Table removal is a breaking migration. Coordinate on the board, announce the publish, and use the CLI's migration prompt; do not clear unrelated data.
5. Update README reducer inventory and AGENTS.md 'Current backend implementation' (which lists operator approvals).

ACCEPTANCE:
- grep finds no approval reducer/table/view references outside history docs.
- check:phase-one and npm test pass; reservePaperOrder regression still reserves a fresh risk_passed proposal.

push when finished

**area**: spacetimedb/src/ src/module_bindings/ README.md

**status**: open

**created_by**: quant-swarm-84

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058582660753}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## linux-desktop-adapter — Game: Linux X11 screenshot/input adapter with the same contract and held-input watchdog

**details**: PRIORITY: medium (required for Linux guests on Tart or libvirt; the current agent throws unless process.platform is darwin).

CONTEXT: src/game/agent.ts line ~46 requires macOS; capture and input use the Swift helper src/game/macos-desktop.swift. The plan prefers one Linux VM or graphical session per client.

SCOPE:
1. Define a platform interface in src/game/desktop.ts that both backends implement: window(find by game), capture (PNG + width/height/timestamp of the game window only), click/drag/scroll with bounds checks, key press/release, relative mouse move (Minecraft), wait, health. Keep normalized 0-1000 coordinates and the same action limits (4 actions, 600 ms per hold, 2 s total).
2. Linux X11 backend: find the game window by title/class (xdotool or Xlib), verify focus and geometry before every action, capture via XGetImage/xwd or ffmpeg x11grab, inject input via XTest (xdotool) or uinput. Note Wayland is out of scope; document that the guest must run an X11 session.
3. Independent held-input watchdog process: releases any held keys/buttons if the adapter or agent dies (mirror the macOS child watcher).
4. Select backend by platform; keep the macOS path unchanged.

ACCEPTANCE: unit tests for the interface and bounds; in a Linux guest with the game, the inventory goal completes and kill -9 mid-hold leaves no held key.

Reference: GAME_AGENT_IMPLEMENTATION_PLAN.md (phases, adapter contract, schema, recovery), src/game/README.md, vm_fleet/README.md. Ground rule for every game task: agents observe only their own screenshots and act only through validated mouse/keyboard input; no server APIs, world files, memory reads or admin commands ever reach an agent.

push when finished

**area**: src/game/

**status**: cancelled

**created_by**: quant-swarm-84

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058912692764}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## live-model-research-acceptance — Phase 2 exit: live Claude analyst/skeptic/coordinator cycle on real SEC evidence

**details**: PRIORITY: high (Phase 2 exit check; IMPLEMENTATION_REVIEW.md says Claude inference has not passed).

NEEDS: ANTHROPIC_API_KEY (owner provides; never stored in the repo or database). Small budget: set run limits before starting.

SCOPE:
1. Script scripts/check-phase-two.ts that: creates a fresh run, grants run access, ingests SEC filings for 2 symbols (AAPL, MSFT), records a current quote snapshot if Alpaca keys are present (otherwise records that quotes were unavailable), starts coordinator, analyst and skeptic workers with AGENT_BRAIN=claude, creates one thesis task per symbol, waits for decisions, then verifies the trace.
2. Trace verification per symbol: thesis cites only evidence that existed before the thesis timestamp (as_of <= createdAt); the skeptic's challenge cites the thesis; the decision has frozen decision inputs (decision_input rows) referencing the exact quote, critique, model and prompt versions; inference attempts are recorded with token usage within the run budget.
3. Report: for each symbol, outcome (trade/abstain/revise), rationale, and whether the evidence supports it, written into the task result and HANDOFF.md.
4. If a trade decision is produced, the proposal must stay at 'proposed' (no risk worker running in this check).

ACCEPTANCE:
- The script exits 0 and prints the verified trace. A rerun with the same run ID does not duplicate inference (replay from stored responses).
- Total tokens stay within the configured budget; the run is closed and temporary grants revoked at the end.

push when finished

**area**: scripts/check-phase-two.ts HANDOFF.md IMPLEMENTATION_REVIEW.md

**status**: open

**created_by**: quant-swarm-84

**depends_on**: analyst-evidence-selection

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058582536560}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## mc-launcher-ten — Minecraft M3: launcher plus ten concurrent agents on one goal with no orchestrator

**details**: PRIORITY: high (Phase M3).

SCOPE:
1. scripts/mc-swarm.ts: starts N agent processes from config (names, model, budgets), each with its own token file; prints the grant_agent/grant_run_access commands (or applies them with --apply as the owner CLI identity); restarts crashed agents with backoff; stops all on Ctrl+C. It assigns no roles, tasks or goals per agent: every agent gets the same run goal.
2. Global concurrent model-request cap (shared semaphore, e.g., a small local token bucket file or SpacetimeDB reservation), per-agent and per-run spend ceilings; when the run budget is exhausted all agents stop cleanly and the run is marked.
3. Stagger agent start times to avoid synchronized model calls.
4. Per-agent logs to logs/mc-<name>.log.

ACCEPTANCE: ten agents act concurrently for 30 minutes on one goal with no coordinator; killing one agent restarts it with the same identity and it continues; total spend stays within the run ceiling; every message and knowledge entry is attributable to an agent.

Plan: GAME_AGENT_IMPLEMENTATION_PLAN.md (owner decisions 2026-10-03). Ground rules: ten independent agents, no orchestrator or coordinator role, no assigned roles; privileged but LOCAL Mineflayer state (default 16-block radius); fixed validated command set; the model never writes or runs code; no in-game chat; SpacetimeDB is the only agent-to-agent channel; server private (localhost, whitelist, offline mode).

push when finished

**area**: scripts/mc-swarm.ts package.json README.md

**status**: claimed

**created_by**: quant-swarm-84

**assignee**: codex-plan

**depends_on**: mc-sharing-tools

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791059443698305}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791063118086305}

## mc-open-decisions — Minecraft: get owner answers on the plan's open decisions

**details**: PRIORITY: high (unblocks M0-M3 configuration). NEEDS OWNER.

Ask the owner on the board, with a recommendation for each, and record answers in config/minecraft-pilot.json (versioned, schema-validated) and the plan's 'Decisions still open' section:
1. Server version and seed: recommend the newest version Mineflayer and mineflayer-pathfinder both support (check their READMEs at the time; Mindcraft recommends 1.21.6), fixed seed with trees, stone and surface iron near spawn.
2. Model and budgets: model ID, per-agent and per-run spend ceilings, step cadence (e.g., one decision every 5-10 s), global concurrent-request cap.
3. Observation radius (default 16 blocks).
4. First run goal (plan lists: stone tools each; shelter with ten beds; 20 iron ore as a group).
5. Mineflayer plus plugins directly (recommended) vs adapting Mindcraft's MIT skills with code mode off and chat replaced by SpacetimeDB.

ACCEPTANCE: owner answers quoted in the task result; config file committed without secrets.

Plan: GAME_AGENT_IMPLEMENTATION_PLAN.md (owner decisions 2026-10-03). Ground rules: ten independent agents, no orchestrator or coordinator role, no assigned roles; privileged but LOCAL Mineflayer state (default 16-block radius); fixed validated command set; the model never writes or runs code; no in-game chat; SpacetimeDB is the only agent-to-agent channel; server private (localhost, whitelist, offline mode).

push when finished

**area**: GAME_AGENT_IMPLEMENTATION_PLAN.md config/minecraft-pilot.json

**status**: open

**created_by**: quant-swarm-84

**result**: Server version and model decided; remaining decisions listed in the post and in the plan.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791059443167573}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## mc-reliability — Minecraft M5: death, disconnect, crash, server restart and SpacetimeDB disconnect drills

**details**: PRIORITY: medium (Phase M5).

SCOPE: implement missing recovery, then drill each with ten agents running:
1. Death: agent respawns, the death is recorded as a game_incident, and the next observation states it.
2. Bot disconnect or kick: reconnect with the same name and SpacetimeDB identity; no duplicate actions for the same step ID.
3. Agent process crash: launcher restarts it; it reads its last game_agent_state and continues.
4. Server restart from backup: all agents pause, reconnect after the server is up, and discard plans that referenced the old world state.
5. SpacetimeDB disconnect: agents keep playing, buffer, reconnect and reconcile.
6. Stuck detection: no position or inventory change for N steps raises an incident.

ACCEPTANCE: each drill run once and recorded in HANDOFF.md (what failed, recovery time, whether others continued).

push when finished

**area**: src/minecraft/ minecraft/ HANDOFF.md

**status**: open

**created_by**: quant-swarm-84

**depends_on**: mc-launcher-ten

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791059444016287}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## mc-sharing-experiment — Minecraft M4: information-sharing experiment across three modes with report

**details**: PRIORITY: medium (Phase M4; the point of the pilot).

SCOPE:
1. Run the same seed, goal, agents, model and budget under three information modes: none, messages, messages_and_knowledge. Restore the same world backup before each run; at least two repeats per mode if budget allows.
2. scripts/mc-report.ts computes from SpacetimeDB and traces: time to goal and milestones; redundant work (two agents collecting the same resource cluster or exploring the same area within a window); messages and knowledge entries posted; share of entries later cited by another agent; share confirmed/disputed; false or stale reports, checked after the run against recorded bot observations (never fed back during the run); cost per mode.
3. Report in Markdown with a per-mode table and three example information chains (report -> citation -> outcome).

ACCEPTANCE: report produced for all three modes; numbers spot-checked by SQL; limitations stated (sample size, model variance).

push when finished

**area**: scripts/mc-report.ts HANDOFF.md

**status**: open

**created_by**: quant-swarm-84

**depends_on**: mc-launcher-ten

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791059443903572}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## minecraft-trading-readiness — Minecraft and paper trading readiness and prerequisite checks

**details**: Replaces non-Factorio scope of cancelled three-swarm-readiness. Coordinate with codex-plan to preserve completed Minecraft and paper work. Exclude all Factorio implementation, setup and testing. Complete runnable Minecraft and paper commands with prerequisite gates. push when finished

**area**: games/ scripts/ docs/

**status**: open

**created_by**: focus-reset

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791064632373676}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064632373676}

## model-cost-accounting — P1 Phase 6: durable monetary inference usage and run spend ceilings

**details**: Evidence: AskOptions reports only aggregate tokens; inferenceAttempt stores aggregate usage and no input/output/cache breakdown, price version or USD. Retain provider usage categories and actual model; attach versioned operator-supplied prices and monetary reservations/ceilings. Distinguish estimates, actual charges and unknown usage after timeout; uncertainty must not free reserved spend. Acceptance with synthetic usage: cache/input/output charges compute reproducibly; concurrent agents cannot exceed shared reservation limits; restart/replay incurs no second logical charge; reports link totals to inference attempts. Coordinate with mc-agent-core/mc-launcher-ten budgets and run-metrics-benchmark; do not hardcode unverified current model prices.

push when finished

**area**: src/agents/llm.ts src/agents/accounted-ask.ts spacetimedb/src/controls.ts spacetimedb/src/schema.ts

**status**: open

**created_by**: codex-plan

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060169090120}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## monitor-repo-read — Read repository and continuously triage posted board issues

**details**: push when finished

**area**: HANDOFF.md

**status**: claimed

**created_by**: codex-monitor

**assignee**: codex-monitor

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791059057683120}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## operator-alerts — Phase 6: alerts for stale data, stuck orders, broken streams, rejects and mismatches

**details**: PRIORITY: medium.

CONTEXT: IMPLEMENTATION_PLAN.md Operating controls: alert the operator on stale market/account data, stuck orders, a broken trade-update stream, rejected orders, an exposure breach, or an unresolved account mismatch. Fail closed for new submissions when required inputs are unavailable.

SCOPE:
1. Alert rules evaluated by a small process (or inside metrics) with thresholds in config: latest account snapshot older than X; latest quote for an in-universe symbol older than Y during market hours; an order in submitting/accepted longer than Z without update; executor heartbeat or trade-update stream silent beyond W; any rejected order; any reconciliation discrepancy unresolved; risk exposure above policy.
2. Record alerts in a module table (private, scoped view) with severity, first seen, last seen, resolved at; deduplicate open alerts by rule and subject.
3. Show open alerts prominently in the dashboard; optional macOS notification via osascript for critical alerts (local only).
4. A critical data-staleness or mismatch alert pauses new risk passes for the affected account (coordinate the mechanism with the risk-gate owner; it may already be enforced by freshness checks, in which case alerting only).

ACCEPTANCE: each rule triggered by a forced condition in a test run, shown in the dashboard, and resolved when the condition clears.

push when finished

**area**: src/alerts.ts dashboard/

**status**: claimed

**created_by**: quant-swarm-84

**assignee**: codex-next

**depends_on**: operator-dashboard

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058583436390}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791062763999719}

## operator-order-cancel — P1: durable per-order cancellation requests from operator dashboard to executor

**details**: Evidence: dashboard cancel control is disabled; executor cancels only when a run is paused/closed. Add authenticated run/account-scoped cancel requests, stable IDs and auditable requested/accepted/refused/completed outcomes; expose controls for a selected open order. Handle retries, reconnect and fill-versus-cancel races; distinguish request acceptance from broker cancellation. Acceptance: unauthorized/cross-account requests rejected; duplicate request creates one logical cancellation; failed DELETE retries; fill race preserves fills and actual terminal broker status. Does not add human approval before submission.

push when finished

**area**: spacetimedb/src/records.ts spacetimedb/src/schema.ts src/executor.ts dashboard/app.ts

**status**: open

**created_by**: codex-plan

**depends_on**: paper-executor-reconcile

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060165036646}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## paper-end-to-end-acceptance — P1: demonstrate and audit the complete real paper-trading path

**details**: Prerequisites also include alpaca-live-read, live-model-research-acceptance, risk-live-acceptance, executor-submit-revalidation, account-reconciliation-interlock and dashboard-runtime-acceptance. With owner-configured narrow contract, paper credentials/feed and limits, run one real SEC-backed analyst/skeptic/coordinator decision through independent risk and fixed-paper submission to broker-confirmed order/fill/position reconciliation shown in dashboard. Preserve trace IDs, timestamps, policy/model versions and broker receipts; report no-trade when evidence/risk fails rather than forcing a trade. Acceptance: one actual paper order reaches a reconciled outcome, no duplicate after timeout/restart, complete evidence-to-position trace. Mock/reducer fixtures alone do not satisfy this exit.

push when finished

**area**: scripts/check-paper-pilot.ts HANDOFF.md IMPLEMENTATION_REVIEW.md

**status**: open

**created_by**: codex-plan

**depends_on**: executor-failure-drills

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060171979676}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## pilot-contract-config — Versioned pilot contract: universe, horizon, cadence, benchmark, feed and limits as run configuration

**details**: PRIORITY: high (plan section 8 lists these as open decisions; the first risk-passed order should not happen without them).

NEEDS OWNER INPUT before implementation. Post the proposed values on the board and get the owner's confirmation:
- Universe: config/risk-policy.json already allows AAPL, MSFT, NVDA, GOOGL, AMZN, SPY, QQQ (paper-pilot-1). Confirm or change.
- Strategy hypothesis and explicit no-trade criteria (e.g., abstain unless the skeptic passes and confidence >= 70).
- Holding horizon (e.g., 20-60 trading days) and maximum.
- Research cadence (e.g., daily after close plus on new filing) and maximum orders per day.
- Benchmark (e.g., SPY buy-and-hold over the same dates).
- Alpaca data feed (iex vs sip; depends on the account subscription).
- Model provider, model, and per-run budget (inferences/tokens; currency cost cap).
- Numeric limits already in policy: maxOrderNotional 1000, maxPositionNotional 2500; plus total exposure, daily loss and max open orders.

SCOPE once confirmed:
1. A versioned contract file config/pilot-contract.json (version string, all fields above) validated by a schema at load.
2. Extend run_config (or add run_contract) so a run pins the contract version and the risk policy ID at creation; reducers reject creating tasks/proposals for symbols outside the run's universe.
3. An operator command to create a run from a contract file in one step (create run, configure limits, pin policy).
4. README: how to start a pilot run from the contract.

ACCEPTANCE:
- Creating a run from the contract stores the version; a proposal for a symbol outside the universe is rejected by the module.
- Changing the contract file does not alter existing runs (versions are immutable once used).

push when finished

**area**: spacetimedb/src/ config/ README.md

**status**: open

**created_by**: quant-swarm-84

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058582210329}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## plan-status-refresh — P2: refresh implementation phase status and separate historical findings

**details**: Evidence: IMPLEMENTATION_REVIEW original table still says no executor/dashboard/SEC ingestion and mandatory approval, while fixes/handoff and current source show these exist; IMPLEMENTATION_PLAN data table calls market_observation public despite private schema. Update a dated current phase/acceptance matrix with code implemented versus locally verified versus broker/provider/browser exit checks pending; preserve original findings clearly as history. Link active task IDs, distinguish no-human-approval policy and deferred graphical-game/VM track from active mc-* pilot, and include supervisor/CI/backup work without claiming unrun live acceptance.

push when finished

**area**: IMPLEMENTATION_PLAN.md IMPLEMENTATION_REVIEW.md README.md

**status**: claimed

**created_by**: codex-plan

**assignee**: codex-plan

**depends_on**: backlog-audit-oct03

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060176587338}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060944959518}

## position-monitor — Phase 5: position monitor that reviews held positions and proposes hold/reduce/exit

**details**: PRIORITY: medium (Phase 5).

DEPENDS ON: thesis-decision-structure (review dates/triggers/exit plans) in addition to the executor.

CONTEXT: Nothing links a held position to the thesis that opened it, and nothing proposes exits. AGENTS.md: the swarm must manage open positions; new filings, major price moves, fills and portfolio drift can trigger a review; exits go through the same risk path as entries.

SCOPE:
1. Module: a position_thesis link (run, symbol, opening proposal/thesis IDs, quantity, opened at) maintained from fills; private, visible through a scoped view.
2. src/position-monitor.ts (own identity, coordinator-type role): for each held position, create a review task when any trigger fires: reviewBy reached; a new filing source for the symbol; price move beyond a configured threshold since entry or last review; thesis invalidation condition flagged by the skeptic; position drift beyond policy.
3. Review flow reuses analyst/skeptic/coordinator with a 'review' objective that includes the original thesis, its exit plan and current evidence; the coordinator outputs hold, reduce (sell quantity) or exit (sell all). Reduce/exit become sell proposals that go through the normal risk worker and executor.
4. Deterministic task IDs per position and trigger occurrence, so restarts do not duplicate reviews.

ACCEPTANCE:
- With a held paper position, forcing reviewBy into the past creates one review task, and a resulting exit proposal is risk-checked and executed like an entry.
- A hold decision records the next review date; no proposal is created.
- Corporate actions or symbol changes trigger reconciliation and a review rather than silent adjustment (at minimum detected and flagged).

push when finished

**area**: src/position-monitor.ts spacetimedb/src/ src/agents/

**status**: open

**created_by**: quant-swarm-84

**depends_on**: paper-executor-reconcile

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058583065150}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## research-cycle-scheduler — Scheduler: run research cycles on the contract cadence (ingest, quote, create thesis tasks)

**details**: PRIORITY: medium-high (today an operator must hand-create every thesis task with spacetime call).

CONTEXT: Tasks are created manually. Nothing refreshes SEC evidence or quotes on a schedule, and nothing triggers a cycle when a new filing appears.

SCOPE:
1. New long-running process src/scheduler.ts with its own identity (role: coordinator or a new 'scheduler' role if the module adds one; discuss on the board) and run access.
2. On the run's cadence (from the pilot contract): for each symbol in the universe, run SEC ingestion (reuse sec-ingestor functions, not a subprocess), request a fresh market snapshot (via the existing Alpaca read path or a task for the market_data identity; it must not hold broker credentials itself), then create one thesis task per symbol with a deterministic ID (runId, symbol, cycle date) so restarts never duplicate a cycle.
3. New-filing trigger: if ingestion records a new filing source for a symbol with an open position or recent thesis, create an out-of-cycle review task.
4. Respect run status: no new tasks while paused; stop at closed.
5. Budget awareness: skip creating tasks if the run's inference budget is exhausted, and post a status message.
6. Same reconnect/backoff/token pattern as src/worker.ts.

OUT OF SCOPE: position-triggered reviews (position-monitor).

ACCEPTANCE:
- With a 2-minute test cadence, two cycles create exactly one thesis task per symbol per cycle; killing and restarting the scheduler mid-cycle creates no duplicates.
- Pausing the run stops task creation; resuming continues.
- npm run scheduler script added and documented.

push when finished

**area**: src/scheduler.ts package.json README.md

**status**: open

**created_by**: quant-swarm-84

**depends_on**: pilot-contract-config

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058582407220}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## risk-live-acceptance — Phase 3 exit: live risk worker against Alpaca paper data, rejection drills

**details**: PRIORITY: high once Alpaca paper keys exist.

NEEDS: Alpaca paper API key/secret and an entitled feed (owner). Market-hours dependent: run some cases while the market is open, or set requireMarketOpen=false in a dedicated test policy version (never edit paper-pilot-1 in place).

CONTEXT: risk-worker is done with --register verified but no live cycle (see its board result). The module evaluates snapshot/clock-pinned inputs authoritatively.

SCOPE: script scripts/check-risk-live.ts that, on a fresh run with the pilot policy, creates synthetic proposals through the coordinator role and verifies the risk worker's verdicts against live account/quote/clock data:
- pass: small in-universe buy within limits during market hours.
- reject: symbol outside allowedSymbols; order notional above maxOrderNotional; position notional over maxPositionNotional (using current positions); stale quote (older than maxQuoteAgeMs); stale account snapshot; market closed (when policy requires open); duplicate intent for the same symbol/side while one is reserved; limit price outside maxLimitDeviation; sell exceeding held quantity (long-only).
- expiry: a pass older than its TTL is refused by reserve_paper_order.
- changed inputs: a pass becomes invalid after a material account change.
Each case asserts the stored risk_decision outcome and its checks text.

OUT OF SCOPE: order submission (no executor in this check).

ACCEPTANCE: all cases pass in one run; results and timestamps recorded in HANDOFF.md; no orders reach Alpaca.

push when finished

**area**: src/risk-worker.ts scripts/check-risk-live.ts HANDOFF.md

**status**: open

**created_by**: quant-swarm-84

**depends_on**: alpaca-live-read

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058582808921}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## run-metrics-benchmark — Phase 6: run metrics, benchmark comparison and evaluation report

**details**: PRIORITY: medium.

CONTEXT: run_metric exists but nothing writes it. AGENTS.md lists required measurements: evidence coverage, decision quality including justified no-trade outcomes, risk compliance, order reconciliation, paper portfolio performance against a stated baseline, coordination overhead, and recovery behavior. Inference attempts already record tokens.

SCOPE:
1. src/metrics.ts (own identity, role allowed to record_run_metric): periodically compute and record per run: theses, decisions by outcome, no-trade rate, evidence count per thesis, share of theses citing a filing less than 120 days old, skeptic concern rate, risk pass/reject counts by failed check, orders by status, reconciliation discrepancies, task retries/lease expiries, mean task latency, inference count/tokens and estimated currency cost (price table in config, versioned).
2. Portfolio: daily equity from account snapshots versus the benchmark from the pilot contract (e.g., SPY close-to-close over the same dates), max drawdown.
3. scripts/report.ts renders a Markdown report for a run with those metrics, a list of decisions with rationale, and the caveat that paper fills are simulated.

ACCEPTANCE:
- On a fixture run, the report shows non-zero counts consistent with the database (spot-check three metrics by SQL).
- Metrics are idempotent per period (stable IDs), so restarts do not duplicate them.

push when finished

**area**: src/metrics.ts scripts/report.ts

**status**: open

**created_by**: quant-swarm-84

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058583314379}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## sec-amendment-freshness — P1 Phase 2: preserve amended filing metadata and enforce research freshness

**details**: Evidence: latestFilings explicitly selects original 10-K/10-Q and ignores amendments; fact period is a display string, amendment status is absent. Store structured filing/reporting/acceptance dates, units, amendment and supersession links; retain originals for audit and avoid silent replacement. Define deterministic filing completeness/age/quality checks under the pilot contract, distinct from the already implemented quote-age/risk checks. Acceptance with SEC fixtures: 10-K/A and 10-Q/A cause a new review; pre-amendment decision snapshots remain unchanged; missing/inconsistent/stale required evidence produces a recorded no-trade/research-quality result; future information cannot enter an earlier decision.

push when finished

**area**: src/sec-ingestor.ts src/agents/evidence.ts spacetimedb/src/schema.ts

**status**: open

**created_by**: codex-plan

**depends_on**: sec-filing-provenance

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060166475130}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## sec-filing-excerpts — SEC: extract bounded risk-factor and MD&A excerpts from saved filings for analysts

**details**: PRIORITY: high (Phase 2 exit needs qualitative evidence; today analysts see only ~10 numeric XBRL facts).

CONTEXT: src/sec-ingestor.ts saves the primary 10-K/10-Q HTML (content-addressed under ~/.local/share/quant-swarm/artifacts/sec/) and records a manifest as artifact_ref. No text is extracted. The plan (IMPLEMENTATION_PLAN.md section 3, Filing analyst) expects guidance, material changes and risks with citations.

SCOPE:
1. New module src/sec-excerpts.ts: convert saved filing HTML to plain text (strip tags/scripts/styles; decode entities; collapse whitespace). No new network calls; work from the saved document only.
2. Locate sections by item headings: 10-K Item 1A (Risk Factors) and Item 7 (MD&A); 10-Q Part I Item 2 (MD&A) and Part II Item 1A. Handle table-of-contents duplicates (use the last heading match that is followed by substantial text) and case/spacing variants.
3. For each section found, record a fact row per excerpt chunk: metric = 'excerpt.<section>' (e.g., excerpt.risk_factors), value = bounded text (max ~1500 chars per chunk, at most N chunks per section, first chunks of the section), unit = 'text', period = filing report date, quality = 'ok' or 'heuristic' if the heading match was ambiguous. Each excerpt fact links to the filing source; record character offsets in the manifest so it can be verified against the saved document.
4. Add excerpt fact IDs deterministically (recordId helper in src/ids.ts) so reruns are idempotent.
5. Analyst evidence: include excerpts subject to the prompt budget from analyst-evidence-selection.
6. Document in README SEC section.

OUT OF SCOPE: summarization by a model, 8-K ingestion, exhibits.

ACCEPTANCE:
- Unit tests on saved fixtures of a real AAPL 10-K and 10-Q (commit trimmed HTML fixtures, not full filings) locate both sections and produce stable excerpts.
- Live: ingest AAPL and MSFT into a new run; each filing source has risk-factor and MD&A excerpt facts; a script re-reads the saved document and confirms each excerpt matches the recorded offsets.
- Rerun records nothing new. If a section is not found, log it and record no excerpt (never fabricate).

push when finished

**area**: src/sec-ingestor.ts src/sec-excerpts.ts src/agents/model-handlers.ts

**status**: claimed

**created_by**: quant-swarm-84

**assignee**: cedar

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058581560250}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791063025326243}

## sec-shared-rate-gate — SEC: coordinate throttling across simultaneous ingestor processes

**details**: Complete the original sec-cache-retry cross-process request-limit requirement: one shared local gate across separate clients/processes, capped request-start rate, safe release/recovery, and two-process fixture acceptance. No live SEC/model calls. push when finished

**area**: src/sec-client.ts src/sec-client.test.ts docs/sec-cache.md

**status**: claimed

**created_by**: cedar

**assignee**: cedar

**depends_on**: sec-cache-retry

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791064473592559}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791064473709973}

## tart-macos-guest-check — VM: Tart macOS guest template and one-guest game/agent check on the Mac

**details**: PRIORITY: medium-high (decides whether local VMs are viable game client hosts; the plan says choose hosts from measured headroom).

CONTEXT: vm_fleet/tart_fleet.py manages Tart clone/start/stop/status/destroy, but Tart is not installed on this Mac, no template exists, and game rendering/input inside a guest is unverified. Host: M4 MacBook Air, 16 GB RAM.

NEEDS OWNER: approval to install Tart and download a macOS base image (tens of GB); game license usable in a guest.

SCOPE:
1. Install Tart; create qs-macos-template from a cirruslabs macOS base image; inside it install Node.js, Swift CLI tools, repo dependencies, the game; grant Screen Recording and Accessibility to the guest terminal; set a fixed display resolution. Document every step in vm_fleet/README.md. No API keys or personal credentials baked into the template.
2. Use tart_fleet.py (count 1): plan, up --wait-ip, status, stop. Fix any defects found in the fleet tool.
3. Inside the guest: run the same one-agent goal as game-one-agent-live-check; record frame rate, guest and host memory/CPU, screenshot latency, and model loop latency.
4. Recommend in the task result: how many guests this Mac can host (likely 1-2), and whether a dedicated host is needed for ten clients.

ACCEPTANCE: one guest runs the game and the agent completes the inventory goal inside the guest; measurements recorded in HANDOFF.md.

Reference: GAME_AGENT_IMPLEMENTATION_PLAN.md (phases, adapter contract, schema, recovery), src/game/README.md, vm_fleet/README.md. Ground rule for every game task: agents observe only their own screenshots and act only through validated mouse/keyboard input; no server APIs, world files, memory reads or admin commands ever reach an agent.

push when finished

**area**: vm_fleet/ HANDOFF.md

**status**: cancelled

**created_by**: quant-swarm-84

**depends_on**: game-one-agent-live-check

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058912464582}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## thesis-decision-structure — Schema: structured catalysts, horizon, review trigger, exit path and confidence on thesis/decision

**details**: PRIORITY: high (Phase 2 exit and Phase 5 position monitoring depend on it).

CONTEXT: thesis stores bullCase, bearCase, assumptions, invalidation and evidenceRefs as free text. decision stores outcome and rationale. AGENTS.md requires proposals with a thesis, valuation or catalyst, counterarguments, confidence and exit conditions, and every thesis must have a review date or trigger, invalidation conditions and a proposed exit path. None of these are structured, so a position monitor cannot act on them.

SCOPE:
1. Add columns with defaults (additive migration only) to thesis: catalysts (text), holdingHorizonDays (u32), reviewBy (timestamp; required for new theses), reviewTriggers (comma list from a fixed enum: new_filing, price_move, earnings, invalidation, drift), exitPlan (text), confidence (u8 0-100). Decision: add confidence and nextReviewBy.
2. publishThesis validation: reviewBy must be in the future and within the run's maximum horizon; confidence 0-100; triggers from the enum; text fields bounded.
3. Update model output schemas (zod) and prompts in src/agents/roles.ts; update validators so model output missing these fields is rejected before any reducer call. Update the rules placeholder to fill sensible values (e.g., reviewBy = now + 30 days).
4. Regenerate bindings; update fixtures used by scripts/check-research-fixture.ts and scripts/check-phase-one.ts.

OUT OF SCOPE: the position monitor itself (position-monitor).

ACCEPTANCE:
- Publishing to the existing local database migrates without data loss (spacetime publish shows only added columns).
- Reducer rejects: past reviewBy, confidence 101, unknown trigger.
- npm test, typecheck, check:research-fixture and check:phase-one pass.
- Coordinate the module change on the board first; spacetimedb/src/ is a shared area.

push when finished

**area**: spacetimedb/src/ src/module_bindings/ src/agents/roles.ts src/agents/model-handlers.ts

**status**: claimed

**created_by**: quant-swarm-84

**assignee**: codex-monitor

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058581987810}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## three-swarm-readiness — Full acceptance: runnable Alpaca, Minecraft and Factorio test commands with prerequisite gates

**details**: Owner explicitly requests implementation until all three run. Provide preflight/build/publish/register/grant/launch/check/stop commands, deterministic offline adapters and true runtime checks separately. Full live tests require configured paper keys/feed, SEC contact, Minecraft EULA/runtime and Factorio runtime. Record exact versions/results; never report mock success as live gameplay/trading. Coordinate all track dependencies and push finished changes.

push when finished

**area**: games/ scripts/ docs/

**status**: claimed

**created_by**: codex-plan

**assignee**: codex-plan

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791060470710303}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060472072759}

## valuation-inputs — Deterministic valuation inputs: TTM, YoY growth, margins, P/E from SEC history and quotes

**details**: PRIORITY: medium-high (the coordinator sizes trades but nothing computes valuation; plan section 3 Valuation analyst).

CONTEXT: The SEC ingestor records only the latest 10-K and 10-Q values for their own periods. There is no trailing-twelve-month (TTM) data, no year-over-year comparison, and no price-based multiple. Models currently infer valuation from raw numbers, which is error-prone and unauditable.

SCOPE:
1. Extend SEC ingestion to retain the quarterly/annual history needed for TTM and YoY: from the company-facts data already fetched, record per-period facts for revenue, net income, operating income and diluted EPS for the last 8 quarters (deriving Q4 = FY - Q1..Q3 where only annual is reported; mark derived values quality = 'derived'). Each fact must link to the filing source whose accession reported it; add sources for those earlier filings as needed (same manifest/provenance rules as today).
2. New pure module src/valuation.ts computing: TTM revenue, TTM net income, TTM diluted EPS, YoY revenue growth (latest quarter vs same quarter prior year), operating and net margin (TTM), P/E = latest quote midpoint / TTM EPS (null if EPS <= 0), net cash = cash - long-term debt. Every output carries its input fact IDs and quote ID.
3. Record outputs as facts with quality = 'computed', metric = 'valuation.<name>', and the input IDs in period or a manifest, so a thesis can cite them.
4. Feed computed metrics to the analyst and coordinator prompts.

OUT OF SCOPE: DCF models, peer comparison, analyst estimates.

ACCEPTANCE:
- Unit tests with fixed inputs for each formula, including negative EPS, missing quarters and a fiscal year not aligned to the calendar (AAPL ends late September).
- Live: for AAPL, TTM revenue equals the sum of the last four reported quarters from EDGAR (cross-check manually and paste the comparison in the task result).
- Every computed fact can be traced to its inputs via IDs.

push when finished

**area**: src/sec-ingestor.ts src/valuation.ts src/agents/model-handlers.ts

**status**: open

**created_by**: quant-swarm-84

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058581726831}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}

## vm-libvirt-live-check — VM: exercise the remote libvirt fleet on a real Linux host

**details**: PRIORITY: low-medium (only if a remote Linux host is part of the host plan from game-scenario-decisions).

NEEDS OWNER: a Linux host with KVM/libvirt and an SSH account per vm_fleet/README.md requirements.

CONTEXT: vm_fleet/fleet.py has only been exercised with 'plan' (read-only). Clone/start/stop/status/destroy, guest-agent IP discovery and the state/identity safeguards have never run against libvirt.

SCOPE:
1. Prepare one desktop template per the README (guest agent channel, fixed resolution, SPICE console).
2. Run plan, up --wait-ip, status, stop, destroy with count 1, then 2. Exercise safeguards: replace a clone outside the tool and confirm start/stop/destroy refuse to act.
3. Measure guest graphics performance with the chosen game (software rendering likely; record FPS). Record whether GPU passthrough would be needed.
4. Fix defects found; keep the SSH BatchMode and no-interactive-sudo constraints.

ACCEPTANCE: full lifecycle succeeds on a real host; safeguard refusals verified; measurements in HANDOFF.md.

push when finished

**area**: vm_fleet/fleet.py vm_fleet/README.md HANDOFF.md

**status**: cancelled

**created_by**: quant-swarm-84

**result**: Superseded by owner direction 2026-10-03: Minecraft with 10 Mineflayer agents, privileged state, no orchestrator, SpacetimeDB information sharing. See GAME_AGENT_IMPLEMENTATION_PLAN.md and the mc-* tasks. Real-client vision work is deferred.

**created_at**: {"__timestamp_micros_since_unix_epoch__": 1791058912579476}

**updated_at**: {"__timestamp_micros_since_unix_epoch__": 1791060394133825}
